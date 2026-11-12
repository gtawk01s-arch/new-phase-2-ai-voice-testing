import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import os from 'os';
import { createServer as createViteServer } from 'vite';

import { CONFIG, CHAOS_STATE, isChaosAllowed, getCampaign } from './src/config.js';
import webhookRouter from './src/webhook.js';
import { pregenerateStaticLines, synthesizeSpeech, waitForAudioFile, getTtsCounters, cleanExpiredAudioCache } from './src/tts.js';
import {
  getGlobalLatencyMetrics,
  getAllSessions,
  getOrCreateSession,
  getSession,
  deleteSession,
  getAuditCalls,
  flagTurn,
  correctTranscript,
  exportFineTuningDataset,
  scrubIndianPii,
  getStageLatencyBugs,
  triggerWeeklyRetrainingJob,
  getRetrainingRuns
} from './src/session.js';
import { getProviderCounters, resetProviderCooldowns } from './src/llm.js';
import { transcribeAudio, getAsrCounters } from './src/asr.js';
import { processTurn } from './src/engine.js';
import { createAudioSocketServer } from './src/asterisk_audiosocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Structured JSON Logger Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const callId = req.body?.call_id || req.headers['x-call-id'] || 'system';
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api') && req.path !== '/api/health') {
      console.log(
        JSON.stringify({
          level: 'info',
          timestamp: new Date().toISOString(),
          call_id: callId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: duration
        })
      );
    }
  });
  next();
});

// 1. Healthcheck endpoint checking ASR, TTS, LLM, and Session Store
const getHealthPayload = async () => {
  const latency = getGlobalLatencyMetrics();
  const llmMetrics = getProviderCounters();
  const asrMetrics = getAsrCounters();
  const ttsMetrics = getTtsCounters();
  const chaosActive = isChaosAllowed();

  const asrStatus = {
    status: (chaosActive && CHAOS_STATE.simulateAsrFail)
      ? 'simulated_failure'
      : ((CONFIG.GROQ_API_KEY || CONFIG.GEMINI_API_KEY) ? 'ready' : 'unconfigured'),
    vad_and_8k_resampler: 'active',
    providers: ['groq/whisper-large-v3-turbo', 'gemini/gemini-3-flash-preview', 'gemini/gemini-3.5-transcribe'],
    metrics: asrMetrics
  };

  const llmStatus = {
    status: (chaosActive && (CHAOS_STATE.simulateLlmFail || CHAOS_STATE.forceProvider === 'all_down'))
      ? 'simulated_outage'
      : ((CONFIG.GEMINI_API_KEY || CONFIG.GROQ_API_KEY || CONFIG.OPENROUTER_API_KEY) ? 'ready' : 'degraded'),
    gemini_configured: Boolean(CONFIG.GEMINI_API_KEY),
    groq_configured: Boolean(CONFIG.GROQ_API_KEY),
    openrouter_configured: Boolean(CONFIG.OPENROUTER_API_KEY),
    cooldown_seconds: CONFIG.PROVIDER_COOLDOWN_MS / 1000,
    metrics: llmMetrics
  };

  const fallbackFiles = fs.existsSync(CONFIG.AUDIO.FALLBACK_DIR)
    ? fs.readdirSync(CONFIG.AUDIO.FALLBACK_DIR).filter(f => f.endsWith('.wav'))
    : [];
  const ttsStatus = {
    status: (chaosActive && CHAOS_STATE.simulateTtsFail)
      ? 'simulated_failure'
      : (fallbackFiles.length > 0 ? 'ready' : 'degraded'),
    cache_dir: CONFIG.AUDIO.CACHE_DIR,
    prerecorded_fallback_files: fallbackFiles,
    providers: [
      CONFIG.GOOGLE_CLOUD_TTS_KEY ? 'google-cloud-tts (active)' : 'google-cloud-tts (unconfigured)',
      CONFIG.BHASHINI_API_KEY ? 'bhashini-tts (active)' : 'bhashini-tts (unconfigured)',
      CONFIG.GEMINI_API_KEY ? 'gemini-3.8-flash-lite-tts (active)' : 'gemini-3.8-flash-lite-tts (unconfigured)'
    ],
    metrics: ttsMetrics
  };

  const activeSessionsCount = getAllSessions().filter((s: any) => s.status === 'active' || s.status === 'connected').length;

  return {
    status: (asrStatus.status === 'ready' && llmStatus.status === 'ready' && ttsStatus.status === 'ready') ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    port: CONFIG.PORT,
    audiosocket_port: CONFIG.AUDIOSOCKET_PORT,
    version: '2.1.0',
    webhook_auth_enforced: CONFIG.SECURITY.ENFORCE_AUTH,
    subsystems: {
      asr: asrStatus,
      llm: llmStatus,
      tts: ttsStatus,
      sessions: {
        active: activeSessionsCount,
        capacity: CONFIG.SESSION_TTL.MAX_CAPACITY
      }
    },
    chaos_enabled: chaosActive,
    chaos_mode: chaosActive ? CHAOS_STATE : undefined,
    latency: {
      target_ms: CONFIG.TIMEOUTS.TOTAL_BUDGET,
      p50_ms: latency.p50,
      p95_ms: latency.p95,
      samples: latency.sample_count
    },
    active_sessions: activeSessionsCount
  };
};

