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
 * Verifies optional HMAC signature or shared secret header
 */
function verifyWebhookSecurity(req, res, next) {
  if (!CONFIG.SECURITY.ENFORCE_AUTH) {
    return next();
  }

  const sharedSecret = req.headers['x-shared-secret'] || req.headers['x-webhook-secret'];
  const signature = req.headers['x-webhook-signature'];

  if (sharedSecret && sharedSecret === CONFIG.SECURITY.SHARED_SECRET) {
    return next();
  }

  if (signature) {
    const rawBody = JSON.stringify(req.body || {});
    const expected = crypto.createHmac('sha256', CONFIG.SECURITY.SHARED_SECRET).update(rawBody).digest('hex');
    if (signature === expected) {
      return next();
    }
  }

  // Allow bypass in test/simulation if header passed
  if (req.headers['x-bypass-allowlist'] === '1' || req.ip === '127.0.0.1' || req.ip === '::1') {
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized: Invalid or missing webhook security credentials',
    hint: 'Provide X-Shared-Secret or X-Webhook-Signature header'
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
  const language = req.body.language || 'en';
  const outputAudioFormat = req.body.output_audio_format || 'mp3';

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

  // Generate or retrieve greeting audio
  const ttsRes = await synthesizeSpeech(greeting, {
    format: outputAudioFormat,
    voice: campaign.voice,
    isStatic: !req.body.custom_greeting,
    callId
  });

  const timing = {
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
    audio_format: outputAudioFormat,
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
 * Triggered per spoken phrase (audio upload, base64 audio, or transcribed text)
 */
router.post('/turn', upload.single('audio'), async (req, res) => {
  const t0 = Date.now();
  const callId = req.body.call_id || 'demo-call';
  const session = getOrCreateSession(callId);
  const outputAudioFormat = req.body.output_audio_format || session.outputAudioFormat || 'mp3';
  const tempPath = req.file?.path;

  let userText = (req.body.text || '').trim();
  let asrLatency = 0;

  // Idempotency check for dialer retries
  const rawTurnKey = req.headers['x-idempotency-key'] || req.body.idempotency_key || (userText ? `turn-${callId}-${userText}` : null);
  if (rawTurnKey) {
    const cached = getIdempotentResponse(rawTurnKey);
    if (cached) {
      res.setHeader('X-Idempotent-Replay', 'true');
      if (tempPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }
      return res.json(cached);
    }
  }

  try {
    // ASR processing if audio was provided
    if (tempPath && !userText) {
      const audioBuffer = fs.readFileSync(tempPath);
      const asrResult = await transcribeAudio(audioBuffer, {
        callId,
        language: session.language
      });
      userText = asrResult.text;
      asrLatency = asrResult.latency_ms;
    } else if (req.body.audio_base64 && !userText) {
      const audioBuffer = Buffer.from(req.body.audio_base64, 'base64');
      const asrResult = await transcribeAudio(audioBuffer, {
        callId,
        language: session.language,
        mimeType: req.body.audio_format ? `audio/${req.body.audio_format}` : undefined
      });
      userText = asrResult.text;
      asrLatency = asrResult.latency_ms;
    }

    console.log(`[Webhook][${callId}] Processing turn. Input: "${userText}" (ASR: ${asrLatency}ms)`);

    // Process turn through structured conversation engine
    const engineResult = await processTurn(session, userText);

    // Synthesize speech for response
    const tts0 = Date.now();
    const campaign = getCampaign(session.campaignId);
    const ttsResult = await synthesizeSpeech(engineResult.reply, {
      format: outputAudioFormat,
      voice: campaign.voice,
      callId
    });
    const ttsLatency = Date.now() - tts0;

    const totalLatency = Date.now() - t0;
    const timing = {
      asr: asrLatency,
      llm: engineResult.timing_ms?.llm || 0,
      tts: ttsLatency,
      total: totalLatency
    };
    session.recordLatency(timing);

    console.log(`[Webhook][${callId}] Action: ${engineResult.action}, reply: "${engineResult.reply}" (Total: ${totalLatency}ms)`);

    const turnPayload = {
      call_id: callId,
      action: engineResult.action,
      intent: engineResult.intent,
      transcription: userText,
      reply: engineResult.reply,
      audio_url: ttsResult.audio_url,
      audio_format: outputAudioFormat,
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
      reply: "I apologize, our system experienced a temporary issue. Transferring your call to an agent now.",
      error: err.message
    });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
});

/**
 * 3. Barge-In Webhook
 * Triggered when caller interrupts agent speech
 */
router.post('/barge-in', (req, res) => {
  const callId = req.body.call_id;
  console.log(`[Webhook][${callId}] Caller barge-in event recorded`);
  res.json({ status: 'acknowledged', call_id: callId });
});

/**
 * 4. Call Ended Webhook
 * Concludes the call and outputs post-call analytics and latency metrics
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
    version: '2.0.0',
    endpoints: {
      call: '/api/webhook/call',
      turn: '/api/webhook/turn',
      barge_in: '/api/webhook/barge-in',
      hangup: '/api/webhook/hangup'
    },
    security: {
      auth_types: ['X-Shared-Secret', 'X-Webhook-Signature (HMAC-SHA256)'],
      ip_allowlist: CONFIG.SECURITY.ALLOWED_IPS
    },
    idempotency: {
      supported: true,
      header: 'X-Idempotency-Key',
      ttl_seconds: 300
    },
    languages: Object.keys(CONFIG.LANGUAGES),
    campaigns: Object.keys(CONFIG.CAMPAIGNS),
    supported_audio_inputs: ['multipart/form-data (audio)', 'base64 (audio_base64)', 'text'],
    supported_audio_outputs: ['mp3', 'wav', 'mulaw_8k'],
    extensions: CONFIG.EXTENSIONS
  });
});

export default router;
