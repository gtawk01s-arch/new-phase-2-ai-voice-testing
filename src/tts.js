import { GoogleGenAI } from '@google/genai';
import { CONFIG, CHAOS_STATE, isChaosAllowed } from './config.js';
import { parseWavBuffer, resamplePcm16, createPcm16WavBuffer, encodePcm16ToMulaw } from './audio_processing.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// In-memory index and in-flight synthesis tracker
const audioCache = new Map();
const inFlightTts = new Map();

let cachedTtsClient = null;
let cachedTtsKey = '';
let selfHostedTtsCooldownUntil = 0;
let geminiTtsCooldownUntil = 0;

const ttsCounters = {
  self_hosted_indic_tts: { requests: 0, successes: 0, failures: 0, cooldown_until: 0 },
  google_cloud_tts: { requests: 0, successes: 0, failures: 0 },
  bhashini_tts: { requests: 0, successes: 0, failures: 0 },
  gemini_tts: { requests: 0, successes: 0, failures: 0, cooldown_until: 0 },
  fallback_played: 0,
  cache_hits: 0,
  cache_files_evicted: 0
};

function getGeminiTtsClient(apiKey) {
  if (!cachedTtsClient || cachedTtsKey !== apiKey) {
    cachedTtsKey = apiKey;
    cachedTtsClient = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });
  }
  return cachedTtsClient;
}

// Ensure directories exist
for (const dir of [CONFIG.AUDIO.CACHE_DIR, CONFIG.AUDIO.FALLBACK_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Pre-recorded spoken fallback files per language (stored in /public/audio/fallbacks/)
export const FALLBACK_LINES_MANIFEST = {
  en: {
    repeat: {
      filename: 'fallback-repeat-en.wav',
      text: 'Could you repeat that?'
    },
    transfer: {
      filename: 'fallback-transfer-en.wav',
      text: 'I apologize, our automated system is experiencing a technical issue. Let me transfer you directly to a specialist for immediate assistance. Please stay on the line.'
    },
    greeting: {
      filename: 'fallback-greeting-en.wav',
      text: 'Thank you for calling Customer Support. I am Alex, your automated AI voice agent. How may I help you today?'
    },
    dnc: {
      filename: 'fallback-dnc-en.wav',
      text: 'Understood. I have recorded your request and removed your phone number from our call list. Goodbye.'
    }
  },
  hi: {
    repeat: {
      filename: 'fallback-repeat-hi.wav',
      text: 'क्षमा करें, क्या आप कृपया उसे दोहरा सकते हैं?'
    },
    transfer: {
      filename: 'fallback-transfer-hi.wav',
      text: 'क्षमा करें, हमारे सिस्टम में अभी तकनीकी समस्या आ रही है। मैं आपकी कॉल तुरंत हमारे सहायता विशेषज्ञ को ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।'
    },
    greeting: {
      filename: 'fallback-greeting-hi.wav',
      text: 'नमस्ते, ग्राहक सहायता केंद्र में कॉल करने के लिए धन्यवाद। मैं आरव हूँ, आपका एआई वॉयस असिस्टेंट। आज मैं आपकी क्या सहायता कर सकता हूँ?'
    },
    dnc: {
      filename: 'fallback-dnc-hi.wav',
      text: 'समझ गया। मैंने आपका अनुरोध दर्ज कर लिया है और आपका फ़ोन नंबर हमारी कॉल सूची से हटा दिया है। नमस्ते।'
    }
  }
};

/**
 * Copy pre-recorded fallback WAV files from /public/audio/fallbacks/ into audio_cache
 * so /api/audio/:filename serves real spoken audio even when TTS is completely down.
 */
export function syncPreRecordedFallbacks() {
  for (const langGroup of Object.values(FALLBACK_LINES_MANIFEST)) {
    for (const item of Object.values(langGroup)) {
      const srcPath = path.join(CONFIG.AUDIO.FALLBACK_DIR, item.filename);
      const destPath = path.join(CONFIG.AUDIO.CACHE_DIR, item.filename);
      if (fs.existsSync(srcPath)) {
        try {
          fs.copyFileSync(srcPath, destPath);
          audioCache.set(item.filename, item.filename);
        } catch (_) {}
      }
    }
  }
}

syncPreRecordedFallbacks();

/**
 * Periodic TTL cleanup for audio_cache directory to prevent disk space leaks.
 * Removes dynamic cached files older than CONFIG.AUDIO.CACHE_TTL_MS (15 minutes),
 * while preserving pre-recorded fallback-*.wav files.
 */
export function cleanExpiredAudioCache() {
  const now = Date.now();
  let evicted = 0;
  try {
    const files = fs.readdirSync(CONFIG.AUDIO.CACHE_DIR);
    for (const file of files) {
      if (file.startsWith('fallback-')) continue; // Keep pre-recorded fallback files
      const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > CONFIG.AUDIO.CACHE_TTL_MS) {
          fs.unlinkSync(filePath);
          audioCache.delete(file);
          evicted++;
        }
      } catch (_) {}
    }
  } catch (_) {}
  if (evicted > 0) {
    ttsCounters.cache_files_evicted += evicted;
    console.log(`[TTS Cache] Evicted ${evicted} expired audio file(s)`);
  }
  return evicted;
}