app.get('/health', async (_req: Request, res: Response) => {
  const payload = await getHealthPayload();
  res.json(payload);
});

app.get('/api/health', async (_req: Request, res: Response) => {
  const payload = await getHealthPayload();
  res.json(payload);
});

// 2. Admin Chaos Injection Routes (gated behind isChaosAllowed())
app.get('/api/admin/chaos', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    chaos_allowed: isChaosAllowed(),
    chaos: CHAOS_STATE
  });
});

app.post('/api/admin/chaos', (req: Request, res: Response) => {
  if (!isChaosAllowed()) {
    return res.status(403).json({
      error: 'Chaos injection is disabled in production. Set ALLOW_CHAOS_TESTING=true to enable.'
    });
  }
  if (typeof req.body.simulateAsrFail === 'boolean') CHAOS_STATE.simulateAsrFail = req.body.simulateAsrFail;
  if (typeof req.body.simulateLlmFail === 'boolean') CHAOS_STATE.simulateLlmFail = req.body.simulateLlmFail;
  if (typeof req.body.simulateTtsFail === 'boolean') CHAOS_STATE.simulateTtsFail = req.body.simulateTtsFail;
  if (['none', 'groq', 'gemini', 'openrouter', 'all_down'].includes(req.body.forceProvider)) {
    CHAOS_STATE.forceProvider = req.body.forceProvider;
  }
  if (!CHAOS_STATE.simulateLlmFail && CHAOS_STATE.forceProvider === 'none') {
    resetProviderCooldowns();
  }
  console.log('[Chaos] Updated state:', CHAOS_STATE);
  res.json({ status: 'updated', chaos: CHAOS_STATE });
});

app.post('/api/admin/cache/sweep', (_req: Request, res: Response) => {
  const evicted = cleanExpiredAudioCache();
  res.json({ status: 'ok', evicted_files: evicted });
});

// 3. QA Analyst Routes (Inspect, Flag, Correct, Fine-Tune Export)
app.get('/api/qa/calls', (_req: Request, res: Response) => {
  const auditCalls = getAuditCalls();
  res.json({
    status: 'success',
    count: auditCalls.length,
    calls: auditCalls
  });
});

app.post('/api/qa/flag', (req: Request, res: Response) => {
  const { call_id, turn_id, reason } = req.body;
  if (!call_id || !turn_id) {
    return res.status(400).json({ error: 'call_id and turn_id are required' });
  }
  flagTurn(call_id, turn_id, reason);
  res.json({ status: 'flagged', call_id, turn_id });
});

