import { GoogleGenAI } from '@google/genai';
import { CONFIG, CHAOS_STATE } from './config.js';
import { Groq, toFile } from 'groq-sdk';
import fs from 'fs';

// Known hallucinations produced by ASR models on low-energy or background noise
const HALLUCINATION_PATTERNS = [
  /^(thank you|thanks)(\s+(very\s+much|so\s+much|for\s+watching|for\s+listening))?[.!]?$/i,
  /^(you|so|hmm|um|uh|oh|ah|okay|ok|bye|goodbye|subscribe|like and subscribe)[.!]?$/i,
  /^subtitles\s+by/i,
  /^translated\s+by/i,
  /^amara\.org/i,
  /^\[.*\]$/,
  /^\(.*\)$/,
  /^\*.*\*$/,
  /^[\s\.\?!,_\-~:;]+$/
];

let groqAsrDisabledPermanently = false;

/**
 * Detect MIME type from buffer magic bytes
 */
export function detectMimeType(buffer) {
  if (!buffer || buffer.length < 4) return 'audio/webm';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'audio/webm';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'audio/wav';
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return 'audio/ogg';
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'audio/mp3';
  if (buffer.length >= 8 && buffer.slice(4, 8).toString() === 'ftyp') return 'audio/mp4';
  return 'audio/webm';
}

/**
 * Check if audio buffer is too tiny (< 350 bytes) or essentially silence
 */
export function isAudioTrivial(buffer) {
  if (!buffer || buffer.length < 350) return true;
  return false;
}

/**
 * Transcribe caller audio with Groq Whisper and Gemini Multimodal fallback
 */
export async function transcribeAudio(audioBuffer, options = {}) {
  const t0 = Date.now();
  const { mimeType: inputMime, language = 'en', callId = 'turn' } = options;

  // Chaos simulation for testing ASR failure & retry recovery
  if (CHAOS_STATE.simulateAsrFail) {
    console.warn(`[ASR][${callId}] ⚠️ CHAOS: Simulating ASR provider failure`);
    return { text: '', latency_ms: Date.now() - t0, is_silence: true, error: 'simulated_asr_failure' };
  }

  if (isAudioTrivial(audioBuffer)) {
    return { text: '', latency_ms: Date.now() - t0, is_silence: true };
  }

  const mimeType = inputMime || detectMimeType(audioBuffer);
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : 'webm';
  const asrLang = language.startsWith('hi') ? 'hi' : 'en';

  // 1. Primary High-Speed ASR: Groq Whisper models (only if key is real and not the mock key)
  const isGroqUsable = CONFIG.GROQ_API_KEY &&
    !groqAsrDisabledPermanently &&
    !CONFIG.GROQ_API_KEY.includes('YKMD8aeIZWqJe6eZrSemWGdyb3FYwNTvIOUaNAjLmxIJnLmetVAC');

  if (isGroqUsable) {
    const whisperModels = ['whisper-large-v3-turbo'];
    for (const model of whisperModels) {
      try {
        const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
        const file = await toFile(audioBuffer, `audio.${ext}`, { type: mimeType });
        const transcriptionPromise = groq.audio.transcriptions.create({
          file,
          model,
          response_format: 'json',
          language: asrLang,
          temperature: 0.0
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Groq Whisper (${model}) timeout`)), 1800)
        );
        const result = await Promise.race([transcriptionPromise, timeoutPromise]);
        let text = (result?.text || '').trim();
        if (text) {
          const isHallucination = HALLUCINATION_PATTERNS.some(p => p.test(text));
          if (isHallucination && audioBuffer.length < 3500) {
            console.log(`[ASR][${callId}] Filtered Whisper hallucination "${text}"`);
            return { text: '', latency_ms: Date.now() - t0, is_silence: true, provider: `groq/${model}` };
          }
          const latency_ms = Date.now() - t0;
          console.log(`[ASR][${callId}] Groq Whisper (${model}) transcribed in ${latency_ms}ms (${asrLang}): "${text}"`);
          return { text, latency_ms, is_silence: false, provider: `groq/${model}` };
        }
      } catch (groqErr) {
        groqAsrDisabledPermanently = true;
        console.warn(`[ASR][${callId}] Groq ASR disabled:`, groqErr.message);
        break;
      }
    }
  }

  // 2. Primary Multimodal ASR: Gemini 3.8 Flash
  const geminiKey = process.env.GEMINI_API_KEY || CONFIG.GEMINI_API_KEY;
  if (geminiKey) {
    const geminiAsrModels = ['gemini-3.8-flash'];
    const base64Audio = audioBuffer.toString('base64');
    const audioPart = {
      inlineData: {
        mimeType,
        data: base64Audio
      }
    };

    for (const model of geminiAsrModels) {
      try {
        const ai = new GoogleGenAI({
          apiKey: geminiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        });
        const geminiPromise = ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                audioPart,
                { text: `Transcribe the audio speech accurately in ${asrLang}. Output ONLY the transcribed words. If there is no human speech, output NO_SPEECH.` }
              ]
            }
          ],
          config: {
            temperature: 0.0
          }
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Gemini ASR (${model}) timeout`)), 3500)
        );
        const response = await Promise.race([geminiPromise, timeoutPromise]);

        // Extract transcription text from response or non-text parts (audioTranscription)
        let text = '';
        if (response?.text && typeof response.text === 'string' && response.text.trim()) {
          text = response.text.trim();
        } else {
          const parts = response?.candidates?.[0]?.content?.parts || [];
          for (const p of parts) {
            if (p.audioTranscription?.text) {
              text = p.audioTranscription.text.trim();
              break;
            }
            if (p.text && typeof p.text === 'string' && p.text.trim()) {
              text = p.text.trim();
              break;
            }
          }
        }
        text = text.replace(/^["']|["']$/g, '').trim();

        if (text && text.toUpperCase() !== 'NO_SPEECH' && text.toUpperCase() !== 'NO SPEECH') {
          const isHallucination = HALLUCINATION_PATTERNS.some(p => p.test(text));
          if (isHallucination && audioBuffer.length < 3500) {
            return { text: '', latency_ms: Date.now() - t0, is_silence: true, provider: model };
          }
          const latency_ms = Date.now() - t0;
          console.log(`[ASR][${callId}] Gemini (${model}) transcribed in ${latency_ms}ms: "${text}"`);
          return { text, latency_ms, is_silence: false, provider: model };
        }
      } catch (geminiErr) {
        console.warn(`[ASR][${callId}] Gemini ASR (${model}) error:`, geminiErr.message);
      }
    }
  }

  return { text: '', latency_ms: Date.now() - t0, is_silence: true, error: 'All ASR models exhausted' };
}
