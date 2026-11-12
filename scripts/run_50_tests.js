#!/usr/bin/env node

/**
 * Real Audio & Conversation Acceptance Test Suite
 *
 * Part 1: 20 Real 8kHz Phone-Quality WAV Recordings (10 English + 10 Hindi)
 *   - Uploads real 8000 Hz 16-bit mono PCM WAV files from /tests/recordings/{en,hi}/
 *   - Exercises: VAD -> 8kHz-to-16kHz Upsampling -> ASR -> LLM -> TTS
 *   - Computes true Word Error Rate (WER = (S + D + I) / N) via Levenshtein word edit distance
 *   - Measures and reports real per-leg latency: VAD ms, ASR ms, LLM ms, TTS ms, Total ms
 *
 * Part 2: 30 Additional Dialogue & Edge-Case Scenarios
 *   - Tests Yes/No, Busy/Callback, Angry Escalation, PBX Transfers, DNC, Silence WAV, Hinglish, Barge-In
 *   - Reported separately so audio-leg timings are never mixed with text/rule-only turns.
 */

import fs from 'fs';
import path from 'path';
import { CONFIG } from '../src/config.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (WEBHOOK_SECRET) {
    headers['X-Shared-Secret'] = WEBHOOK_SECRET;
  }
  return headers;
}

/**
 * Normalize text for standard ASR Word Error Rate (WER) calculation:
 *  - Lowercase, strip punctuation, normalize spoken numbers to digits
 */
function normalizeWordsForWer(text = '') {
  const spokenNumberMap = {
    'one hundred and two': '102',
    'one zero two': '102',
    'one oh two': '102',
    'one hundred two': '102',
    'one hundred and three': '103',
    'one zero three': '103',
    'one oh three': '103',
    'one hundred three': '103',
    'one hundred and four': '104',
    'one zero four': '104',
    'one oh four': '104',
    'one hundred four': '104',
    'one hundred and one': '101',
    'one zero one': '101',
    'one oh one': '101',
    'one hundred one': '101',
    'एक सौ दो': '102',
    'एक सौ तीन': '103',
    'एक सौ चार': '104',
    'एक सौ एक': '101'
  };

  let normalized = text.toLowerCase().trim();
  for (const [k, v] of Object.entries(spokenNumberMap)) {
    normalized = normalized.replaceAll(k, v);
  }

  // Keep alphanumeric and Devanagari characters/matras
  normalized = normalized
    .replace(/[.,?!;:"'()\[\]{}\-।]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized ? normalized.split(' ') : [];
}

/**
 * Compute word-level Levenshtein edit distance (Substitutions + Deletions + Insertions)
 */
export function computeWordEditDistance(refText, hypText) {
  const ref = normalizeWordsForWer(refText);
  const hyp = normalizeWordsForWer(hypText);
  const n = ref.length;
  const m = hyp.length;

  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // Deletion
        dp[i][j - 1] + 1,      // Insertion
        dp[i - 1][j - 1] + cost // Substitution / Match
      );
    }
  }

  const edits = dp[n][m];
  const wer = n > 0 ? edits / n : (m > 0 ? 1.0 : 0.0);
  return {
    refWords: n,
    hypWords: m,
    edits,
    wer
  };
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