app.post('/api/qa/correct', (req: Request, res: Response) => {
  const { call_id, turn_id, corrected_text } = req.body;
  if (!call_id || !turn_id || typeof corrected_text !== 'string') {
    return res.status(400).json({ error: 'call_id, turn_id and corrected_text are required' });
  }
  correctTranscript(call_id, turn_id, corrected_text);
  res.json({ status: 'corrected', call_id, turn_id, corrected_text });
});

app.get('/api/qa/export-finetuning', (_req: Request, res: Response) => {
  const dataset = exportFineTuningDataset();
  const jsonl = dataset.map((d: any) => JSON.stringify(d)).join('\n');
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Disposition', 'attachment; filename="voice_finetuning_dataset.jsonl"');
  res.send(jsonl);
});

// 3B. Sovereign GPU Architecture, MLOps & Governance Routes (15-Point Plan)
app.get('/api/sovereign/overview', (_req: Request, res: Response) => {
  const sunsetDate = new Date(CONFIG.SOVEREIGN_GPU.EXTERNAL_API_SUNSET_DATE + 'T23:59:59Z');
  const daysRemaining = Math.max(0, Math.ceil((sunsetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
  res.json({
    status: 'ok',
    sovereign_gpu: {
      ...CONFIG.SOVEREIGN_GPU,
      disable_external_apis: CONFIG.SOVEREIGN_GPU.DISABLE_EXTERNAL_APIS,
      days_until_external_api_sunset: daysRemaining
    },
    stage_budgets_ms: CONFIG.STAGE_BUDGETS_MS,
    stage_latency_bugs: getStageLatencyBugs(),
    license_ledger: CONFIG.LICENSE_LEDGER,
    voice_catalog: CONFIG.VOICE_CATALOG,
    tenant_clients: Object.values(CONFIG.TENANT_CLIENTS),
    data_governance: CONFIG.DATA_GOVERNANCE,
    rollout_gates: CONFIG.ROLLOUT_GATES,
    cost_comparison: CONFIG.COST_COMPARISON,
    retraining_runs: getRetrainingRuns()
  });
});

app.post('/api/sovereign/toggle-external-apis', (req: Request, res: Response) => {
  const disable = Boolean(req.body.disable_external_apis);
  process.env.DISABLE_EXTERNAL_APIS = disable ? 'true' : 'false';
  res.json({
    status: 'updated',
    disable_external_apis: CONFIG.SOVEREIGN_GPU.DISABLE_EXTERNAL_APIS,
    mode: disable
      ? 'SOVEREIGN_GPU_ONLY (7B vLLM -> 3B In-House Backup -> Pre-Recorded WAV -> Human Transfer)'
      : 'HYBRID_BRIDGE_UNTIL_2026_12_31'
  });
});

app.post('/api/sovereign/scrub-pii', (req: Request, res: Response) => {
  const rawText = req.body.text || '';
  const result = scrubIndianPii(rawText);
  res.json({
    status: 'ok',
    original: rawText,
    ...result
  });
});

app.post('/api/sovereign/retrain', (req: Request, res: Response) => {
  const language = req.body.language || 'hi';
  const run = triggerWeeklyRetrainingJob(language);
  res.json({
    status: 'completed',
    run,
    all_runs: getRetrainingRuns()
  });
});

// Helper for word-level Levenshtein distance (real WER calculation)
function computeWordErrorStats(refText: string, hypText: string) {
  const normalize = (s: string) =>
    String(s || '')
      .toLowerCase()
      .replace(/[.,?!;:"'()[\]{}|।॥\-–—]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const r = normalize(refText);
  const h = normalize(hypText);
  if (r.length === 0) return { distance: h.length, refWords: 0 };
  const dp: number[][] = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = 0; i <= r.length; i++) dp[i][0] = i;
  for (let j = 0; j <= h.length; j++) dp[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      if (r[i - 1] === h[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return { distance: dp[r.length][h.length], refWords: r.length };
}

app.post('/api/qa/run-audio-suite', async (_req: Request, res: Response) => {
  try {
    const manifestPath = path.join(CONFIG.AUDIO.RECORDINGS_DIR, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return res.status(404).json({ error: '8kHz recordings manifest not found in /tests/recordings/manifest.json' });
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const recordings = manifest.recordings || [];
    const items: any[] = [];
    const vadLatencies: number[] = [];
    const asrLatencies: number[] = [];
    const llmLatencies: number[] = [];
    const ttsLatencies: number[] = [];
    const totalLatencies: number[] = [];

    let enErrors = 0;
    let enRefWords = 0;
    let hiErrors = 0;
    let hiRefWords = 0;
    let passedCount = 0;

    for (let i = 0; i < recordings.length; i++) {
      const rec = recordings[i];
      const wavPath = path.join(CONFIG.AUDIO.RECORDINGS_DIR, rec.filename);
      if (!fs.existsSync(wavPath)) continue;

      const callId = `qa-8k-${rec.id}-${Date.now()}`;
      const session = getOrCreateSession(callId, {
        direction: 'inbound',
        callerId: rec.lang === 'hi' ? '+919876543210' : '+919811122233',
        campaignId: rec.campaign || (rec.lang === 'hi' ? 'support_hi' : 'support'),
        language: rec.lang
      });

      const audioBuffer = fs.readFileSync(wavPath);
      const asr = await transcribeAudio(audioBuffer, {
        callId,
        language: rec.lang,
        mimeType: 'audio/wav'
      });

      const tTurn = Date.now();
      const engineResult = await processTurn(session, asr.text || '');
      const ttsResult = await synthesizeSpeech(engineResult.reply, {
        language: rec.lang,
        callId
      });

      const vadMs = asr.vad_ms || 0;
      const asrMs = asr.latency_ms || 0;
      const llmMs = engineResult.timing_ms?.llm || 0;
      const ttsMs = ttsResult.latency_ms || 0;
      const totalMs = asrMs + (Date.now() - tTurn);

      vadLatencies.push(vadMs);
      asrLatencies.push(asrMs);
      llmLatencies.push(llmMs);
      ttsLatencies.push(ttsMs);
      totalLatencies.push(totalMs);

      session.recordLatency({ vad: vadMs, asr: asrMs, llm: llmMs, tts: ttsMs, total: totalMs });

      const wer = computeWordErrorStats(rec.referenceText, asr.text || '');
      if (rec.lang === 'hi') {
        hiErrors += wer.distance;
        hiRefWords += wer.refWords;
      } else {
        enErrors += wer.distance;
        enRefWords += wer.refWords;
      }

      let passed = Boolean(asr.text && engineResult.reply);
      if (rec.expectAction === 'transfer') {
        passed = engineResult.action === 'transfer' && (!rec.expectExt || engineResult.transfer?.id === rec.expectExt);
      } else if (rec.expectAction === 'hangup') {
        passed = engineResult.action === 'hangup';
      }
      if (passed) passedCount++;

      items.push({
        id: i + 1,
        category: `${rec.lang.toUpperCase()} 8kHz WAV (${rec.filename})`,
        referenceText: rec.referenceText,
        input: asr.text || '(empty transcript)',
        passed,
        reply: engineResult.reply || '(empty)',
        latency: totalMs,
        timings: { vad: vadMs, asr: asrMs, llm: llmMs, tts: ttsMs, total: totalMs },
        werPct: wer.refWords > 0 ? `${((wer.distance / wer.refWords) * 100).toFixed(1)}%` : '0.0%'
      });
    }

    const p50 = (arr: number[]) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length * 0.5)];
    };
    const p95 = (arr: number[]) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    };

    res.json({
      total: items.length,
      passed: passedCount,
      failed: items.length - passedCount,
      p50Latency: p50(totalLatencies),
      p95Latency: p95(totalLatencies),
      legMedians: {
        vad: p50(vadLatencies),
        asr: p50(asrLatencies),
        llm: p50(llmLatencies),
        tts: p50(ttsLatencies)
      },
      werEnglish: enRefWords > 0 ? `${((enErrors / enRefWords) * 100).toFixed(1)}% (${enErrors}/${enRefWords} words)` : 'N/A',
      werHindi: hiRefWords > 0 ? `${((hiErrors / hiRefWords) * 100).toFixed(1)}% (${hiErrors}/${hiRefWords} words)` : 'N/A',
      items
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to run 8kHz audio suite' });
  }
});

// 4. Telephony Webhook Contract Router
app.use('/api/webhook', webhookRouter);

// 5. PBX / Dialer Simulator Routes
app.get('/api/dialer/languages', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    languages: Object.values(CONFIG.LANGUAGES)
  });
});

app.get('/api/dialer/campaigns', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    campaigns: Object.values(CONFIG.CAMPAIGNS)
  });
});

