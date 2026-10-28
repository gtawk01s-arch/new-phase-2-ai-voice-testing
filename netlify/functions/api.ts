import { CONFIG, CHAOS_STATE, getCampaign, getLanguage } from '../../src/config.js';
import {
  getOrCreateSession,
  getSession,
  deleteSession,
  getAllSessions,
  getGlobalLatencyMetrics,
  getAuditCalls,
  flagTurn,
  correctTranscript,
  exportFineTuningDataset
} from '../../src/session.js';
import { processTurn } from '../../src/engine.js';
import { synthesizeSpeech } from '../../src/tts.js';
import { getProviderCounters } from '../../src/llm.js';
import { transcribeAudio } from '../../src/asr.js';

// Response helper
function jsonResponse(data: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-call-id, x-shared-secret, x-idempotency-key',
      ...headers
    }
  });
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-call-id, x-shared-secret, x-idempotency-key'
      }
    });
  }

  const url = new URL(req.url);
  let pathname = url.pathname;

  // Normalize Netlify function path prefix if needed
  if (pathname.startsWith('/.netlify/functions/api')) {
    pathname = pathname.replace('/.netlify/functions/api', '/api');
  }

  try {
    // 1. Healthcheck checking ASR, TTS, LLM (Phase 2 Task 8)
    if (pathname === '/api/health' || pathname === '/health') {
      const latency = getGlobalLatencyMetrics();
      const providers = getProviderCounters();
      return jsonResponse({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
        platform: 'netlify-functions',
        mode: 'tested with recordings',
        subsystems: {
          asr: {
            status: CHAOS_STATE.simulateAsrFail ? 'simulated_failure' : (CONFIG.GROQ_API_KEY ? 'ready' : 'unconfigured'),
            primary: 'groq/whisper-large-v3-turbo'
          },
          llm: {
            status: CHAOS_STATE.simulateLlmFail ? 'simulated_failure' : (CONFIG.GROQ_API_KEY ? 'ready' : 'degraded'),
            active_models: CONFIG.GROQ_MODELS,
            metrics: providers
          },
          tts: {
            status: CHAOS_STATE.simulateTtsFail ? 'simulated_failure' : 'ready',
            fallback_cached: true
          }
        },
        chaos_mode: CHAOS_STATE,
        latency: {
          target_ms: CONFIG.TIMEOUTS.TOTAL_BUDGET,
          p50_ms: latency.p50,
          p95_ms: latency.p95,
          samples: latency.sample_count
        },
        active_sessions: getAllSessions().filter((s: any) => s.status === 'connected').length
      });
    }

    // 2. Admin Chaos Injection (kill providers on purpose to show fallbacks)
    if (pathname === '/api/admin/chaos') {
      if (req.method === 'GET') {
        return jsonResponse({ status: 'ok', chaos: CHAOS_STATE });
      }
      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        if (typeof body.simulateAsrFail === 'boolean') CHAOS_STATE.simulateAsrFail = body.simulateAsrFail;
        if (typeof body.simulateLlmFail === 'boolean') CHAOS_STATE.simulateLlmFail = body.simulateLlmFail;
        if (typeof body.simulateTtsFail === 'boolean') CHAOS_STATE.simulateTtsFail = body.simulateTtsFail;
        if (['none', 'groq', 'gemini', 'all_down'].includes(body.forceProvider)) {
          CHAOS_STATE.forceProvider = body.forceProvider;
        }
        return jsonResponse({ status: 'updated', chaos: CHAOS_STATE });
      }
    }

    // 3. QA Analyst Routes
    if (pathname === '/api/qa/calls') {
      return jsonResponse({ status: 'success', calls: getAuditCalls() });
    }

    if (pathname === '/api/qa/flag' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      flagTurn(body.call_id, body.turn_id, body.reason);
      return jsonResponse({ status: 'flagged', call_id: body.call_id, turn_id: body.turn_id });
    }

    if (pathname === '/api/qa/correct' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      correctTranscript(body.call_id, body.turn_id, body.corrected_text);
      return jsonResponse({ status: 'corrected', call_id: body.call_id, turn_id: body.turn_id });
    }

    if (pathname === '/api/qa/export-finetuning') {
      const dataset = exportFineTuningDataset();
      const jsonl = dataset.map((d: any) => JSON.stringify(d)).join('\n');
      return new Response(jsonl, {
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Content-Disposition': 'attachment; filename="voice_finetuning_dataset.jsonl"'
        }
      });
    }

    // 4. Languages & Campaigns
    if (pathname === '/api/dialer/languages') {
      return jsonResponse({ status: 'success', languages: Object.values(CONFIG.LANGUAGES) });
    }

    if (pathname === '/api/dialer/campaigns') {
      return jsonResponse({ status: 'success', campaigns: Object.values(CONFIG.CAMPAIGNS) });
    }

    // 5. Dialer Extensions
    if (pathname === '/api/dialer/extensions') {
      return jsonResponse({
        status: 'success',
        count: CONFIG.EXTENSIONS.length,
        extensions: CONFIG.EXTENSIONS
      });
    }

    // 6. Dialer Call History
    if (pathname === '/api/dialer/calls') {
      return jsonResponse({
        status: 'success',
        calls: getAuditCalls()
      });
    }

    // 7. Start Call
    if (pathname === '/api/dialer/call/start') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const direction = body.direction === 'outbound' ? 'outbound' : 'inbound';
      const callerId = body.caller_id || body.From || 'Anonymous';
      const customerName = body.customer_name || '';
      const campaignId = body.campaign || (direction === 'outbound' ? 'sales' : 'support');
      const campaign = getCampaign(campaignId);
      const language = body.language || campaign.language || 'en';
      const chosenVoice = body.voice || campaign.voice || CONFIG.AUDIO.DEFAULT_VOICE;

      const session = getOrCreateSession(callId, {
        direction,
        callerId,
        campaignId,
        language,
        customerName
      });

      const greeting = body.custom_greeting || campaign.greeting;
      session.recordTurn('assistant', greeting, { intent: 'greeting', action: 'speak_and_listen' });

      const ttsRes = await synthesizeSpeech(greeting, {
        isStatic: !body.custom_greeting,
        voice: chosenVoice,
        callId
      });

      return jsonResponse({
        status: 'success',
        call_id: callId,
        direction,
        call_status: 'connected',
        greeting,
        language,
        audio_url: ttsRes.audio_url,
        available_extensions: CONFIG.EXTENSIONS,
        session: {
          callId,
          direction,
          status: session.status,
          campaign: campaign.name,
          language: session.language
        }
      });
    }

    // 8. Interact / Turn
    if (pathname === '/api/dialer/call/interact') {
      const contentType = req.headers.get('content-type') || '';
      let callId = 'demo-call';
      let userText = '';

      if (contentType.includes('application/json')) {
        const body = await req.json().catch(() => ({}));
        callId = body.call_id || 'demo-call';
        userText = (body.text || '').trim();
      } else if (contentType.includes('multipart/form-data')) {
        const formData = await req.formData();
        callId = (formData.get('call_id') as string) || 'demo-call';
        userText = ((formData.get('text') as string) || '').trim();

        const audioFile = formData.get('audio') as File | null;
        if (audioFile && !userText) {
          const buffer = Buffer.from(await audioFile.arrayBuffer());
          const asr = await transcribeAudio(buffer, { callId });
          userText = asr.text;
        }
      }

      const session = getOrCreateSession(callId);
      const campaign = getCampaign(session.campaignId);
      const chosenVoice = campaign.voice || CONFIG.AUDIO.DEFAULT_VOICE;

      const engineResult = await processTurn(session, userText);
      const ttsResult = await synthesizeSpeech(engineResult.reply, {
        voice: chosenVoice,
        callId
      });

      return jsonResponse({
        call_id: callId,
        action: engineResult.action === 'transfer' ? 'transfer' : (engineResult.action === 'hangup' ? 'hangup' : 'continue'),
        call_status: session.status,
        transcription: userText,
        response: engineResult.reply,
        audio_url: ttsResult.audio_url,
        disposition: engineResult.disposition,
        language: session.language,
        transfer: engineResult.transfer ? {
          extension: engineResult.transfer.id,
          name: engineResult.transfer.name,
          department: engineResult.transfer.dept,
          sip_uri: engineResult.transfer.sip,
          phone_number: engineResult.transfer.phone,
          warm_transfer_notes: engineResult.reply
        } : null,
        session: {
          turns: session.turns,
          status: session.status,
          disposition: session.disposition,
          language: session.language
        }
      });
    }

    // 9. Transfer Call
    if (pathname === '/api/dialer/call/transfer') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id || 'demo-call';
      const extId = body.extension_id;
      const session = getOrCreateSession(callId);

      const ext = CONFIG.EXTENSIONS.find((e: any) => e.id === extId) || CONFIG.EXTENSIONS[0];
      session.status = 'transferred';
      session.disposition = 'manual_transfer';
      (session as any).transferredTo = ext;

      const transferMessage = session.language.startsWith('hi')
        ? `अवश्य! मैं आपकी कॉल सीधे ${ext.name} को एक्सटेंशन ${ext.id} पर ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।`
        : `Certainly! I am transferring your call directly to ${ext.name} on extension ${ext.id}. Please stay on the line.`;

      session.recordTurn('assistant', transferMessage, { action: 'transfer', intent: 'manual_transfer' });

      const ttsRes = await synthesizeSpeech(transferMessage, {
        isStatic: true,
        callId
      });

      return jsonResponse({
        status: 'transferred',
        call_id: callId,
        transfer_message: transferMessage,
        audio_url: ttsRes.audio_url,
        transfer: {
          extension: ext.id,
          name: ext.name,
          department: ext.dept,
          sip_uri: ext.sip,
          phone_number: ext.phone
        }
      });
    }

    // 10. End Call
    if (pathname === '/api/dialer/call/end') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id;
      const session = getSession(callId);
      if (session) {
        session.end(body.disposition || 'caller_ended');
      }
      return jsonResponse({ status: 'ended', call_id: callId });
    }

    // 11. Reset Call
    if (pathname.startsWith('/api/reset/')) {
      const callId = pathname.replace('/api/reset/', '');
      deleteSession(callId);
      return jsonResponse({ status: 'reset', call_id: callId });
    }

    // 12. Webhooks
    if (pathname === '/api/webhook/call') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const direction = body.direction === 'outbound' ? 'outbound' : 'inbound';
      const campaignId = body.campaign_id || 'support';

      const session = getOrCreateSession(callId, { direction, campaignId });
      const campaign = getCampaign(campaignId);
      const greeting = campaign.greeting;
      session.recordTurn('assistant', greeting);

      const ttsRes = await synthesizeSpeech(greeting, { isStatic: true, callId });

      return jsonResponse({
        call_id: callId,
        event: 'call_answered',
        action: 'speak_and_listen',
        intent: 'greeting',
        reply: greeting,
        audio_url: ttsRes.audio_url,
        disposition: 'in_progress',
        confidence: 1.0,
        session: { direction, campaign: campaign.name, status: session.status, language: session.language }
      });
    }

    if (pathname === '/api/webhook/turn') {
      const body = await req.json().catch(() => ({}));
      const callId = body.call_id || 'demo-call';
      const session = getOrCreateSession(callId);
      const userText = (body.text || '').trim();

      const engineResult = await processTurn(session, userText);
      const ttsRes = await synthesizeSpeech(engineResult.reply, { callId });

      return jsonResponse({
        call_id: callId,
        action: engineResult.action,
        intent: engineResult.intent,
        transcription: userText,
        reply: engineResult.reply,
        audio_url: ttsRes.audio_url,
        disposition: engineResult.disposition,
        confidence: engineResult.confidence,
        transfer: engineResult.transfer ? {
          extension: engineResult.transfer.id,
          name: engineResult.transfer.name,
          department: engineResult.transfer.dept,
          sip_uri: engineResult.transfer.sip,
          phone_number: engineResult.transfer.phone
        } : null,
        session: { turns: session.turns, status: session.status, disposition: session.disposition, language: session.language }
      });
    }

    if (pathname === '/api/webhook/barge-in') {
      const body = await req.json().catch(() => ({}));
      return jsonResponse({ status: 'acknowledged', call_id: body.call_id });
    }

    if (pathname === '/api/webhook/hangup') {
      const body = await req.json().catch(() => ({}));
      const session = getSession(body.call_id);
      if (session) {
        session.end(body.reason || 'caller_hangup');
        return jsonResponse({ status: 'closed', call_id: body.call_id, summary: session.getMetrics() });
      }
      return jsonResponse({ status: 'closed', call_id: body.call_id });
    }

    return jsonResponse({ error: 'Endpoint not found', path: pathname }, 404);
  } catch (err: any) {
    console.error('[Netlify Function Error]:', err);
    return jsonResponse({ error: err.message || 'Internal server error' }, 500);
  }
}

export const config = {
  path: ['/api/*', '/.netlify/functions/api/*']
};