const cacheSweepTimer = setInterval(cleanExpiredAudioCache, CONFIG.AUDIO.CACHE_SWEEP_MS);
if (cacheSweepTimer.unref) cacheSweepTimer.unref();

/**
 * Map voice name to Gemini TTS prebuilt voice ('Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir')
 */
export function mapToGeminiVoice(voiceName) {
  if (!voiceName) return 'Kore';
  const v = voiceName.toLowerCase();
  if (v.includes('guy') || v.includes('male') || v.includes('madhur') || v.includes('aarav') || v.includes('rohan')) return 'Puck';
  if (v.includes('charon')) return 'Charon';
  if (v.includes('fenrir')) return 'Fenrir';
  if (v.includes('aria') || v.includes('zephyr')) return 'Zephyr';
  return 'Kore';
}

function getCacheKey(text, voice, format = 'wav') {
  return crypto.createHash('sha256').update(`${text}_${voice}_${format}`).digest('hex');
}

function cleanSpokenText(text) {
  if (!text) return '';
  return text
    .replace(/[*_#`~[\]]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Select the appropriate pre-recorded spoken fallback WAV file for the language and intent
 */
export function getCachedFallbackLine(text = '', language = 'en') {
  const isHindi = language === 'hi' || /[\u0900-\u097F]/.test(text);
  const langKey = isHindi ? 'hi' : 'en';
  const bank = FALLBACK_LINES_MANIFEST[langKey];
  const lower = text.toLowerCase();

  if (lower.includes('repeat') || lower.includes('दोहरा') || lower.includes('sunai nahi')) {
    return bank.repeat.filename;
  }
  if (lower.includes('remove') || lower.includes('do not call') || lower.includes('सूची से हटा') || lower.includes('call list se')) {
    return bank.dnc.filename;
  }
  if (lower.includes('thank you for calling') || lower.includes('स्वागत') || lower.includes('कॉल करने के लिए धन्यवाद')) {
    return bank.greeting.filename;
  }
  return bank.transfer.filename;
}

/**
 * Wait for an in-flight TTS file if currently being synthesized
 */
export async function waitForAudioFile(filename, timeoutMs = 3500) {
  const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, filename);
  if (fs.existsSync(filePath)) return filePath;

  const fallbackPath = path.join(CONFIG.AUDIO.FALLBACK_DIR, filename);
  if (fs.existsSync(fallbackPath)) return fallbackPath;

  const pending = inFlightTts.get(filename);
  if (pending) {
    try {
      await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    } catch (_) {}
  }

  if (fs.existsSync(filePath)) return filePath;
  if (fs.existsSync(fallbackPath)) return fallbackPath;
  return null;
}

/**
 * Normalize any WAV buffer to target sampleRate (16000Hz default, or 8000Hz for telephony trunks)
 */
function normalizeWavSampleRate(wavBuffer, targetRate = 16000, format = 'wav') {
  const parsed = parseWavBuffer(wavBuffer);
  if (!parsed) return wavBuffer;

  if (format === 'mulaw_8k') {
    const pcm8k = parsed.sampleRate === 8000
      ? parsed.samples
      : resamplePcm16(parsed.samples, parsed.sampleRate, 8000);
    return encodePcm16ToMulaw(pcm8k);
  }

  if (parsed.sampleRate === targetRate) {
    return wavBuffer;
  }

  const resampled = resamplePcm16(parsed.samples, parsed.sampleRate, targetRate);
  return createPcm16WavBuffer(resampled, targetRate);
}

/**
 * 1. Google Cloud Text-to-Speech REST API (when GOOGLE_CLOUD_TTS_KEY is configured)
 */
async function callGoogleCloudTts(text, language, voice) {
  const apiKey = CONFIG.GOOGLE_CLOUD_TTS_KEY;
  if (!apiKey) return null;

  ttsCounters.google_cloud_tts.requests++;
  const isHi = language === 'hi' || /[\u0900-\u097F]/.test(text);
  const languageCode = isHi ? 'hi-IN' : 'en-IN';
  const voiceName = isHi ? 'hi-IN-Neural2-A' : (voice?.includes('IN') ? 'en-IN-Neural2-A' : 'en-US-Neural2-F');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voiceName },
        audioConfig: {
          audioEncoding: 'LINEAR16',
          sampleRateHertz: 16000,
          speakingRate: 1.0
        }
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Google Cloud TTS HTTP ${res.status}`);
    const data = await res.json();
    if (data?.audioContent) {
      ttsCounters.google_cloud_tts.successes++;
      return {
        wavBuffer: Buffer.from(data.audioContent, 'base64'),
        provider: `google-cloud-tts/${voiceName}`
      };
    }
  } catch (err) {
    ttsCounters.google_cloud_tts.failures++;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return null;
}

/**
 * 2. Bhashini ULCA TTS Pipeline (when BHASHINI_API_KEY is configured for Indian languages)
 */
async function callBhashiniTts(text, language) {
  const apiKey = CONFIG.BHASHINI_API_KEY;
  if (!apiKey) return null;

  ttsCounters.bhashini_tts.requests++;
  const sourceLanguage = (language === 'hi' || /[\u0900-\u097F]/.test(text)) ? 'hi' : 'en';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3200);
  try {
    const res = await fetch('https://dhruva-api.bhashini.gov.in/services/inference/pipeline', {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        pipelineTasks: [
          {
            taskType: 'tts',
            config: {
              language: { sourceLanguage },
              gender: 'female',
              samplingRate: 16000
            }
          }
        ],
        inputData: {
          input: [{ source: text }]
        }
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Bhashini TTS HTTP ${res.status}`);
    const data = await res.json();
    const b64 = data?.pipelineResponse?.[0]?.audio?.[0]?.audioContent;
    if (b64) {
      ttsCounters.bhashini_tts.successes++;
      return {
        wavBuffer: Buffer.from(b64, 'base64'),
        provider: `bhashini-tts/${sourceLanguage}`
      };
    }
  } catch (err) {
    ttsCounters.bhashini_tts.failures++;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return null;
}

