import express from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import {
  getOrCreateSession,
  getSession,
  getIdempotentResponse,
  setIdempotentResponse
} from './session.js';
import { getCampaign, CONFIG } from './config.js';
import { transcribeAudio } from './asr.js';
import { processTurn } from './engine.js';
import { synthesizeSpeech } from './tts.js';

const router = express.Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Telephony Webhook Security Middleware
 * Enforces IP allowlist + Shared Secret or HMAC-SHA256 Signature by default.
 * No default fallback secret or test bypass header is permitted.
 */
function verifyWebhookSecurity(req, res, next) {
  if (!CONFIG.SECURITY.ENFORCE_AUTH) {
    return next();
  }

  const configuredSecret = CONFIG.SECURITY.SHARED_SECRET;
  if (!configuredSecret) {
    return res.status(503).json({
      error: 'Webhook authentication is enabled (ENFORCE_WEBHOOK_AUTH=true), but WEBHOOK_SECRET is not set in environment.'
    });
  }

  // 1. Check IP Allowlist
  const rawIp = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim();
  const normalizedIp = rawIp.replace(/^::ffff:/, '');
  const ipAllowed = CONFIG.SECURITY.ALLOWED_IPS.some(allowed => {
    const cleanAllowed = allowed.replace(/^::ffff:/, '');
    return cleanAllowed === normalizedIp || cleanAllowed === rawIp;
  });

  if (!ipAllowed) {
    return res.status(403).json({
      error: `Forbidden: Source IP (${rawIp}) is not in WEBHOOK_ALLOWED_IPS`
    });
  }

  // 2. Verify X-Shared-Secret or X-Webhook-Signature (HMAC-SHA256)
  const sharedSecret = req.headers['x-shared-secret'] || req.headers['x-webhook-secret'];
  const signature = req.headers['x-webhook-signature'];

  if (sharedSecret && typeof sharedSecret === 'string') {
    const a = Buffer.from(sharedSecret);
    const b = Buffer.from(configuredSecret);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  }

  if (signature && typeof signature === 'string') {
    const rawBody = JSON.stringify(req.body || {});
    const expected = crypto.createHmac('sha256', configuredSecret).update(rawBody).digest('hex');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  }

  return res.status(401).json({
    error: 'Unauthorized: Missing or invalid X-Shared-Secret or X-Webhook-Signature header'
  });
}

router.use(verifyWebhookSecurity);

/**
 * 1. Call Answered Webhook (Idempotent)
 * Triggered when PBX trunk or caller connects
 */