app.get('/api/dialer/extensions', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    count: CONFIG.EXTENSIONS.length,
    extensions: CONFIG.EXTENSIONS
  });
});

app.get('/api/dialer/calls', (_req: Request, res: Response) => {
  const calls = getAuditCalls();
  res.json({
    status: 'success',
    count: calls.length,
    calls
  });
});

app.post('/api/dialer/call/start', async (req: Request, res: Response) => {
  const callId = req.body.call_id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const direction = req.body.direction === 'outbound' ? 'outbound' : 'inbound';
  const callerId = req.body.caller_id || req.body.From || 'Anonymous';
  const customerName = req.body.customer_name || '';
  const reqLang = req.body.language || (req.body.voice?.toLowerCase().includes('hi') ? 'hi' : '');
  const defaultCamp = reqLang === 'hi'
    ? 'support_hi'
    : reqLang === 'hi-Latn'
    ? 'support_hinglish'
    : direction === 'outbound'
    ? 'sales'
    : 'support';
  const campaignId = req.body.campaign || defaultCamp;
  const campaign = getCampaign(campaignId);
  const language = reqLang || campaign.language || 'en';
  const chosenVoice =
    language.startsWith('hi') && (!req.body.voice || req.body.voice.startsWith('en-'))
      ? campaign.voice || 'hi-IN-SwaraNeural'
      : req.body.voice || campaign.voice || CONFIG.AUDIO.DEFAULT_VOICE;

  const session = getOrCreateSession(callId, {
    direction,
    callerId,
    campaignId,
    language,
    customerName
  });
  session.language = language;
  session.campaignId = campaignId;

  const greeting = req.body.custom_greeting || campaign.greeting;
  const greetingTurn = session.recordTurn('assistant', greeting, { intent: 'greeting', action: 'speak_and_listen' });

  console.log(`[Dialer][${callId}] Synthesizing greeting: "${greeting}" (${language}) with voice: ${chosenVoice}`);
  const ttsRes = await synthesizeSpeech(greeting, {
    language,
    nonBlocking: false,
    voice: chosenVoice,
    callId
  });
  if (greetingTurn && ttsRes.audio_url) {
    greetingTurn.audioUrl = ttsRes.audio_url;
  }

  res.json({
    status: 'success',
    call_id: callId,
    direction,
    call_status: 'connected',
    greeting,
    audio_url: ttsRes.audio_url,
    tts_latency_ms: ttsRes.latency_ms,
    language,
    available_extensions: CONFIG.EXTENSIONS,
    session: {
      callId,
      direction,
      status: session.status,
      campaign: campaign.name,
      language: session.language
    }
  });
});

