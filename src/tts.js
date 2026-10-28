import { GoogleGenAI } from '@google/genai';
import { CONFIG, CHAOS_STATE } from './config.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Memory and file cache for static audio lines
const audioCache = new Map();

// Ensure audio cache directory exists
if (!fs.existsSync(CONFIG.AUDIO.CACHE_DIR)) {
  fs.mkdirSync(CONFIG.AUDIO.CACHE_DIR, { recursive: true });
}

/**
 * Generate a standalone PCM WAV buffer (with soft tone) for guaranteed offline cached lines
 */
function createFallbackWav(durationSeconds = 1.2, freq = 440, sampleRate = 16000) {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const buffer = Buffer.alloc(44 + numSamples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // subchunk 1 size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(1, 22);  // 1 channel (mono)
  buffer.writeUInt32LE(sampleRate, 24); // sample rate
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);  // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  // Soft envelope sine chime so it sounds like a clean PBX cue
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-3 * t);
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.18 * env * 32767;
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), 44 + i * 2);
  }
  return buffer;
}

// Populate and guarantee standard cached fallback lines on startup
const STATIC_FALLBACK_FILES = {
  repeat: 'fallback-repeat.wav',
  transfer: 'fallback-transfer.wav',
  error: 'fallback-error.wav',
  greeting: 'fallback-greeting.wav',
  dnc: 'fallback-dnc.wav',
  general: 'fallback-general.wav'
};

for (const [key, filename] of Object.entries(STATIC_FALLBACK_FILES)) {
  const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, filename);
  if (!fs.existsSync(filePath)) {
    const freq = key === 'repeat' ? 520 : (key === 'transfer' ? 660 : 440);
    fs.writeFileSync(filePath, createFallbackWav(1.5, freq));
  }
  audioCache.set(filename, filename);
}

// Populate audioCache from disk on startup
try {
  const files = fs.readdirSync(CONFIG.AUDIO.CACHE_DIR);
  for (const f of files) {
    if (f.endsWith('.wav') || f.endsWith('.mp3')) {
      audioCache.set(f, f);
    }
  }
} catch (e) {}

/**
 * Map voice name to Gemini TTS prebuilt voice
 * Gemini prebuilt voices: 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'
 */
export function mapToGeminiVoice(voiceName) {
  if (!voiceName) return 'Kore';
  const v = voiceName.toLowerCase();
  if (v.includes('guy') || v.includes('male') || v.includes('david') || v.includes('aarav') || v.includes('rohan')) return 'Puck';
  if (v.includes('charon') || v.includes('deep')) return 'Charon';
  if (v.includes('fenrir')) return 'Fenrir';
  if (v.includes('aria') || v.includes('zephyr')) return 'Zephyr';
  if (v.includes('jenny') || v.includes('swara')) return 'Kore';
  return 'Kore';
}

/**
 * Generate a SHA256 cache key for static lines
 */
function getCacheKey(text, voice, format = 'wav') {
  return crypto.createHash('sha256').update(`${text}_${voice}_${format}`).digest('hex');
}

/**
 * Clean text for spoken TTS
 */