/**
 * 3. Gemini Neural Audio TTS (gemini-3.8-flash-lite-tts / gemini-3.8-flash-tts)
 */
async function callGeminiTts(text, voice, callId) {
  const geminiKey = CONFIG.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('No Gemini API key configured');
  if (Date.now() < geminiTtsCooldownUntil) {
    throw new Error('Gemini TTS in cooldown');
  }

  const geminiVoice = mapToGeminiVoice(voice);
  const ai = getGeminiTtsClient(geminiKey);
  const models = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];

  for (const model of models) {
    ttsCounters.gemini_tts.requests++;
    try {
      const ttsPromise = ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: geminiVoice }
            }
          }
        }
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${model} timeout`)), CONFIG.TIMEOUTS.TTS_SYNTHESIS)
      );

      const response = await Promise.race([ttsPromise, timeoutPromise]);
      const base64Audio = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (base64Audio) {
        const rawBuffer = Buffer.from(base64Audio, 'base64');
        let wavBuffer = rawBuffer;
        // Unary default is a 24kHz RIFF WAV; wrap only if headerless PCM was returned
        if (rawBuffer.length > 4 && rawBuffer.slice(0, 4).toString('ascii') !== 'RIFF') {
          const sampleCount = Math.floor(rawBuffer.length / 2);
          const samples = new Int16Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            samples[i] = rawBuffer.readInt16LE(i * 2);
          }
          wavBuffer = createPcm16WavBuffer(samples, 24000);
        }
        ttsCounters.gemini_tts.successes++;
        return {
          wavBuffer,
          provider: `gemini-tts/${model}`
        };
      }
    } catch (err) {
      ttsCounters.gemini_tts.failures++;
      console.warn(`[TTS][${callId}] ${model} failed:`, err.message?.slice(0, 120));
      if (err.status === 429 || err.message?.includes('429')) {
        geminiTtsCooldownUntil = Date.now() + 15000;
        ttsCounters.gemini_tts.cooldown_until = geminiTtsCooldownUntil;
        break;
      }
    }
  }
  throw new Error('Gemini TTS models exhausted');
}

/**
 * Synthesize speech audio via production TTS providers (Google Cloud TTS -> Bhashini -> Gemini TTS)
 * Rule: "TTS fails: play a cached fallback line." (real pre-recorded spoken audio per language)
 */
export async function synthesizeSpeech(text, options = {}) {
  const t0 = Date.now();
  const {
    voice = CONFIG.AUDIO.DEFAULT_VOICE,
    language = 'en',
    format = 'wav',
    sampleRate = 16000,
    nonBlocking = false,
    callId = 'tts'
  } = options;

  const clean = cleanSpokenText(text);
  if (!clean) {
    return { audio_url: null, audio_buffer: null, latency_ms: 0, cached: false, format: 'wav' };
  }

  const detectedLang = /[\u0900-\u097F]/.test(clean) ? 'hi' : language;
  const cacheKey = getCacheKey(clean, voice, `${format}_${sampleRate}`);
  const staticFilename = `tts-${cacheKey.slice(0, 16)}.wav`;
  const staticPath = path.join(CONFIG.AUDIO.CACHE_DIR, staticFilename);

  // 1. Chaos Simulation: force TTS failure to test pre-recorded fallback line playback
  if (isChaosAllowed() && CHAOS_STATE.simulateTtsFail) {
    ttsCounters.fallback_played++;
    const fallbackFilename = getCachedFallbackLine(clean, detectedLang);
    syncPreRecordedFallbacks();
    const fbPath = path.join(CONFIG.AUDIO.CACHE_DIR, fallbackFilename);
    const fbAltPath = path.join(CONFIG.AUDIO.FALLBACK_DIR, fallbackFilename);
    const finalPath = fs.existsSync(fbPath) ? fbPath : fbAltPath;
    console.warn(`[TTS][${callId}] CHAOS: Simulating TTS failure. Playing pre-recorded fallback: ${fallbackFilename}`);
    return {
      filename: fallbackFilename,
      audio_url: `/api/audio/${fallbackFilename}`,
      audio_buffer: fs.existsSync(finalPath) ? fs.readFileSync(finalPath) : null,
      latency_ms: Date.now() - t0,
      cached: true,
      fallback_used: true,
      provider: 'local/prerecorded-fallback',
      format: 'wav'
    };
  }

  // 2. Disk cache check
  if (fs.existsSync(staticPath)) {
    ttsCounters.cache_hits++;
    return {
      filename: staticFilename,
      audio_url: `/api/audio/${staticFilename}`,
      audio_buffer: nonBlocking ? null : fs.readFileSync(staticPath),
      latency_ms: Date.now() - t0,
      cached: true,
      provider: 'cache/disk',
      format: 'wav'
    };
  }

  // 3. Synthesis Pipeline:
  //    Priority 0: Sovereign GPU Open Indic TTS (Indic Parler-TTS / Piper — 2 voices per language)
  //    Temporary External Bridge (when DISABLE_EXTERNAL_APIS=false): Google Cloud TTS -> Bhashini TTS -> Gemini 3.8 TTS
  const runGeneration = async () => {
    let synthResult = null;

    if ((process.env.SELF_HOSTED_TTS_URL || CONFIG.SOVEREIGN_GPU?.DISABLE_EXTERNAL_APIS) && Date.now() >= selfHostedTtsCooldownUntil) {
      ttsCounters.self_hosted_indic_tts.requests++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      try {
        const res = await fetch(CONFIG.SOVEREIGN_GPU.SELF_HOSTED_TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: CONFIG.SOVEREIGN_GPU.PRIMARY_TTS_MODEL,
            input: clean,
            voice: voice || (detectedLang === 'hi' ? 'hi-indic-aditi-f' : 'en-indic-neerja-f'),
            language: detectedLang,
            response_format: 'wav',
            sample_rate: 8000
          }),
          signal: controller.signal
        }).finally(() => clearTimeout(timer));

        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          const buf = Buffer.from(arrayBuf);
          if (buf.length > 100) {
            ttsCounters.self_hosted_indic_tts.successes++;
            synthResult = {
              wavBuffer: buf,
              provider: `self-hosted-tts/${CONFIG.SOVEREIGN_GPU.PRIMARY_TTS_MODEL}`
            };
          }
        } else {
          throw new Error(`Self-hosted TTS HTTP ${res.status}`);
        }
      } catch (shErr) {
        ttsCounters.self_hosted_indic_tts.failures++;
        selfHostedTtsCooldownUntil = Date.now() + 10000;
        ttsCounters.self_hosted_indic_tts.cooldown_until = selfHostedTtsCooldownUntil;
      }
    }

    if (!synthResult && !CONFIG.SOVEREIGN_GPU?.DISABLE_EXTERNAL_APIS) {
      if (CONFIG.GOOGLE_CLOUD_TTS_KEY) {
        try {
          synthResult = await callGoogleCloudTts(clean, detectedLang, voice);
        } catch (e) {
          console.warn(`[TTS][${callId}] Google Cloud TTS failed:`, e.message);
        }
      }

      if (!synthResult && CONFIG.BHASHINI_API_KEY) {
        try {
          synthResult = await callBhashiniTts(clean, detectedLang);
        } catch (e) {
          console.warn(`[TTS][${callId}] Bhashini TTS failed:`, e.message);
        }
      }

      if (!synthResult && CONFIG.GEMINI_API_KEY) {
        try {
          synthResult = await callGeminiTts(clean, voice, callId);
        } catch (e) {
          console.warn(`[TTS][${callId}] Gemini TTS failed:`, e.message);
        }
      }
    }

    if (synthResult && synthResult.wavBuffer) {
      const normalizedWav = normalizeWavSampleRate(synthResult.wavBuffer, sampleRate, format);
      fs.writeFileSync(staticPath, normalizedWav);
      audioCache.set(staticFilename, staticFilename);
      const latency_ms = Date.now() - t0;
      console.log(`[TTS][${callId}] Synthesized via ${synthResult.provider} in ${latency_ms}ms (${normalizedWav.length} bytes)`);
      return {
        filename: staticFilename,
        audio_url: `/api/audio/${staticFilename}`,
        audio_buffer: normalizedWav,
        latency_ms,
        cached: false,
        provider: synthResult.provider,
        format
      };
    }

    return null;
  };

  if (nonBlocking) {
    if (!inFlightTts.has(staticFilename)) {
      const promise = runGeneration().finally(() => {
        inFlightTts.delete(staticFilename);
      });
      inFlightTts.set(staticFilename, promise);
    }
    return {
      filename: staticFilename,
      audio_url: `/api/audio/${staticFilename}`,
      audio_buffer: null,
      latency_ms: Date.now() - t0,
      cached: false,
      in_flight: true,
      format
    };
  }

  let genResult = null;
  if (inFlightTts.has(staticFilename)) {
    genResult = await inFlightTts.get(staticFilename);
  } else {
    const promise = runGeneration().finally(() => {
      inFlightTts.delete(staticFilename);
    });
    inFlightTts.set(staticFilename, promise);
    genResult = await promise;
  }

  if (genResult) {
    return genResult;
  }

  // 4. TTS Failure Fallback: play pre-recorded spoken fallback line in caller's language
  ttsCounters.fallback_played++;
  const fallbackFile = getCachedFallbackLine(clean, detectedLang);
  syncPreRecordedFallbacks();
  const fallbackPath = path.join(CONFIG.AUDIO.CACHE_DIR, fallbackFile);
  const altFallbackPath = path.join(CONFIG.AUDIO.FALLBACK_DIR, fallbackFile);
  const resolvedPath = fs.existsSync(fallbackPath) ? fallbackPath : altFallbackPath;
  const fallbackBuf = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath) : null;

  return {
    filename: fallbackFile,
    audio_url: `/api/audio/${fallbackFile}`,
    audio_buffer: fallbackBuf,
    latency_ms: Date.now() - t0,
    cached: true,
    fallback_used: true,
    provider: 'local/prerecorded-fallback',
    format: 'wav'
  };
}

export async function pregenerateStaticLines() {
  syncPreRecordedFallbacks();
}

export function getTtsCounters() {
  return { ...ttsCounters };
}