app.post('/api/dialer/call/interact', upload.single('audio'), async (req: Request, res: Response) => {
  const callId = req.body.call_id || 'demo-call';
  const session = getOrCreateSession(callId);
  const tempPath = req.file?.path;
  let userText = (req.body.text || '').trim();
  let asrLatency = 0;
  let vadLatency = 0;

  if (req.body.language) {
    session.language = req.body.language;
    if (req.body.language === 'hi' && (!session.campaignId || session.campaignId === 'support' || session.campaignId === 'support_hinglish')) {
      session.campaignId = 'support_hi';
    } else if (req.body.language === 'hi-Latn' && (!session.campaignId || session.campaignId === 'support' || session.campaignId === 'support_hi')) {
      session.campaignId = 'support_hinglish';
    } else if (req.body.language === 'en' && (session.campaignId === 'support_hi' || session.campaignId === 'support_hinglish')) {
      session.campaignId = 'support';
    }
  }

  try {
    if (tempPath && !userText) {
      const audioBuffer = fs.readFileSync(tempPath);
      const asr = await transcribeAudio(audioBuffer, {
        callId,
        language: session.language,
        mimeType: req.file?.mimetype
      });
      userText = (asr.text || '').trim();
      asrLatency = asr.latency_ms;
      vadLatency = asr.vad_ms || 0;

      if (!userText && !(isChaosAllowed() && CHAOS_STATE.simulateAsrFail)) {
        return res.json({
          call_id: callId,
          action: 'continue',
          call_status: session.status,
          transcription: '',
          response: '',
          no_speech: true,
          audio_url: null,
          language: session.language,
          timings: { vad: vadLatency, asr: asrLatency, llm: 0, tts: 0, total: asrLatency }
        });
      }
    }

    const t0 = Date.now();
    const engineResult = await processTurn(session, userText);
    const campaign = getCampaign(session.campaignId);
    const chosenVoice =
      session.language?.startsWith('hi') && (!req.body.voice || req.body.voice.startsWith('en-'))
        ? campaign.voice || 'hi-IN-SwaraNeural'
        : req.body.voice || campaign.voice || CONFIG.AUDIO.DEFAULT_VOICE;

    const tts0 = Date.now();
    const ttsResult = await synthesizeSpeech(engineResult.reply, {
      language: session.language,
      voice: chosenVoice,
      nonBlocking: false,
      callId
    });
    const ttsLatency = ttsResult.latency_ms ?? (Date.now() - tts0);

    if (session.history.length > 0 && ttsResult.audio_url) {
      const lastTurn = session.history[session.history.length - 1];
      if (lastTurn && lastTurn.role === 'assistant') {
        lastTurn.audioUrl = ttsResult.audio_url;
      }
    }

    const timings = {
      vad: vadLatency,
      asr: asrLatency,
      llm: engineResult.timing_ms?.llm || 0,
      tts: ttsLatency,
      total: asrLatency + (Date.now() - t0)
    };
    session.recordLatency(timings);

    res.json({
      call_id: callId,
      action: engineResult.action === 'transfer' ? 'transfer' : (engineResult.action === 'hangup' ? 'hangup' : 'continue'),
      call_status: session.status,
      transcription: userText,
      response: engineResult.reply,
      audio_url: ttsResult.audio_url,
      fallback_audio_used: Boolean(ttsResult.fallback_used),
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
      timings,
      session: {
        turns: session.turns,
        status: session.status,
        disposition: session.disposition,
        language: session.language
      }
    });
  } catch (err: any) {
    console.error(`[Dialer][${callId}] Error:`, err);
    res.status(500).json({ error: err.message || 'Failed to interact' });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
});

app.post('/api/dialer/call/transfer', async (req: Request, res: Response) => {
  const callId = req.body.call_id || 'demo-call';
  const extId = req.body.extension_id;
  const session = getOrCreateSession(callId);

  const ext = CONFIG.EXTENSIONS.find((e: any) => e.id === extId) || CONFIG.EXTENSIONS[0];
  session.status = 'transferred';
  session.disposition = 'manual_transfer';
  (session as any).transferredTo = ext;

  const transferMessage = session.language === 'hi'
    ? `अवश्य! मैं आपकी कॉल सीधे ${ext.name} को एक्सटेंशन ${ext.id} पर ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।`
    : (session.language === 'hi-Latn'
      ? `Sure! Main aapki call ${ext.name} ko extension ${ext.id} par transfer kar raha hoon. Please hold kijiye.`
      : `Certainly! I am transferring your call directly to ${ext.name} on extension ${ext.id}. Please stay on the line.`);

  const transferTurn = session.recordTurn('assistant', transferMessage, { action: 'transfer', intent: 'manual_transfer' });

  const ttsRes = await synthesizeSpeech(transferMessage, {
    language: session.language,
    callId
  });
  if (transferTurn && ttsRes.audio_url) {
    transferTurn.audioUrl = ttsRes.audio_url;
  }

  res.json({
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
});

app.post('/api/dialer/call/end', (req: Request, res: Response) => {
  const callId = req.body.call_id;
  const session = getSession(callId);
  if (session) {
    session.end(req.body.disposition || 'caller_ended');
  }
  res.json({ status: 'ended', call_id: callId });
});

app.post('/api/reset/:id', (req: Request, res: Response) => {
  const callId = req.params.id;
  deleteSession(callId);
  res.json({ status: 'reset', call_id: callId });
});

// Dedicated TTS synthesis endpoint
app.post('/api/tts', async (req: Request, res: Response) => {
  const { text, voice, language, callId } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  const result = await synthesizeSpeech(text, { voice, language, callId });
  if (result.fallback_used) {
    res.setHeader('X-Fallback-Cached', 'true');
  }
  const audioFilename = result.filename || (result.audio_url ? path.basename(result.audio_url) : 'fallback-transfer-en.wav');
  const safeFilename = path.basename(audioFilename);
  const resolvedPath = await waitForAudioFile(safeFilename, 2400);

  if (req.headers.accept?.includes('application/json')) {
    return res.json(result);
  }
  if (resolvedPath && fs.existsSync(resolvedPath)) {
    res.setHeader('Content-Type', 'audio/wav');
    return res.sendFile(resolvedPath);
  }
  return res.json(result);
});

// Dedicated ASR transcription endpoint (with VAD & 8kHz->16kHz upsampling)
app.post('/api/asr', upload.single('audio'), async (req: Request, res: Response) => {
  const tempPath = req.file?.path;
  if (!tempPath) {
    return res.status(400).json({ error: 'audio file is required' });
  }
  try {
    const audioBuffer = fs.readFileSync(tempPath);
    const result = await transcribeAudio(audioBuffer, {
      callId: req.body.call_id,
      language: req.body.language,
      mimeType: req.file?.mimetype
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'ASR transcription failed' });
  } finally {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
});

// 6. Serve generated / pre-recorded fallback audio files
app.get('/api/audio/:filename', async (req: Request, res: Response) => {
  const rawParam = req.params.filename;
  const filename = Array.isArray(rawParam) ? rawParam[0] : (rawParam || '');
  const safeFilename = path.basename(filename);
  const resolvedPath = await waitForAudioFile(safeFilename, 3000);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return res.status(404).send('Audio file not found');
  }
  let mimeType = 'audio/wav';
  try {
    const head = Buffer.alloc(4);
    const fd = fs.openSync(resolvedPath, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head.toString('ascii', 0, 4);
    if (magic === 'RIFF') mimeType = 'audio/wav';
    else if (magic === 'OggS') mimeType = 'audio/ogg';
    else if (magic !== 'RIFF') mimeType = 'audio/mpeg';
  } catch (_) {}
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(resolvedPath);
});

// 7. Start HTTP Server + Asterisk AudioSocket Server
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`AI Call Assistant & Telephony Engine running on http://${CONFIG.HOST}:${CONFIG.PORT}`);
    pregenerateStaticLines().catch((err: any) => console.warn('Fallback sync notice:', err.message));
  });

  try {
    const audioSocketServer = createAudioSocketServer(CONFIG.AUDIOSOCKET_PORT);
    audioSocketServer.listen(CONFIG.AUDIOSOCKET_PORT, CONFIG.HOST, () => {
      console.log(`Asterisk AudioSocket TCP Server listening on ${CONFIG.HOST}:${CONFIG.AUDIOSOCKET_PORT} (8kHz slin16)`);
    });
  } catch (err: any) {
    console.warn('AudioSocket port bind notice:', err.message);
  }
}

startServer().catch((err) => {
  console.error('Server startup error:', err);
  process.exit(1);
});
