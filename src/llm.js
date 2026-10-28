import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import { CONFIG, CHAOS_STATE, getLanguage } from './config.js';

// Provider metrics and rate limits
const providerCounters = {
  gemini: { requests: 0, successes: 0, failures: 0, rate_limited: 0 },
  groq: { requests: 0, successes: 0, failures: 0, rate_limited: 0 },
  fallback: { requests: 0, successes: 0 }
};

let groqDisabledPermanently = false;

/**
 * Format conversation turns for Gemini (alternating user and model roles)
 */
function formatForGemini(messages) {
  const cleanTurns = [];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const lastTurn = cleanTurns[cleanTurns.length - 1];
    if (lastTurn && lastTurn.role === role) {
      lastTurn.parts[0].text += ' ' + msg.content;
    } else {
      cleanTurns.push({ role, parts: [{ text: msg.content }] });
    }
  }

  while (cleanTurns.length > 0 && cleanTurns[0].role !== 'user') {
    cleanTurns.shift();
  }

  if (cleanTurns.length === 0) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    cleanTurns.push({ role: 'user', parts: [{ text: lastUser?.content || 'Hello' }] });
  }

  return cleanTurns;
}

/**
 * Gemini Provider Adapter
 */
async function callGemini(messages, systemInstruction, timeoutMs, callId) {
  if (CHAOS_STATE.simulateLlmFail || CHAOS_STATE.forceProvider === 'all_down' || CHAOS_STATE.forceProvider === 'groq') {
    throw new Error('Gemini bypassed or simulated failure');
  }

  const geminiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || CONFIG.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('No Gemini API key available');

  const ai = new GoogleGenAI({
    apiKey: geminiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
  const contents = formatForGemini(messages);

  for (const model of CONFIG.GEMINI_MODELS) {
    providerCounters.gemini.requests++;
    const t0 = Date.now();
    try {
      const modelConfig = {
        systemInstruction,
        temperature: 0.7
      };

      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents,
          config: modelConfig
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms)`)), Math.min(timeoutMs, 2200)))
      ]);

      const text = (response.text || '').trim();
      if (text) {
        providerCounters.gemini.successes++;
        return {
          content: text,
          provider: `gemini/${model}`,
          latency_ms: Date.now() - t0
        };
      }
    } catch (err) {
      providerCounters.gemini.failures++;
      providerCounters.gemini.last_error = `${model}: ${err.message}`;
      if (err.status === 429 || err.message?.includes('429')) {
        providerCounters.gemini.rate_limited++;
      }
      console.warn(`[LLM][${callId}] Gemini (${model}) failed in ${Date.now() - t0}ms:`, err.message);
    }
  }

  throw new Error('All Gemini models exhausted');
}

/**
 * Groq Provider Adapter
 */
async function callGroq(messages, systemInstruction, timeoutMs, callId) {
  if (CHAOS_STATE.simulateLlmFail || CHAOS_STATE.forceProvider === 'all_down' || CHAOS_STATE.forceProvider === 'gemini') {
    throw new Error('Groq bypassed or simulated failure');
  }

  if (groqDisabledPermanently || !CONFIG.GROQ_API_KEY || !CONFIG.GROQ_API_KEY.startsWith('gsk_')) {
    throw new Error('Groq disabled or invalid key');
  }

  const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
  const groqMessages = [
    { role: 'system', content: systemInstruction },
    ...messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({
      role: m.role,
      content: m.content
    }))
  ];

  for (const model of CONFIG.GROQ_MODELS) {
    providerCounters.groq.requests++;
    const t0 = Date.now();
    try {
      const completion = await Promise.race([
        groq.chat.completions.create({
          model,
          messages: groqMessages,
          temperature: 0.6,
          max_tokens: 350
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms)`)), timeoutMs))
      ]);

      const text = (completion.choices[0]?.message?.content || '').trim();
      if (text) {
        providerCounters.groq.successes++;
        return {
          content: text,
          provider: `groq/${model}`,
          latency_ms: Date.now() - t0
        };
      }
    } catch (err) {
      providerCounters.groq.failures++;
      if (err.status === 401 || err.message?.includes('401')) {
        groqDisabledPermanently = true;
        throw new Error('Groq 401 unauthorized');
      }
      if (err.status === 429 || err.message?.includes('429')) {
        providerCounters.groq.rate_limited++;
      }
      console.warn(`[LLM][${callId}] Groq (${model}) failed in ${Date.now() - t0}ms:`, err.message);
    }
  }

  throw new Error('All Groq models exhausted');
}

/**
 * Unified generate interface with automatic multi-provider fallback
 * Rule: "All LLMs down: scripted reply, then transfer."
 */
export async function generate(messages, options = {}) {
  const {
    systemInstruction = 'You are an AI voice phone agent. Answer in 1-2 spoken sentences.',
    timeoutMs = CONFIG.TIMEOUTS.LLM_PER_PROVIDER,
    callId = 'turn',
    language = 'en'
  } = options;

  // 1. Try Gemini first if key available and not in chaos mode
  if (CONFIG.GEMINI_API_KEY && !CHAOS_STATE.simulateLlmFail && CHAOS_STATE.forceProvider !== 'groq') {
    try {
      return await callGemini(messages, systemInstruction, timeoutMs, callId);
    } catch (geminiErr) {
      console.warn(`[LLM][${callId}] Gemini primary failed, falling back to secondary:`, geminiErr.message);
    }
  }

  // 2. Try Groq fallback
  if (!CHAOS_STATE.simulateLlmFail && CHAOS_STATE.forceProvider !== 'gemini') {
    try {
      return await callGroq(messages, systemInstruction, timeoutMs, callId);
    } catch (groqErr) {
      console.warn(`[LLM][${callId}] Groq fallback failed:`, groqErr.message);
    }
  }

  // 3. All LLMs down: scripted reply, then transfer (Per Phase 2 Task 8 Rule)
  providerCounters.fallback.requests++;
  providerCounters.fallback.successes++;

  const langConfig = getLanguage(language);
  const scriptedOutageReply = langConfig.llmFallback ||
    'I apologize, our automated system is currently experiencing technical difficulties. Let me transfer you directly to a specialist for immediate assistance. Please stay on the line.';

  console.warn(`[LLM][${callId}] ⚠️ ALL LLMs DOWN: Triggering scripted outage reply & emergency human transfer`);

  return {
    content: JSON.stringify({
      reply: scriptedOutageReply,
      intent: 'llm_outage_fallback',
      action: 'transfer',
      disposition: 'llm_outage_transfer',
      confidence: 1.0
    }),
    isLlmOutage: true,
    action: 'transfer',
    provider: 'local/emergency-scripted-transfer',
    latency_ms: 5
  };
}

export function getProviderCounters() {
  return { ...providerCounters };
}