router.post('/call', async (req, res) => {
  const t0 = Date.now();
  const callId = req.body.call_id || `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const idempotencyKey = req.headers['x-idempotency-key'] || req.body.idempotency_key || `call-init-${callId}`;

  // Idempotency check for dialer retries
  const cached = getIdempotentResponse(idempotencyKey);
  if (cached) {
    res.setHeader('X-Idempotent-Replay', 'true');
    return res.json(cached);
  }

  const direction = req.body.direction === 'outbound' ? 'outbound' : 'inbound';
  const callerId = req.body.caller_id || req.body.From || 'Anonymous';
  const calledNumber = req.body.called_number || req.body.To || '';
  const campaignId = req.body.campaign_id || (direction === 'outbound' ? 'sales' : 'support');
  const language = req.body.language || getCampaign(campaignId).language || 'en';
  const outputAudioFormat = req.body.output_audio_format || 'wav';
  const nonBlockingTts = req.body.non_blocking_tts === true || req.body.non_blocking_tts === 'true';

  console.log(`[Webhook][${callId}] Call answered: direction=${direction}, caller=${callerId}, campaign=${campaignId}, lang=${language}`);

  const session = getOrCreateSession(callId, {
    direction,
    callerId,
    calledNumber,
    campaignId,
    language,
    outputAudioFormat
  });

  const campaign = getCampaign(campaignId);
  const greeting = req.body.custom_greeting || campaign.greeting;
  session.recordTurn('assistant', greeting, { intent: 'greeting', action: 'speak_and_listen' });

  // Synthesize or retrieve greeting audio
  const ttsRes = await synthesizeSpeech(greeting, {
    format: outputAudioFormat,
    voice: campaign.voice,
    language: session.language,
    nonBlocking: nonBlockingTts,
    callId
  });

  const timing = {
    vad: 0,
    asr: 0,
    llm: 0,
    tts: ttsRes.latency_ms,
    total: Date.now() - t0
  };
  session.recordLatency(timing);

  const responsePayload = {
    call_id: callId,
    event: 'call_answered',
    action: 'speak_and_listen',
    intent: 'greeting',
    reply: greeting,
    audio_url: ttsRes.audio_url,
    audio_format: ttsRes.format || outputAudioFormat,
    tts_provider: ttsRes.provider,
    disposition: 'in_progress',
    confidence: 1.0,
    transfer: null,
    timing_ms: timing,
    session: {
      direction,
      campaign: campaign.name,
      language: session.language,
      status: session.status
    }
  };

  setIdempotentResponse(idempotencyKey, responsePayload);
  return res.json(responsePayload);
});

/**
 * 2. Caller Turn Webhook (Idempotent)
 * Triggered per spoken phrase (8kHz/16kHz audio upload, base64 audio, or transcribed text)
 */
router.post('/turn', upload.single('audio'), async (req, res) => {
  const t0 = Date.now();
  const callId = req.body.call_id || 'demo-call';
  const session = getOrCreateSession(callId, { language: req.body.language || 'en' });
  if (req.body.language) {
    session.language = req.body.language;
  }
  const outputAudioFormat = req.body.output_audio_format || session.outputAudioFormat || 'wav';
  const nonBlockingTts = req.body.non_blocking_tts === true || req.body.non_blocking_tts === 'true';
  const tempPath = req.file?.path;

  let userText = (req.body.text || '').trim();
  let asrLatency = 0;
  let vadLatency = 0;
  let asrMeta = null;

  // Idempotency check for dialer retries
  const rawTurnKey = req.headers['x-idempotency-key'] || req.body.idempotency_key || (userText ? `turn-${callId}-${userText}` : null);
  if (rawTurnKey) {
    const cached = getIdempotentResponse(rawTurnKey);
    if (cached) {
      res.setHeader('X-Idempotent-Replay', 'true');
      if (tempPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }
      return res.json(cached);
    }
  }

  try {
    // 1. ASR + VAD + 8kHz->16kHz processing if audio was provided
    if (tempPath && !userText) {
      const audioBuffer = fs.readFileSync(tempPath);
      const asrResult = await transcribeAudio(audioBuffer, {
        callId,
        language: session.language,
        mimeType: req.file?.mimetype
      });
      userText = asrResult.text;
      asrLatency = asrResult.latency_ms;
      vadLatency = asrResult.vad_ms || 0;
      asrMeta = {
        provider: asrResult.provider,
        input_sample_rate: asrResult.input_sample_rate,
        resampled_8k_to_16k: asrResult.resampled_8k_to_16k,
        active_speech_ms: asrResult.active_speech_ms,
        rms_db: asrResult.rms_db,
        is_silence: asrResult.is_silence
      };
    } else if (req.body.audio_base64 && !userText) {
      const audioBuffer = Buffer.from(req.body.audio_base64, 'base64');
      const asrResult = await transcribeAudio(audioBuffer, {
        callId,
        language: session.language,
        mimeType: req.body.audio_format ? `audio/${req.body.audio_format}` : undefined
      });
      userText = asrResult.text;
      asrLatency = asrResult.latency_ms;
      vadLatency = asrResult.vad_ms || 0;
      asrMeta = {
        provider: asrResult.provider,
        input_sample_rate: asrResult.input_sample_rate,
        resampled_8k_to_16k: asrResult.resampled_8k_to_16k,
        active_speech_ms: asrResult.active_speech_ms,
        rms_db: asrResult.rms_db,
        is_silence: asrResult.is_silence
      };
    }

    console.log(`[Webhook][${callId}] Turn input: "${userText}" (VAD: ${vadLatency}ms, ASR: ${asrLatency}ms)`);

    // 2. Process turn through conversation engine (LLM or deterministic routing rule)
    const engineResult = await processTurn(session, userText);

    // 3. Synthesize speech for response (measured synchronous latency by default)
    const tts0 = Date.now();
    const campaign = getCampaign(session.campaignId);
    const ttsResult = await synthesizeSpeech(engineResult.reply, {
      format: outputAudioFormat,
      voice: campaign.voice,
      language: session.language,
      nonBlocking: nonBlockingTts,
      callId
    });
    const ttsLatency = ttsResult.latency_ms ?? (Date.now() - tts0);

    // Attach audio URL to the latest assistant turn in session history for QA replay
    const lastTurn = session.history[session.history.length - 1];
    if (lastTurn && lastTurn.role === 'assistant') {
      lastTurn.audioUrl = ttsResult.audio_url;
    }

    const totalLatency = Date.now() - t0;
    const timing = {
      vad: vadLatency,
      asr: asrLatency,
      llm: engineResult.timing_ms?.llm || 0,
      tts: ttsLatency,
      total: totalLatency
    };
    session.recordLatency(timing);

    console.log(`[Webhook][${callId}] Action: ${engineResult.action}, LLM: ${timing.llm}ms, TTS: ${timing.tts}ms, Total: ${totalLatency}ms`);

    const turnPayload = {
      call_id: callId,
      action: engineResult.action,
      intent: engineResult.intent,
      transcription: userText,
      reply: engineResult.reply,
      audio_url: ttsResult.audio_url,
      audio_format: ttsResult.format || outputAudioFormat,
      fallback_audio_used: Boolean(ttsResult.fallback_used),
      providers: {
        asr: asrMeta?.provider || (tempPath || req.body.audio_base64 ? 'none' : 'text_input'),
        llm: engineResult.provider || 'rule_engine',
        tts: ttsResult.provider || 'none'
      },
      audio_diagnostics: asrMeta,
      disposition: engineResult.disposition,
      confidence: engineResult.confidence,
      transfer: engineResult.transfer ? {
        extension: engineResult.transfer.id,
        name: engineResult.transfer.name,
        department: engineResult.transfer.dept,
        sip_uri: engineResult.transfer.sip,
        phone_number: engineResult.transfer.phone,
        reason: engineResult.reply
      } : null,
      timing_ms: timing,
      session: {
        turns: session.turns,
        status: session.status,
        disposition: session.disposition,
        language: session.language
      }
    };

    if (rawTurnKey) {
      setIdempotentResponse(rawTurnKey, turnPayload);
    }

    return res.json(turnPayload);

  } catch (err) {
    console.error(`[Webhook][${callId}] Turn error:`, err);
    return res.status(500).json({
      call_id: callId,
      action: 'transfer',
      reply: 'I apologize, our system experienced a temporary issue. Transferring your call to an agent now.',
      error: err.message
    });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
});

/**
 * 3. Barge-In Webhook
 */
router.post('/barge-in', (req, res) => {
  const callId = req.body.call_id;
  console.log(`[Webhook][${callId}] Caller barge-in event recorded`);
  res.json({ status: 'acknowledged', call_id: callId });
});

/**
 * 4. Call Ended Webhook
 */
router.post('/hangup', (req, res) => {
  const callId = req.body.call_id;
  const reason = req.body.reason || 'caller_hangup';
  const session = getSession(callId);

  if (session) {
    session.end(reason);
    const metrics = session.getMetrics();
    console.log(`[Webhook][${callId}] Call concluded: duration=${metrics.duration_seconds}s, disposition=${metrics.disposition}, p50=${metrics.p50_latency_ms}ms`);
    return res.json({
      status: 'closed',
      call_id: callId,
      summary: metrics
    });
  }

  res.json({ status: 'closed', call_id: callId });
});

/**
 * 5. Webhook Contract Spec
 */
router.get('/spec', (req, res) => {
  res.json({
    version: '2.1.0',
    endpoints: {
      call: '/api/webhook/call',
      turn: '/api/webhook/turn',
      barge_in: '/api/webhook/barge-in',
      hangup: '/api/webhook/hangup'
    },
    security: {
      enforce_auth_default: CONFIG.SECURITY.ENFORCE_AUTH,
      auth_types: ['X-Shared-Secret', 'X-Webhook-Signature (HMAC-SHA256)'],
      ip_allowlist: CONFIG.SECURITY.ALLOWED_IPS
    },
    idempotency: {
      supported: true,
      header: 'X-Idempotency-Key',
      ttl_seconds: 300
    },
    audio_pipeline: {
      input_formats: ['8kHz 16-bit PCM WAV', '8kHz G.711 mu-law (PCMU)', '16kHz PCM WAV', 'WebM/Opus'],
      resampling: '8kHz -> 16kHz FIR Sinc Upsampler',
      vad: '20ms Frame RMS Energy (dBFS) + Zero-Crossing Rate (ZCR) with silence trimming',
      asterisk_integration: 'AudioSocket TCP (slin16 8kHz) + FastAGI / HTTP Webhook'
    },
    languages: Object.keys(CONFIG.LANGUAGES),
    campaigns: Object.keys(CONFIG.CAMPAIGNS),
    extensions: CONFIG.EXTENSIONS
  });
});

export default router;
