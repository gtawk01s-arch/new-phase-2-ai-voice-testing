import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import Groq from 'groq-sdk';
import { CONFIG, CHAOS_STATE, isChaosAllowed, getLanguage } from './config.js';

// Provider metrics, cooldown timestamps, and rate limit counters
const providerCounters = {
  vllm_primary: { requests: 0, successes: 0, failures: 0, cooldown_until: 0 },
  vllm_small_backup: { requests: 0, successes: 0, failures: 0, cooldown_until: 0 },
  gemini: { requests: 0, successes: 0, failures: 0, rate_limited: 0, cooldown_until: 0 },
  groq: { requests: 0, successes: 0, failures: 0, rate_limited: 0, cooldown_until: 0 },
  openrouter: { requests: 0, successes: 0, failures: 0, rate_limited: 0, cooldown_until: 0 },
  fallback: { requests: 0, successes: 0 }
};

// 30-second cooldown timestamps (never disabled forever; automatically retries after cooldown)
let vllmPrimaryCooldownUntil = 0;
let vllmBackupCooldownUntil = 0;
let geminiCooldownUntil = 0;
let groqCooldownUntil = 0;
let openRouterCooldownUntil = 0;

let cachedGeminiClient = null;
let cachedGeminiKey = '';

function getGeminiClient(apiKey) {
  if (!cachedGeminiClient || cachedGeminiKey !== apiKey) {
    cachedGeminiKey = apiKey;
    cachedGeminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  }
  return cachedGeminiClient;
}

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
 * 1. Gemini Provider Adapter (with 30s cooldown & automatic retry)
 */
async function callGemini(messages, systemInstruction, timeoutMs, callId) {
  const chaosActive = isChaosAllowed();
  if (chaosActive && (CHAOS_STATE.simulateLlmFail || CHAOS_STATE.forceProvider === 'all_down' || CHAOS_STATE.forceProvider === 'groq' || CHAOS_STATE.forceProvider === 'openrouter')) {
    throw new Error('Gemini bypassed via chaos control');
  }

  const geminiKey = CONFIG.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('No Gemini API key configured');

  if (Date.now() < geminiCooldownUntil) {
    throw new Error(`Gemini in cooldown until ${new Date(geminiCooldownUntil).toISOString()}`);
  }

  const ai = getGeminiClient(geminiKey);
  const contents = formatForGemini(messages);

  for (const model of CONFIG.GEMINI_MODELS) {
    providerCounters.gemini.requests++;
    const t0 = Date.now();
    try {
      const thinkingLevel = model.includes('3.8') ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL;
      const modelConfig = {
        systemInstruction,
        temperature: 0.4,
        thinkingConfig: { thinkingLevel }
      };

      const perModelTimeout = Math.min(timeoutMs, 2800);
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents,
          config: modelConfig
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${perModelTimeout}ms)`)), perModelTimeout))
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
      if (err.status === 429 || err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) {
        providerCounters.gemini.rate_limited++;
        geminiCooldownUntil = Date.now() + CONFIG.PROVIDER_COOLDOWN_MS;
        providerCounters.gemini.cooldown_until = geminiCooldownUntil;
        console.warn(`[LLM][${callId}] Gemini (${model}) rate-limited (429) in ${Date.now() - t0}ms -> entering ${CONFIG.PROVIDER_COOLDOWN_MS / 1000}s cooldown & failing over immediately`);
        break;
      }
      console.warn(`[LLM][${callId}] Gemini (${model}) failed in ${Date.now() - t0}ms:`, err.message?.slice(0, 120));
    }
  }

  // All Gemini models failed: set 30-second cooldown before automatic retry
  geminiCooldownUntil = Date.now() + CONFIG.PROVIDER_COOLDOWN_MS;
  providerCounters.gemini.cooldown_until = geminiCooldownUntil;
  throw new Error(`Gemini models exhausted (entering ${CONFIG.PROVIDER_COOLDOWN_MS / 1000}s cooldown)`);
}

/**
 * 2. Groq Provider Adapter (with 30s cooldown & automatic retry)
 */
async function callGroq(messages, systemInstruction, timeoutMs, callId) {
  const chaosActive = isChaosAllowed();
  if (chaosActive && (CHAOS_STATE.simulateLlmFail || CHAOS_STATE.forceProvider === 'all_down' || CHAOS_STATE.forceProvider === 'gemini' || CHAOS_STATE.forceProvider === 'openrouter')) {
    throw new Error('Groq bypassed via chaos control');
  }

  if (!CONFIG.GROQ_API_KEY) {
    throw new Error('Groq API key not configured');
  }

  if (Date.now() < groqCooldownUntil) {
    throw new Error(`Groq in cooldown until ${new Date(groqCooldownUntil).toISOString()}`);
  }

  const groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
  const groqMessages = [
    { role: 'system', content: systemInstruction },
    ...messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({
      role: m.role,
      content: m.content
    }))
  ];

  const groqTimeout = Math.min(timeoutMs, 2400);
  for (const model of CONFIG.GROQ_MODELS) {
    providerCounters.groq.requests++;
    const t0 = Date.now();
    try {
      const completion = await Promise.race([
        groq.chat.completions.create({
          model,
          messages: groqMessages,
          temperature: 0.5,
          max_tokens: 350
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${groqTimeout}ms)`)), groqTimeout))
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
      providerCounters.groq.last_error = `${model}: ${err.message}`;
      if (err.status === 429 || err.message?.includes('429')) {
        providerCounters.groq.rate_limited++;
      }
      console.warn(`[LLM][${callId}] Groq (${model}) failed in ${Date.now() - t0}ms:`, err.message);
      if (err.status === 401 || err.message?.includes('401')) {
        break;
      }
    }
  }

  // Cooldown for 30s, then automatically retry
  groqCooldownUntil = Date.now() + CONFIG.PROVIDER_COOLDOWN_MS;
  providerCounters.groq.cooldown_until = groqCooldownUntil;
  throw new Error('All Groq models exhausted (entering 30s cooldown)');
}

