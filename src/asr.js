import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { CONFIG, CHAOS_STATE, isChaosAllowed } from './config.js';
import { Groq, toFile } from 'groq-sdk';
import { preprocessAudioWithVad } from './audio_processing.js';

// Known hallucinations produced by ASR models on low-energy or background noise
const HALLUCINATION_PATTERNS = [
  /^(thank you|thanks)(\s+(very\s+much|so\s+much|for\s+watching|for\s+listening))?[.!]?$/i,
  /^(you|so|hmm|um|uh|oh|ah|okay|ok|subscribe|like and subscribe)[.!]?$/i,
  /^subtitles\s+by/i,
  /^translated\s+by/i,
  /^amara\.org/i,
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^\*.*\*$/,
  /^[\s\.\?!,_\-~:;]+$/
];

// Cooldown timestamp instead of permanent disable
let selfHostedAsrCooldownUntil = 0;
let groqAsrCooldownUntil = 0;
let geminiAsrCooldownUntil = 0;
let cachedAsrClient = null;
let cachedAsrKey = '';

const asrCounters = {
  self_hosted_asr: { requests: 0, successes: 0, failures: 0, cooldown_until: 0 },
  groq: { requests: 0, successes: 0, failures: 0, cooldown_until: 0 },
  gemini: { requests: 0, successes: 0, failures: 0, cooldown_until: 0 },
  vad_filtered: 0,
  resampled_8k_to_16k: 0
};

function getGeminiAsrClient(apiKey) {
  if (!cachedAsrClient || cachedAsrKey !== apiKey) {
    cachedAsrKey = apiKey;
    cachedAsrClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  }
  return cachedAsrClient;
}

/**
 * Detect MIME type from buffer magic bytes
 */
export function detectMimeType(buffer) {
  if (!buffer || buffer.length < 4) return 'audio/wav';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'audio/wav';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'audio/webm';
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return 'audio/ogg';
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'audio/mp3';
  if (buffer.length >= 8 && buffer.slice(4, 8).toString() === 'ftyp') return 'audio/mp4';
  return 'audio/wav';
}

/**
 * Check if audio buffer is too tiny (< 350 bytes)
 */
export function isAudioTrivial(buffer) {
  if (!buffer || buffer.length < 350) return true;
  return false;
}

/**
 * Extract transcribed text from GenerateContentResponse
 */
function extractTranscriptionFromResponse(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    if (p.audioTranscription?.text && typeof p.audioTranscription.text === 'string') {
      const t = p.audioTranscription.text.trim();
      if (t) return t;
    }
    if (p.text && typeof p.text === 'string') {
      const t = p.text.trim();
      if (t) return t;
    }
  }
  try {
    if (typeof response?.text === 'string' && response.text.trim()) {
      return response.text.trim();
    }
  } catch (_) {}
  return '';
}

/**
 * Transcribe caller audio with:
 *  1. 8kHz -> 16kHz upsampling & Voice Activity Detection (VAD)
 *  2. Groq Whisper (with 30s cooldown & automatic retry)
 *  3. Gemini 3.5 Transcribe / Gemini 3 Flash multimodal fallback (with 30s cooldown & retry)
 */
