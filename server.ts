import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import os from 'os';
import { createServer as createViteServer } from 'vite';

import { CONFIG, CHAOS_STATE, getCampaign, getLanguage } from './src/config.js';
import webhookRouter from './src/webhook.js';
import { pregenerateStaticLines, synthesizeSpeech } from './src/tts.js';
import {
  getGlobalLatencyMetrics,
  getAllSessions,
  getOrCreateSession,
  getSession,
  deleteSession,
  getAuditCalls,
  flagTurn,
  correctTranscript,
  exportFineTuningDataset
} from './src/session.js';
import { getProviderCounters } from './src/llm.js';
import { transcribeAudio } from './src/asr.js';
import { processTurn } from './src/engine.js';

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

// 1. Healthcheck endpoint checking ASR, TTS, and LLM (Phase 2 Task 8)
const getHealthPayload = async (deepCheck = false) => {
  const latency = getGlobalLatencyMetrics();
  const providers = getProviderCounters();

  const asrStatus = {
    status: CHAOS_STATE.simulateAsrFail ? 'simulated_failure' : (CONFIG.GROQ_API_KEY ? 'ready' : 'unconfigured'),
    primary: 'groq/whisper-large-v3-turbo',
    secondary: 'groq/whisper-large-v3',
    fallback: 'gemini/gemini-3.8-flash'
  };

  const llmStatus = {
    status: (CHAOS_STATE.simulateLlmFail || CHAOS_STATE.forceProvider === 'all_down')
      ? 'simulated_outage'
      : (CONFIG.GROQ_API_KEY || CONFIG.GEMINI_API_KEY ? 'ready' : 'degraded'),
    groq_active: Boolean(CONFIG.GROQ_API_KEY && CONFIG.GROQ_API_KEY.startsWith('gsk_')),
    gemini_active: Boolean(CONFIG.GEMINI_API_KEY),
    active_models: CONFIG.GROQ_MODELS,
    metrics: providers
  };

  const ttsCacheReady = fs.existsSync(CONFIG.AUDIO.CACHE_DIR);
  const ttsStatus = {
    status: CHAOS_STATE.simulateTtsFail ? 'simulated_failure' : (ttsCacheReady ? 'ready' : 'error'),
    cache_dir: CONFIG.AUDIO.CACHE_DIR,
    fallback_cached: true,
    engine: 'gemini-3.8-flash-tts / client-synthesis'
  };

  return {
    status: (asrStatus.status === 'ready' && llmStatus.status === 'ready' && ttsStatus.status === 'ready') ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    port: CONFIG.PORT,
    version: '2.0.0',
    mode: 'tested with recordings', // per requirement: reports say tested with recordings, never live
    subsystems: {
      asr: asrStatus,
      llm: llmStatus,
      tts: ttsStatus
    },
    chaos_mode: CHAOS_STATE,
    latency: {
      target_ms: CONFIG.TIMEOUTS.TOTAL_BUDGET,
      p50_ms: latency.p50,
      p95_ms: latency.p95,
      samples: latency.sample_count
    },
    active_sessions: getAllSessions().filter((s: any) => s.status === 'connected').length
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

// 2. Admin Chaos Injection Routes (Kill providers on purpose to test fallbacks)
app.get('/api/admin/chaos', (_req: Request, res: Response) => {
  res.json({ status: 'ok', chaos: CHAOS_STATE });
});

app.post('/api/admin/chaos', (req: Request, res: Response) => {
  if (typeof req.body.simulateAsrFail === 'boolean') CHAOS_STATE.simulateAsrFail = req.body.simulateAsrFail;
  if (typeof req.body.simulateLlmFail === 'boolean') CHAOS_STATE.simulateLlmFail = req.body.simulateLlmFail;
  if (typeof req.body.simulateTtsFail === 'boolean') CHAOS_STATE.simulateTtsFail = req.body.simulateTtsFail;
  if (['none', 'groq', 'gemini', 'all_down'].includes(req.body.forceProvider)) {
    CHAOS_STATE.forceProvider = req.body.forceProvider;
  }
  console.log('⚡ Chaos state updated:', CHAOS_STATE);
  res.json({ status: 'updated', chaos: CHAOS_STATE });
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

// 4. Telephony Webhook Contract Router
app.use('/api/webhook', webhookRouter);

// 5. PBX / Dialer Routes
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
  const campaignId = req.body.campaign || (direction === 'outbound' ? 'sales' : 'support');
  const campaign = getCampaign(campaignId);
  const language = req.body.language || campaign.language || 'en';
  const chosenVoice = req.body.voice || campaign.voice || CONFIG.AUDIO.DEFAULT_VOICE;

  const session = getOrCreateSession(callId, {
    direction,
    callerId,
    campaignId,
    language,
    customerName
  });

  const greeting = req.body.custom_greeting || campaign.greeting;
  session.recordTurn('assistant', greeting, { intent: 'greeting', action: 'speak_and_listen' });

  console.log(`[Dialer][${callId}] Synthesizing greeting: "${greeting}" (${language}) with voice: ${chosenVoice}`);
  const ttsRes = await synthesizeSpeech(greeting, {
    isStatic: !req.body.custom_greeting,
    voice: chosenVoice,
    callId
  });

  res.json({
    status: 'success',
    call_id: callId,
    direction,
    call_status: 'connected',
    greeting,
    audio_url: ttsRes.audio_url,
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

  try {
    if (tempPath && !userText) {
      const audioBuffer = fs.readFileSync(tempPath);
      const asr = await transcribeAudio(audioBuffer, { callId, language: session.language });
      userText = asr.text;
      asrLatency = asr.latency_ms;
    }

    const t0 = Date.now();
    const engineResult = await processTurn(session, userText);
    const campaign = getCampaign(session.campaignId);
    const chosenVoice = req.body.voice || campaign.voice || CONFIG.AUDIO.DEFAULT_VOICE;

    const tts0 = Date.now();
    const ttsResult = await synthesizeSpeech(engineResult.reply, {
      voice: chosenVoice,
      callId
    });
    const ttsLatency = Date.now() - tts0;

    const timings = {
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
      try { fs.unlinkSync(tempPath); } catch (e) {}
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

  const transferMessage = session.language.startsWith('hi')
    ? `अवश्य! मैं आपकी कॉल सीधे ${ext.name} को एक्सटेंशन ${ext.id} पर ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।`
    : `Certainly! I am transferring your call directly to ${ext.name} on extension ${ext.id}. Please stay on the line.`;

  session.recordTurn('assistant', transferMessage, { action: 'transfer', intent: 'manual_transfer' });

  const ttsRes = await synthesizeSpeech(transferMessage, {
    isStatic: true,
    callId
  });

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

// Dedicated TTS synthesis endpoint (Phase 2 Task 8: cached fallback line verification)
app.post('/api/tts', async (req: Request, res: Response) => {
  const { text, voice, callId } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  const result = await synthesizeSpeech(text, { voice, callId });
  if (result.fallback_used || result.is_fallback) {
    res.setHeader('X-Fallback-Cached', 'true');
  }
  const audioFilename = result.filename || (result.audio_url ? path.basename(result.audio_url) : 'fallback-general.wav');
  const safeFilename = path.basename(audioFilename);
  const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, safeFilename);

  if (req.headers.accept?.includes('application/json')) {
    return res.json(result);
  }
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'audio/wav');
    return res.sendFile(filePath);
  }
  return res.json(result);
});

// Dedicated ASR transcription endpoint
app.post('/api/asr', upload.single('audio'), async (req: Request, res: Response) => {
  const tempPath = req.file?.path;
  if (!tempPath) {
    return res.status(400).json({ error: 'audio file is required' });
  }
  try {
    const audioBuffer = fs.readFileSync(tempPath);
    const result = await transcribeAudio(audioBuffer, {
      callId: req.body.call_id,
      language: req.body.language
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

// 6. Serve generated / cached audio files
app.get('/api/audio/:filename', (req: Request, res: Response) => {
  const rawParam = req.params.filename;
  const filename = Array.isArray(rawParam) ? rawParam[0] : (rawParam || '');
  const safeFilename = path.basename(filename);
  const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, safeFilename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Audio file not found');
  }
  const ext = path.extname(safeFilename).toLowerCase();
  const mimeType = ext === '.wav' ? 'audio/wav' : (ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg');
  res.setHeader('Content-Type', mimeType);
  res.sendFile(filePath);
});

// 7. Mount Vite SPA in Dev or serve build in Prod
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
    console.log(`🚀 AI Call Assistant & Telephony Engine running on http://${CONFIG.HOST}:${CONFIG.PORT}`);
    pregenerateStaticLines().catch((err: any) => console.warn('Pregeneration notice:', err.message));
  });
}

startServer().catch((err) => {
  console.error('Server startup error:', err);
  process.exit(1);
});