const DIALOGUE_SCENARIOS = [
  // 21-25: Yes / Affirmative
  { id: 21, category: 'Yes / Affirmative', lang: 'en', campaign: 'support', text: 'Yes, please proceed with that option.', expectAction: 'speak_and_listen' },
  { id: 22, category: 'Yes / Affirmative', lang: 'en', campaign: 'support', text: 'Yeah, that works for me.', expectAction: 'speak_and_listen' },
  { id: 23, category: 'Yes / Affirmative', lang: 'hi', campaign: 'support_hi', text: 'जी हाँ, कृपया आगे बढ़ें।', expectAction: 'speak_and_listen' },
  { id: 24, category: 'Yes / Affirmative', lang: 'en', campaign: 'support', text: 'Yes correct, that is my registered mobile number.', expectAction: 'speak_and_listen' },
  { id: 25, category: 'Yes / Affirmative', lang: 'en', campaign: 'support', text: 'Definitely, I confirm.', expectAction: 'speak_and_listen' },

  // 26-30: No / Rejection & Busy / Callback
  { id: 26, category: 'No / Rejection', lang: 'en', campaign: 'support', text: 'No, I do not want to upgrade right now.', expectAction: 'speak_and_listen' },
  { id: 27, category: 'No / Rejection', lang: 'hi', campaign: 'support_hi', text: 'नहीं, मुझे अभी यह प्लान नहीं चाहिए।', expectAction: 'speak_and_listen' },
  { id: 28, category: 'Busy / Callback', lang: 'en', campaign: 'support', text: 'I am driving right now, can someone call me back later?', expectAction: 'speak_and_listen' },
  { id: 29, category: 'Busy / Callback', lang: 'hi', campaign: 'support_hi', text: 'मैं अभी मीटिंग में हूँ, कृपया शाम को कॉल करें।', expectAction: 'speak_and_listen' },
  { id: 30, category: 'Busy / Callback', lang: 'en', campaign: 'support', text: 'Please schedule a callback after 5 PM IST.', expectAction: 'speak_and_listen' },

  // 31-35: Angry / Escalation & PBX Transfers
  { id: 31, category: 'Angry / Escalation', lang: 'en', campaign: 'support', text: 'I am furious about this charge, transfer me to a manager right now!', expectAction: 'transfer', expectExt: '200' },
  { id: 32, category: 'Angry / Escalation', lang: 'en', campaign: 'support', text: 'I want to speak with a human being right now!', expectAction: 'transfer', expectExt: '101' },
  { id: 33, category: 'Transfer / Extensions', lang: 'en', campaign: 'support', text: 'Please connect me to billing to check my invoice.', expectAction: 'transfer', expectExt: '102' },
  { id: 34, category: 'Transfer / Extensions', lang: 'en', campaign: 'support', text: 'Route me to technical support extension 103.', expectAction: 'transfer', expectExt: '103' },
  { id: 35, category: 'Transfer / Extensions', lang: 'en', campaign: 'support', text: 'Connect me to sales rep extension 104.', expectAction: 'transfer', expectExt: '104' },

  // 36-40: DNC Compliance
  { id: 36, category: 'DNC Compliance', lang: 'en', campaign: 'support', text: 'Put me on your do not call list immediately.', expectAction: 'hangup' },
  { id: 37, category: 'DNC Compliance', lang: 'en', campaign: 'support', text: 'Never call this number again, unsubscribe me.', expectAction: 'hangup' },
  { id: 38, category: 'DNC Compliance', lang: 'hi', campaign: 'support_hi', text: 'मेरा नंबर अपनी कॉल लिस्ट से तुरंत हटा दीजिए।', expectAction: 'hangup' },
  { id: 39, category: 'DNC Compliance', lang: 'hi-Latn', campaign: 'support_hinglish', text: 'Bhai mujhe dobara call mat karna, number delete karo.', expectAction: 'hangup' },
  { id: 40, category: 'DNC Compliance', lang: 'en', campaign: 'support', text: 'Take me off your contact list permanently.', expectAction: 'hangup' },

  // 41-45: Silence 8kHz WAV Audio & Low-Energy Handling
  { id: 41, category: 'Silence 8kHz WAV', lang: 'en', campaign: 'support', useSilenceWav: true, expectRepeat: true },
  { id: 42, category: 'Silence 8kHz WAV', lang: 'hi', campaign: 'support_hi', useSilenceWav: true, expectRepeat: true },
  { id: 43, category: 'Silence 8kHz WAV', lang: 'hi-Latn', campaign: 'support_hinglish', useSilenceWav: true, expectRepeat: true },
  { id: 44, category: 'Gibberish / Unclear', lang: 'en', campaign: 'support', text: 'kzzzt static mumble', expectAction: 'speak_and_listen' },
  { id: 45, category: 'Gibberish / Unclear', lang: 'hi', campaign: 'support_hi', text: 'आवाज़ कट रही है हेलो', expectAction: 'speak_and_listen' },

  // 46-50: Hinglish (Roman Script Verification) & Barge-In
  { id: 46, category: 'Hinglish (Latin Script)', lang: 'hi-Latn', campaign: 'support_hinglish', text: 'Mera internet chal nahi raha hai, kya problem ho sakti hai?', expectAction: 'speak_and_listen', checkRomanScript: true },
  { id: 47, category: 'Hinglish (Latin Script)', lang: 'hi-Latn', campaign: 'support_hinglish', text: 'Bhai please mujhe billing department transfer kar do.', expectAction: 'transfer', expectExt: '102', checkRomanScript: true },
  { id: 48, category: 'Hinglish (Latin Script)', lang: 'hi-Latn', campaign: 'support_hinglish', text: 'Main bahut gussa hoon, manager se connect karo turant!', expectAction: 'transfer', expectExt: '200', checkRomanScript: true },
  { id: 49, category: 'Hinglish (Latin Script)', lang: 'hi-Latn', campaign: 'support_hinglish', text: 'Aapke monthly plans ka price kya hai?', expectAction: 'speak_and_listen', checkRomanScript: true },
  { id: 50, category: 'Barge-In & Hangup', lang: 'en', campaign: 'support', text: 'Thank you, goodbye.', expectAction: 'hangup' }
];