export async function transcribeAudio(audioBuffer, options = {}) {
  const t0 = Date.now();
  const { mimeType: inputMime, language = 'en', callId = 'turn' } = options;

  // Chaos simulation for testing ASR failure & retry recovery (only when allowed)
  if (isChaosAllowed() && CHAOS_STATE.simulateAsrFail) {
    console.warn(`[ASR][${callId}] CHAOS: Simulating ASR provider failure`);
    return {
      text: '',
      latency_ms: Date.now() - t0,
      vad_ms: 0,
      is_silence: true,
      error: 'simulated_asr_failure'
    };
  }

  if (isAudioTrivial(audioBuffer)) {
    return { text: '', latency_ms: Date.now() - t0, vad_ms: 0, is_silence: true };
  }

  const rawMime = inputMime || detectMimeType(audioBuffer);
  const cleanMime = rawMime.split(';')[0].trim() || 'audio/wav';

  // Run VAD + 8kHz -> 16kHz conversion before calling any ASR model
  const vadResult = preprocessAudioWithVad(audioBuffer, { mimeType: cleanMime });
  if (vadResult.resampled8kTo16k) {
    asrCounters.resampled_8k_to_16k++;
  }

  if (!vadResult.hasSpeech || !vadResult.wavBuffer) {
    asrCounters.vad_filtered++;
    console.log(`[ASR][${callId}] VAD detected silence/noise (RMS: ${vadResult.peakRmsDb} dBFS, active: ${vadResult.activeSpeechMs}ms) in ${vadResult.vadLatencyMs}ms`);
    return {
      text: '',
      latency_ms: Date.now() - t0,
      vad_ms: vadResult.vadLatencyMs,
      input_sample_rate: vadResult.inputSampleRate,
      resampled_8k_to_16k: vadResult.resampled8kTo16k,
      active_speech_ms: vadResult.activeSpeechMs,
      rms_db: vadResult.peakRmsDb,
      is_silence: true,
      provider: 'local/vad-silence'
    };
  }

  // Use the 16kHz mono PCM WAV produced by the VAD & resampler
  const wav16kBuffer = vadResult.wavBuffer;
  const asrLang = language.startsWith('hi') ? 'hi' : 'en';
  const now = Date.now();

  // 0. Sovereign GPU Primary ASR: Fine-Tuned Whisper-large-v3-turbo / AI4Bharat IndicConformer on 8kHz Call Audio (Guideline 1, 4)
  if ((process.env.SELF_HOSTED_ASR_URL || CONFIG.SOVEREIGN_GPU?.DISABLE_EXTERNAL_APIS) && now >= selfHostedAsrCooldownUntil) {
    asrCounters.self_hosted_asr.requests++;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      const formData = new FormData();
      formData.append('file', new Blob([wav16kBuffer], { type: 'audio/wav' }), 'speech_16k.wav');
      formData.append('model', CONFIG.SOVEREIGN_GPU.PRIMARY_ASR_MODEL);
      formData.append('language', asrLang);

      const res = await fetch(CONFIG.SOVEREIGN_GPU.SELF_HOSTED_ASR_URL, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      }).finally(() => clearTimeout(timer));

      if (res.ok) {
        const data = await res.json();
        const text = (data?.text || '').trim();
        if (text) {
          asrCounters.self_hosted_asr.successes++;
          const latency_ms = Date.now() - t0;
          return {
            text,
            latency_ms,
            vad_ms: vadResult.vadLatencyMs,
            input_sample_rate: vadResult.inputSampleRate,
            resampled_8k_to_16k: vadResult.resampled8kTo16k,
            active_speech_ms: vadResult.activeSpeechMs,
            rms_db: vadResult.peakRmsDb,
            is_silence: false,
            provider: `self-hosted-asr/${CONFIG.SOVEREIGN_GPU.PRIMARY_ASR_MODEL}`
          };
        }
      } else {
        throw new Error(`Self-hosted ASR HTTP ${res.status}`);
      }
    } catch (shErr) {
      asrCounters.self_hosted_asr.failures++;
      selfHostedAsrCooldownUntil = Date.now() + 10000;
      asrCounters.self_hosted_asr.cooldown_until = selfHostedAsrCooldownUntil;
    }
  }

  // If DISABLE_EXTERNAL_APIS=true (Sovereign GPU Mode after Sunset Date), do not call Groq or Gemini
  if (CONFIG.SOVEREIGN_GPU?.DISABLE_EXTERNAL_APIS) {
    return {
      text: '',
      latency_ms: Date.now() - t0,
      vad_ms: vadResult.vadLatencyMs,
      input_sample_rate: vadResult.inputSampleRate,
      resampled_8k_to_16k: vadResult.resampled8kTo16k,
      is_silence: true,
      error: 'Sovereign ASR node unreachable and DISABLE_EXTERNAL_APIS=true'
    };
  }

  // 1. Temporary Bridge: Groq Whisper ASR (with 30-second cooldown & automatic retry on failure)
  if (CONFIG.GROQ_API_KEY && now >= groqAsrCooldownUntil) {
    const model = 'whisper-large-v3-turbo';
    asrCounters.groq.requests++;
    try {
      const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
      const file = await toFile(wav16kBuffer, 'speech_16k.wav', { type: 'audio/wav' });
      const whisperPrompt = asrLang === 'hi'
        ? 'नमस्ते, कृपया मुझे बिलिंग विभाग, तकनीकी सहायता, सेल्स, या सुपरवाइजर एक्सटेंशन 101, 102, 103, 104, 200 से जोड़ें। आपकी रिफंड नीति और मासिक प्लान का शुल्क क्या है?'
        : 'Customer support, billing department, technical support, enterprise sales, supervisor extension 101, 102, 103, 104, 200, refund policy.';
      const transcriptionPromise = groq.audio.transcriptions.create({
        file,
        model,
        response_format: 'json',
        language: asrLang,
        prompt: whisperPrompt,
        temperature: 0.0
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Groq Whisper (${model}) timeout`)), 2500)
      );
      const result = await Promise.race([transcriptionPromise, timeoutPromise]);
      const text = (result?.text || '').trim();
      if (text) {
        const isHallucination = HALLUCINATION_PATTERNS.some(p => p.test(text));
        if (isHallucination && vadResult.activeSpeechMs < 400) {
          return {
            text: '',
            latency_ms: Date.now() - t0,
            vad_ms: vadResult.vadLatencyMs,
            input_sample_rate: vadResult.inputSampleRate,
            resampled_8k_to_16k: vadResult.resampled8kTo16k,
            is_silence: true,
            provider: `groq/${model}`
          };
        }
        asrCounters.groq.successes++;
        const latency_ms = Date.now() - t0;
        console.log(`[ASR][${callId}] Groq (${model}) transcribed in ${latency_ms}ms (VAD: ${vadResult.vadLatencyMs}ms, 8k->16k: ${vadResult.resampled8kTo16k}): "${text}"`);
        return {
          text,
          latency_ms,
          vad_ms: vadResult.vadLatencyMs,
          input_sample_rate: vadResult.inputSampleRate,
          resampled_8k_to_16k: vadResult.resampled8kTo16k,
          active_speech_ms: vadResult.activeSpeechMs,
          rms_db: vadResult.peakRmsDb,
          is_silence: false,
          provider: `groq/${model}`
        };
      }
    } catch (groqErr) {
      asrCounters.groq.failures++;
      groqAsrCooldownUntil = Date.now() + CONFIG.PROVIDER_COOLDOWN_MS;
      asrCounters.groq.cooldown_until = groqAsrCooldownUntil;
      console.warn(`[ASR][${callId}] Groq ASR failed (cooldown ${CONFIG.PROVIDER_COOLDOWN_MS / 1000}s before retry):`, groqErr.message);
    }
  }

  // 2. Temporary Bridge: Gemini Multimodal / Transcribe ASR (gemini-3-flash-preview & gemini-3.5-transcribe)
  const geminiKey = CONFIG.GEMINI_API_KEY;
  if (geminiKey && Date.now() >= geminiAsrCooldownUntil) {
    const ai = getGeminiAsrClient(geminiKey);
    const base64Audio = wav16kBuffer.toString('base64');
    const audioPart = {
      inlineData: {
        mimeType: 'audio/wav',
        data: base64Audio
      }
    };

    const runModelAsr = async (model) => {
      asrCounters.gemini.requests++;
      const prompt = language === 'hi'
        ? 'Transcribe this spoken Hindi audio accurately into Hindi Devanagari script (हिंदी). Output ONLY the exact spoken words with no punctuation commentary or extra labels. If there is no speech, output NO_SPEECH.'
        : language === 'hi-Latn'
        ? 'Transcribe this spoken audio accurately in Latin/Roman script (Hinglish). Output ONLY the exact spoken words. If there is no speech, output NO_SPEECH.'
        : 'Transcribe this spoken English audio accurately. Output ONLY the exact spoken words with no extra commentary. If there is no speech, output NO_SPEECH.';

      const config = model === 'gemini-3-flash-preview'
        ? { temperature: 0.0, thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
        : { temperature: 0.0 };

      const geminiPromise = ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [audioPart, { text: prompt }]
          }
        ],
        config
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Gemini ASR (${model}) timeout`)), CONFIG.TIMEOUTS.ASR_GEMINI)
      );

      const response = await Promise.race([geminiPromise, timeoutPromise]);
      let text = extractTranscriptionFromResponse(response);
      text = text.replace(/^["']|["']$/g, '').trim();

      if (!text || text.toUpperCase() === 'NO_SPEECH' || text.toUpperCase() === 'NO SPEECH') {
        throw new Error('NO_SPEECH');
      }
      return { text, model };
    };

    try {
      const winner = await Promise.any([
        runModelAsr('gemini-3-flash-preview'),
        runModelAsr('gemini-3.5-transcribe')
      ]);

      const { text, model } = winner;
      asrCounters.gemini.successes++;
      const latency_ms = Date.now() - t0;
      console.log(`[ASR][${callId}] Gemini (${model}) transcribed in ${latency_ms}ms (VAD: ${vadResult.vadLatencyMs}ms, 8k->16k: ${vadResult.resampled8kTo16k}): "${text}"`);
      return {
        text,
        latency_ms,
        vad_ms: vadResult.vadLatencyMs,
        input_sample_rate: vadResult.inputSampleRate,
        resampled_8k_to_16k: vadResult.resampled8kTo16k,
        active_speech_ms: vadResult.activeSpeechMs,
        rms_db: vadResult.peakRmsDb,
        is_silence: false,
        provider: `gemini/${model}`
      };
    } catch (aggErr) {
      asrCounters.gemini.failures++;
      const errors = aggErr?.errors || [];
      const allNoSpeech = errors.length > 0 && errors.every(e => e?.message === 'NO_SPEECH');
      if (allNoSpeech) {
        return {
          text: '',
          latency_ms: Date.now() - t0,
          vad_ms: vadResult.vadLatencyMs,
          input_sample_rate: vadResult.inputSampleRate,
          resampled_8k_to_16k: vadResult.resampled8kTo16k,
          is_silence: true,
          provider: 'gemini/no_speech'
        };
      }
      // Apply short 10s cooldown if all Gemini ASR models failed due to 429/network
      geminiAsrCooldownUntil = Date.now() + 10000;
      asrCounters.gemini.cooldown_until = geminiAsrCooldownUntil;
      console.warn(`[ASR][${callId}] Gemini ASR models failed (${Date.now() - t0}ms):`, errors.map(e => e?.message).join(' | '));
    }
  }

  return {
    text: '',
    latency_ms: Date.now() - t0,
    vad_ms: vadResult.vadLatencyMs,
    input_sample_rate: vadResult.inputSampleRate,
    resampled_8k_to_16k: vadResult.resampled8kTo16k,
    is_silence: true,
    error: 'All ASR models exhausted'
  };
}

export function getAsrCounters() {
  return { ...asrCounters };
}