/**
 * 3. OpenRouter Provider Adapter (3rd LLM Fallback with 30s cooldown & automatic retry)
 */
async function callOpenRouter(messages, systemInstruction, timeoutMs, callId) {
  const chaosActive = isChaosAllowed();
  if (chaosActive && (CHAOS_STATE.simulateLlmFail || CHAOS_STATE.forceProvider === 'all_down' || CHAOS_STATE.forceProvider === 'gemini' || CHAOS_STATE.forceProvider === 'groq')) {
    throw new Error('OpenRouter bypassed via chaos control');
  }

  if (!CONFIG.OPENROUTER_API_KEY) {
    throw new Error('OpenRouter API key not configured');
  }

  if (Date.now() < openRouterCooldownUntil) {
    throw new Error(`OpenRouter in cooldown until ${new Date(openRouterCooldownUntil).toISOString()}`);
  }

  const orMessages = [
    { role: 'system', content: systemInstruction },
    ...messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({
      role: m.role,
      content: m.content
    }))
  ];

  const orTimeout = Math.min(timeoutMs, 2800);
  for (const model of CONFIG.OPENROUTER_MODELS) {
    providerCounters.openrouter.requests++;
    const t0 = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), orTimeout);
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'AI Telephony PBX Engine'
        },
        body: JSON.stringify({
          model,
          messages: orMessages,
          temperature: 0.5,
          max_tokens: 220
        }),
        signal: controller.signal
      }).finally(() => clearTimeout(timer));

      if (!res.ok) {
        if (res.status === 429) providerCounters.openrouter.rate_limited++;
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const text = (data?.choices?.[0]?.message?.content || '').trim();
      if (text) {
        providerCounters.openrouter.successes++;
        return {
          content: text,
          provider: `openrouter/${model}`,
          latency_ms: Date.now() - t0
        };
      }
    } catch (err) {
      providerCounters.openrouter.failures++;
      providerCounters.openrouter.last_error = `${model}: ${err.message}`;
      console.warn(`[LLM][${callId}] OpenRouter (${model}) failed in ${Date.now() - t0}ms:`, err.message);
      if (err.message?.includes('401')) break;
    }
  }

  openRouterCooldownUntil = Date.now() + CONFIG.PROVIDER_COOLDOWN_MS;
  providerCounters.openrouter.cooldown_until = openRouterCooldownUntil;
  throw new Error('All OpenRouter models exhausted (entering 30s cooldown)');
}