function cleanSpokenText(text) {
  if (!text) return '';
  return text
    .replace(/[*_#`~[\]]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Identify closest static cached fallback line based on utterance intent
 */
export function getCachedFallbackLine(text = '') {
  const lower = text.toLowerCase();
  if (lower.includes('repeat') || lower.includes('catch that') || lower.includes('say that again')) {
    return STATIC_FALLBACK_FILES.repeat;
  }
  if (lower.includes('transfer') || lower.includes('hold') || lower.includes('connect you')) {
    return STATIC_FALLBACK_FILES.transfer;
  }
  if (lower.includes('technical issue') || lower.includes('apologize') || lower.includes('difficulty')) {
    return STATIC_FALLBACK_FILES.error;
  }
  if (lower.includes('remove') || lower.includes('do not call') || lower.includes('goodbye')) {
    return STATIC_FALLBACK_FILES.dnc;
  }
  if (lower.includes('thank you for calling') || lower.includes('help you')) {
    return STATIC_FALLBACK_FILES.greeting;
  }
  return STATIC_FALLBACK_FILES.general;
}

/**
 * Pre-generate static lines (e.g. greetings) in the background so inbound calls connect with 0ms audio latency
 */
export async function pregenerateStaticLines() {
  try {
    const greetingEn = 'Thank you for calling Customer Support. I am Alex, your automated AI voice agent. What can I help you with today?';
    await synthesizeSpeech(greetingEn, { isStatic: true, callId: 'pregen-en' });

    const greetingHi = 'कस्टमर सपोर्ट में कॉल करने के लिए धन्यवाद। मैं आरव हूँ, आपका एआई वॉयस असिस्टेंट।';
    await synthesizeSpeech(greetingHi, { isStatic: true, callId: 'pregen-hi' });
  } catch (e) {
    // Non-blocking
  }
}

/**
 * Synthesize speech audio with Gemini 3.8 Flash TTS or return cached fallback line
 * Rule: "TTS fails: play a cached fallback line."
 */
export async function synthesizeSpeech(text, options = {}) {
  const t0 = Date.now();
  const {
    voice = CONFIG.AUDIO.DEFAULT_VOICE,
    format = 'wav',
    isStatic = false,
    callId = 'tts'
  } = options;

  const clean = cleanSpokenText(text);
  if (!clean) {
    return { audio_url: null, audio_buffer: null, latency_ms: 0, cached: false, format: 'wav' };
  }

  const cacheKey = getCacheKey(clean, voice, format);
  const staticFilename = `static-${cacheKey.slice(0, 16)}.wav`;
  const staticPath = path.join(CONFIG.AUDIO.CACHE_DIR, staticFilename);

  // 1. Instant disk cache check
  if (fs.existsSync(staticPath)) {
    return {
      audio_url: `/api/audio/${staticFilename}`,
      audio_buffer: fs.readFileSync(staticPath),
      latency_ms: Date.now() - t0,
      cached: true,
      format: 'wav'
    };
  }

  // 2. Chaos Simulation: force TTS failure to test cached fallback playback
  if (CHAOS_STATE.simulateTtsFail) {
    console.warn(`[TTS][${callId}] ⚠️ CHAOS: Simulating TTS failure. Playing cached fallback line.`);
    const fallbackFilename = getCachedFallbackLine(clean);
    return {
      audio_url: `/api/audio/${fallbackFilename}`,
      audio_buffer: fs.readFileSync(path.join(CONFIG.AUDIO.CACHE_DIR, fallbackFilename)),
      latency_ms: Date.now() - t0,
      cached: true,
      fallback_used: true,
      format: 'wav'
    };
  }

  // 3. Online Gemini TTS synthesis (gemini-3.8-flash-tts provides high-fidelity natural speech)
  const geminiKey = CONFIG.GEMINI_API_KEY;
  const ttsModels = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];

  if (geminiKey) {
    const geminiVoice = mapToGeminiVoice(voice);
    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });

    for (const model of ttsModels) {
      try {
        const ttsPromise = ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: clean }] }],
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
          setTimeout(() => reject(new Error(`${model} timeout (3.5s)`)), 3500)
        );

        const response = await Promise.race([ttsPromise, timeoutPromise]);
        const base64Audio = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

        if (base64Audio) {
          const wavBuffer = Buffer.from(base64Audio, 'base64');
          const filename = isStatic
            ? staticFilename
            : `reply-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.wav`;
          const filePath = path.join(CONFIG.AUDIO.CACHE_DIR, filename);
          fs.writeFileSync(filePath, wavBuffer);

          audioCache.set(cacheKey, filename);

          const latency_ms = Date.now() - t0;
          console.log(`[TTS][${callId}] Generated audio via ${model} (${geminiVoice}) in ${latency_ms}ms, size: ${wavBuffer.length} bytes`);
          return {
            audio_url: `/api/audio/${filename}`,
            audio_buffer: wavBuffer,
            latency_ms,
            cached: false,
            format: 'wav'
          };
        }
      } catch (modelErr) {
        console.warn(`[TTS][${callId}] Model ${model} failed (${Date.now() - t0}ms):`, modelErr.message?.slice(0, 100));
        // Continue to try next model in chain
      }
    }
  }

  // 4. TTS Failure Fallback: "TTS fails: play a cached fallback line"
  const fallbackFile = getCachedFallbackLine(clean);
  const fallbackPath = path.join(CONFIG.AUDIO.CACHE_DIR, fallbackFile);
  const fallbackBuf = fs.existsSync(fallbackPath) ? fs.readFileSync(fallbackPath) : null;

  return {
    audio_url: `/api/audio/${fallbackFile}`,
    audio_buffer: fallbackBuf,
    latency_ms: Date.now() - t0,
    cached: true,
    fallback_used: true,
    format: 'wav'
  };
}