async function runSuite() {
  const manifestPath = path.join(CONFIG.AUDIO.RECORDINGS_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('Missing /tests/recordings/manifest.json. Run: node scripts/generate_real_audio_assets.js');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const recordings = manifest.recordings || [];

  console.log('========================================================================================');
  console.log('PART 1: REAL 8kHz PHONE AUDIO BENCHMARK (20 WAV RECORDINGS: 10 EN + 10 HI)');
  console.log(`Audio Format : ${manifest.format}`);
  console.log(`Pipeline     : 8kHz WAV Upload -> VAD -> 8kHz-to-16kHz Sinc Upsampler -> ASR -> LLM -> TTS`);
  console.log('========================================================================================\n');

  const audioLatencies = { vad: [], asr: [], llm: [], tts: [], total: [] };
  const werStats = {
    en: { refWords: 0, edits: 0, files: 0 },
    hi: { refWords: 0, edits: 0, files: 0 }
  };

  let audioPassCount = 0;

  for (let i = 0; i < recordings.length; i++) {
    const rec = recordings[i];
    const wavPath = path.join(CONFIG.AUDIO.RECORDINGS_DIR, rec.filename);
    const wavBuffer = fs.readFileSync(wavPath);
    const callId = `audio-bench-${rec.id}-${Date.now()}`;

    // 1. Start call session
    await fetch(`${BASE_URL}/api/webhook/call`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        call_id: callId,
        direction: 'inbound',
        campaign_id: rec.campaign,
        language: rec.lang,
        non_blocking_tts: true
      })
    });

    // 2. Upload real 8kHz WAV file to /api/webhook/turn
    const form = new FormData();
    form.append('call_id', callId);
    form.append('language', rec.lang);
    form.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), path.basename(rec.filename));

    const turnRes = await fetch(`${BASE_URL}/api/webhook/turn`, {
      method: 'POST',
      headers: authHeaders(),
      body: form
    });
    const turnData = await turnRes.json();

    const timing = turnData.timing_ms || { vad: 0, asr: 0, llm: 0, tts: 0, total: 0 };
    audioLatencies.vad.push(timing.vad || 0);
    audioLatencies.asr.push(timing.asr || 0);
    if (timing.llm > 0) audioLatencies.llm.push(timing.llm);
    audioLatencies.tts.push(timing.tts || 0);
    audioLatencies.total.push(timing.total || 0);

    // Compute real WER via Levenshtein word edit distance
    const dist = computeWordEditDistance(rec.referenceText, turnData.transcription || '');
    if (werStats[rec.lang]) {
      werStats[rec.lang].refWords += dist.refWords;
      werStats[rec.lang].edits += dist.edits;
      werStats[rec.lang].files += 1;
    }

    // Check expected action / transfer
    let actionOk = false;
    if (rec.expectAction === 'transfer') {
      actionOk = turnData.action === 'transfer' && (!rec.expectExt || turnData.transfer?.extension === rec.expectExt);
    } else if (rec.expectAction === 'hangup') {
      actionOk = turnData.action === 'hangup';
    } else {
      actionOk = Boolean(turnData.reply && turnData.reply.length > 4);
    }

    const hasAsrText = Boolean(turnData.transcription && turnData.transcription.trim().length > 0);
    const passed = hasAsrText && actionOk;
    if (passed) audioPassCount++;

    const statusLabel = passed ? 'PASS' : 'FAIL';
    const itemWerPct = (dist.wer * 100).toFixed(1);
    console.log(
      `[${String(i + 1).padStart(2, '0')}/20] ${statusLabel} | ${rec.filename.padEnd(28)} | ` +
      `VAD:${String(timing.vad || 0).padStart(2)}ms ASR:${String(timing.asr || 0).padStart(4)}ms ` +
      `LLM:${String(timing.llm || 0).padStart(4)}ms TTS:${String(timing.tts || 0).padStart(4)}ms Total:${String(timing.total || 0).padStart(4)}ms | ` +
      `WER:${itemWerPct.padStart(5)}% (${dist.edits}/${dist.refWords})`
    );
    console.log(`        Ref : "${rec.referenceText}"`);
    console.log(`        Hyp : "${turnData.transcription || ''}" (provider: ${turnData.providers?.asr || 'none'}, 8k->16k: ${turnData.audio_diagnostics?.resampled_8k_to_16k})`);
    console.log(`        Bot : "${(turnData.reply || '').slice(0, 90)}" [action=${turnData.action}]\n`);

    await fetch(`${BASE_URL}/api/webhook/hangup`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ call_id: callId, reason: 'test_complete' })
    });
  }

  console.log('========================================================================================');
  console.log('PART 2: 30 MULTI-CATEGORY DIALOGUE & EDGE-CASE SCENARIOS (#21 - #50)');
  console.log('========================================================================================\n');

  const silenceWavBuffer = fs.readFileSync(path.join(CONFIG.AUDIO.RECORDINGS_DIR, 'silence_8k.wav'));
  let dialoguePassCount = 0;
  const dialogueLatencies = [];

  for (const scen of DIALOGUE_SCENARIOS) {
    const callId = `scen-${scen.id}-${Date.now()}`;
    await fetch(`${BASE_URL}/api/webhook/call`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        call_id: callId,
        direction: 'inbound',
        campaign_id: scen.campaign,
        language: scen.lang,
        non_blocking_tts: true
      })
    });

    let turnData;
    if (scen.useSilenceWav) {
      const form = new FormData();
      form.append('call_id', callId);
      form.append('language', scen.lang);
      form.append('audio', new Blob([silenceWavBuffer], { type: 'audio/wav' }), 'silence_8k.wav');
      const res = await fetch(`${BASE_URL}/api/webhook/turn`, {
        method: 'POST',
        headers: authHeaders(),
        body: form
      });
      turnData = await res.json();
    } else {
      const res = await fetch(`${BASE_URL}/api/webhook/turn`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          call_id: callId,
          text: scen.text,
          language: scen.lang,
          non_blocking_tts: true
        })
      });
      turnData = await res.json();
    }

    const totalMs = turnData.timing_ms?.total || 0;
    dialogueLatencies.push(totalMs);

    let ok = false;
    if (scen.expectRepeat) {
      ok = turnData.intent === 'silence_retry' ||
        turnData.reply?.toLowerCase().includes('repeat') ||
        turnData.reply?.includes('दोहरा');
    } else if (scen.expectAction === 'transfer') {
      ok = turnData.action === 'transfer' && (!scen.expectExt || turnData.transfer?.extension === scen.expectExt);
    } else if (scen.expectAction === 'hangup') {
      ok = turnData.action === 'hangup';
    } else {
      ok = Boolean(turnData.reply && turnData.reply.length > 4);
    }

    if (ok && scen.checkRomanScript) {
      // Verify Hinglish replies contain no Devanagari script characters
      ok = !/[\u0900-\u097F]/.test(turnData.reply || '');
    }

    if (ok) dialoguePassCount++;
    console.log(
      `[${String(scen.id).padStart(2, '0')}/50] ${ok ? 'PASS' : 'FAIL'} | ${scen.category.padEnd(24)} | ` +
      `${String(totalMs).padStart(4)}ms | action=${turnData.action} | reply="${(turnData.reply || '').slice(0, 65)}"`
    );

    await fetch(`${BASE_URL}/api/webhook/hangup`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ call_id: callId, reason: 'test_complete' })
    });
  }

  const werEnPct = werStats.en.refWords > 0
    ? ((werStats.en.edits / werStats.en.refWords) * 100).toFixed(2)
    : 'N/A';
  const werHiPct = werStats.hi.refWords > 0
    ? ((werStats.hi.edits / werStats.hi.refWords) * 100).toFixed(2)
    : 'N/A';

  const totalPassed = audioPassCount + dialoguePassCount;

  console.log('\n========================================================================================');
  console.log('MEASURED BENCHMARK SUMMARY');
  console.log('========================================================================================');
  console.log(`1. Overall Pass Rate          : ${totalPassed}/50 (${audioPassCount}/20 8kHz WAV recordings + ${dialoguePassCount}/30 dialogue scenarios)`);
  console.log('----------------------------------------------------------------------------------------');
  console.log('2. Real Per-Leg Latency on 8kHz Phone Audio Recordings (n = 20 WAV files):');
  console.log(`   • VAD + 8k->16k Resample : p50 = ${percentile(audioLatencies.vad, 50)}ms | p95 = ${percentile(audioLatencies.vad, 95)}ms`);
  console.log(`   • ASR Leg (Speech->Text) : p50 = ${percentile(audioLatencies.asr, 50)}ms | p95 = ${percentile(audioLatencies.asr, 95)}ms`);
  console.log(`   • LLM Leg (Conversational): p50 = ${percentile(audioLatencies.llm, 50)}ms | p95 = ${percentile(audioLatencies.llm, 95)}ms (n = ${audioLatencies.llm.length} LLM turns)`);
  console.log(`   • TTS Leg (Text->Speech) : p50 = ${percentile(audioLatencies.tts, 50)}ms | p95 = ${percentile(audioLatencies.tts, 95)}ms`);
  console.log(`   • End-to-End Audio Turn  : p50 = ${percentile(audioLatencies.total, 50)}ms | p95 = ${percentile(audioLatencies.total, 95)}ms`);
  console.log('----------------------------------------------------------------------------------------');
  console.log('3. Measured Word Error Rate (WER = (S + D + I) / N on 8kHz Phone Recordings):');
  console.log(`   • English (en, ${werStats.en.files} files) : WER = ${werEnPct}% (${werStats.en.edits} word edits / ${werStats.en.refWords} reference words)`);
  console.log(`   • Hindi   (hi, ${werStats.hi.files} files) : WER = ${werHiPct}% (${werStats.hi.edits} word edits / ${werStats.hi.refWords} reference words)`);
  console.log('========================================================================================\n');

  if (totalPassed < 50) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Fatal test suite error:', err);
  process.exit(1);
});