/**
 * 0A. Sovereign GPU Primary Adapter: Fine-tuned 7-8B Open Model on vLLM (Guideline 1, 5, 8)
 */
async function callSelfHostedVllm(messages, systemInstruction, timeoutMs, callId) {
  const chaosActive = isChaosAllowed();
  if (chaosActive && (CHAOS_STATE.simulateLlmFail || CHAOS_STATE.forceProvider === 'all_down')) {
    throw new Error('vLLM Primary bypassed via chaos control');
  }
  if (!process.env.SELF_HOSTED_VLLM_URL && !CONFIG.SOVEREIGN_GPU?.DISABLE_EXTERNAL_APIS) {
    throw new Error('SELF_HOSTED_VLLM_URL not active in preview');
  }
  if (Date.now() < vllmPrimaryCooldownUntil) {
    throw new Error('vLLM Primary in cooldown');
  }

  providerCounters.vllm_primary.requests++;
  const t0 = Date.now();
  const endpoint = CONFIG.SOVEREIGN_GPU.SELF_HOSTED_VLLM_URL;
  const model = CONFIG.SOVEREIGN_GPU.PRIMARY_LLM_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 1200));
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          ...messages.filter(m => m.role === 'user' || m.role === 'assistant')
        ],
        temperature: 0.3,
        max_tokens: 160
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`vLLM HTTP ${res.status}`);
    const data = await res.json();
    const text = (data?.choices?.[0]?.message?.content || '').trim();
    if (text) {
      providerCounters.vllm_primary.successes++;
      return {
        content: text,
        provider: `self-hosted-vllm/${model}`,
        latency_ms: Date.now() - t0
      };
    }
    throw new Error('Empty vLLM response');
  } catch (err) {
    providerCounters.vllm_primary.failures++;
    vllmPrimaryCooldownUntil = Date.now() + 10000;
    providerCounters.vllm_primary.cooldown_until = vllmPrimaryCooldownUntil;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 0B. Sovereign GPU In-House Backup Adapter: Smaller 3B Open Model on Secondary GPU (Guideline 12)
 */
async function callSelfHostedSmallBackupLlm(messages, systemInstruction, timeoutMs, callId) {
  const chaosActive = isChaosAllowed();
  if (chaosActive && (CHAOS_STATE.simulateLlmFail || CHAOS_STATE.forceProvider === 'all_down')) {
    throw new Error('vLLM Small Backup bypassed via chaos control');
  }
  if (!process.env.SELF_HOSTED_SMALL_LLM_URL && !CONFIG.SOVEREIGN_GPU?.DISABLE_EXTERNAL_APIS) {
    throw new Error('SELF_HOSTED_SMALL_LLM_URL not active in preview');
  }
  if (Date.now() < vllmBackupCooldownUntil) {
    throw new Error('vLLM Small Backup in cooldown');
  }

  providerCounters.vllm_small_backup.requests++;
  const t0 = Date.now();
  const endpoint = CONFIG.SOVEREIGN_GPU.SELF_HOSTED_SMALL_LLM_URL;
  const model = CONFIG.SOVEREIGN_GPU.BACKUP_SMALL_LLM_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 900));
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          ...messages.filter(m => m.role === 'user' || m.role === 'assistant')
        ],
        temperature: 0.2,
        max_tokens: 120
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`vLLM Backup HTTP ${res.status}`);
    const data = await res.json();
    const text = (data?.choices?.[0]?.message?.content || '').trim();
    if (text) {
      providerCounters.vllm_small_backup.successes++;
      return {
        content: text,
        provider: `self-hosted-backup/${model}`,
        latency_ms: Date.now() - t0
      };
    }
    throw new Error('Empty vLLM backup response');
  } catch (err) {
    providerCounters.vllm_small_backup.failures++;
    vllmBackupCooldownUntil = Date.now() + 10000;
    providerCounters.vllm_small_backup.cooldown_until = vllmBackupCooldownUntil;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unified generate interface:
 * - Sovereign GPU Path (Guideline 1, 5, 12): Primary 7B vLLM -> In-House 3B Backup vLLM -> Scripted Pre-Recorded Line + Human Transfer
 * - Temporary External API Bridge (until Sunset Date 2026-12-31 when DISABLE_EXTERNAL_APIS=false): Gemini -> Groq -> OpenRouter
 */
export async function generate(messages, options = {}) {
  const {
    systemInstruction = 'You are an AI voice phone agent. Answer in 1-2 spoken sentences.',
    timeoutMs = CONFIG.TIMEOUTS.LLM_PER_PROVIDER,
    callId = 'turn',
    language = 'en'
  } = options;

  // 0A. Primary Sovereign GPU: 7-8B Fine-Tuned Model on vLLM
  try {
    return await callSelfHostedVllm(messages, systemInstruction, timeoutMs, callId);
  } catch (_) {}

  // 0B. Secondary Sovereign GPU: Smaller 3B In-House Backup Model
  try {
    return await callSelfHostedSmallBackupLlm(messages, systemInstruction, timeoutMs, callId);
  } catch (_) {}

  // Temporary External APIs (ONLY allowed before Sunset Date 2026-12-31 when DISABLE_EXTERNAL_APIS is false)
  if (!CONFIG.SOVEREIGN_GPU?.DISABLE_EXTERNAL_APIS) {
    // 1. Primary External Bridge: Gemini
    try {
      return await callGemini(messages, systemInstruction, timeoutMs, callId);
    } catch (geminiErr) {
      console.warn(`[LLM][${callId}] Primary (Gemini) unavailable:`, geminiErr.message);
    }

    // 2. Secondary External Bridge: Groq
    try {
      return await callGroq(messages, systemInstruction, timeoutMs, callId);
    } catch (groqErr) {
      console.warn(`[LLM][${callId}] Secondary (Groq) unavailable:`, groqErr.message);
    }

    // 3. Tertiary External Bridge: OpenRouter
    try {
      return await callOpenRouter(messages, systemInstruction, timeoutMs, callId);
    } catch (orErr) {
      console.warn(`[LLM][${callId}] Tertiary (OpenRouter) unavailable:`, orErr.message);
    }
  } else {
    console.warn(`[LLM][${callId}] DISABLE_EXTERNAL_APIS=true (Sovereign GPU Mode): Skipping all third-party LLM APIs`);
  }

  // 4. All In-House & Bridge LLMs failed: say one scripted pre-recorded line and transfer to a human (Guideline 12)
  providerCounters.fallback.requests++;
  providerCounters.fallback.successes++;

  const langConfig = getLanguage(language);
  const scriptedOutageReply = langConfig.llmFallback ||
    'I apologize, our automated system is experiencing a technical issue. Let me transfer you directly to a specialist for immediate assistance. Please stay on the line.';

  console.warn(`[LLM][${callId}] ALL LLMs DOWN: Returning single scripted outage line and transferring call`);

  return {
    content: scriptedOutageReply,
    isLlmOutage: true,
    action: 'transfer',
    provider: 'local/emergency-scripted-transfer',
    latency_ms: 1
  };
}

export function resetProviderCooldowns() {
  vllmPrimaryCooldownUntil = 0;
  vllmBackupCooldownUntil = 0;
  geminiCooldownUntil = 0;
  groqCooldownUntil = 0;
  openRouterCooldownUntil = 0;
  providerCounters.vllm_primary.cooldown_until = 0;
  providerCounters.vllm_small_backup.cooldown_until = 0;
  providerCounters.gemini.cooldown_until = 0;
  providerCounters.groq.cooldown_until = 0;
  providerCounters.openrouter.cooldown_until = 0;
}

export function getProviderCounters() {
  return { ...providerCounters };
}
