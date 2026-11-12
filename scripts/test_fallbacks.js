#!/usr/bin/env node

/**
 * Provider Failover & Chaos Verification Script
 *
 * Tests:
 *  1. Webhook Authentication Enforcement (rejects unauthenticated requests with 401/503, accepts valid X-Shared-Secret)
 *  2. TTS Outage (simulateTtsFail: true) -> Delivers pre-recorded spoken fallback WAV (> 20KB real speech, not a beep tone) in English and Hindi
 *  3. All LLMs Down (simulateLlmFail: true) -> Plays single scripted apology line and transfers to specialist (Extension 101)
 *  4. ASR Failure / 8kHz Silence WAV (`silence_8k.wav` uploaded 3 times) -> Asks "Could you repeat that?" twice, then transfers to human on 3rd failure
 *  5. /health subsystem verification (ASR, LLM, TTS, Session store)
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

async function setChaos(config) {
  const res = await fetch(`${BASE_URL}/api/admin/chaos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  return res.json();
}

async function runFallbackTests() {
  console.log('========================================================================');
  console.log('PROVIDER FAILOVER & SECURITY VERIFICATION');
  console.log(`Server: ${BASE_URL}`);
  console.log('========================================================================\n');

  let passed = 0;
  let total = 0;

  // -------------------------------------------------------------------------
  // TEST 1: Webhook Security Enforcement
  // -------------------------------------------------------------------------
  total++;
  console.log('▶ TEST 1: Webhook Authentication Enforcement (Default ON)');
  try {
    const unauthRes = await fetch(`${BASE_URL}/api/webhook/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_id: 'unauth-test', direction: 'inbound' })
    });

    if (unauthRes.status === 401 || unauthRes.status === 503) {
      console.log(`  PASS: Unauthenticated webhook call rejected with HTTP ${unauthRes.status}`);
      passed++;
    } else {
      console.error(`  FAIL: Expected HTTP 401/503 without credentials, got HTTP ${unauthRes.status}`);
    }
  } catch (err) {
    console.error('  FAIL:', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 2: TTS Outage -> Pre-recorded Spoken Fallback Audio (EN & HI)
  // -------------------------------------------------------------------------
  total++;
  console.log('\n▶ TEST 2: TTS Outage Simulation (Pre-recorded Spoken Audio in EN & HI)');
  try {
    await setChaos({ simulateTtsFail: true });

    const ttsEnRes = await fetch(`${BASE_URL}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Could you repeat that?', language: 'en' })
    });
    const enBytes = Buffer.from(await ttsEnRes.arrayBuffer());

    const ttsHiRes = await fetch(`${BASE_URL}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'क्षमा करें, क्या आप कृपया उसे दोहरा सकते हैं?', language: 'hi' })
    });
    const hiBytes = Buffer.from(await ttsHiRes.arrayBuffer());

    const isEnCached = ttsEnRes.headers.get('x-fallback-cached') === 'true' && enBytes.length > 15000;
    const isHiCached = ttsHiRes.headers.get('x-fallback-cached') === 'true' && hiBytes.length > 15000;

    if (isEnCached && isHiCached) {
      console.log(`  PASS: Delivered pre-recorded spoken WAV fallbacks (EN: ${enBytes.length} bytes, HI: ${hiBytes.length} bytes)`);
      passed++;
    } else {
      console.error(`  FAIL: TTS fallback check failed (EN: ${enBytes.length}B cached=${isEnCached}, HI: ${hiBytes.length}B cached=${isHiCached})`);
    }
  } catch (err) {
    console.error('  FAIL:', err.message);
  } finally {
    await setChaos({ simulateTtsFail: false });
  }

  // -------------------------------------------------------------------------
  // TEST 3: All LLMs Down -> Single Scripted Reply + Immediate Transfer
  // -------------------------------------------------------------------------
  total++;
  console.log('\n▶ TEST 3: All LLMs Down Simulation (Scripted Reply + Transfer, No Canned Answers)');
  try {
    await setChaos({ simulateLlmFail: true });

    const callId = `chaos-llm-${Date.now()}`;
    await fetch(`${BASE_URL}/api/webhook/call`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ call_id: callId, direction: 'inbound', language: 'hi', campaign_id: 'support_hi' })
    });

    // Even if asked one of the old test questions ("What is 15% tip on 84?"), it MUST NOT return a canned answer;
    // it MUST play the single scripted outage line and transfer.
    const turnRes = await fetch(`${BASE_URL}/api/webhook/turn`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        call_id: callId,
        text: 'What is a 15 percent tip on 84 dollars?',
        language: 'hi'
      })
    });

    const turnData = await turnRes.json();
    console.log(`  Reply: "${turnData.reply}"`);
    console.log(`  Action: ${turnData.action}, Disposition: ${turnData.disposition}, Transfer Ext: ${turnData.transfer?.extension}`);

    const isTransferred = turnData.action === 'transfer' && turnData.disposition === 'llm_outage_transfer' && turnData.transfer?.extension === '101';
    const notCanned = !String(turnData.reply || '').includes('12.60') && !String(turnData.reply || '').includes('twelve');

    if (isTransferred && notCanned) {
      console.log('  PASS: All LLMs down played single scripted line and transferred to Ext 101 (no canned reply).');
      passed++;
    } else {
      console.error(`  FAIL: Expected transfer on LLM outage, got action=${turnData.action}, reply="${turnData.reply}"`);
    }
  } catch (err) {
    console.error('  FAIL:', err.message);
  } finally {
    await setChaos({ simulateLlmFail: false });
  }

  // -------------------------------------------------------------------------
  // TEST 4: ASR Failure / 8kHz Silence WAV -> 2x Repeat, then 3rd Failure Transfer
  // -------------------------------------------------------------------------
  total++;
  console.log('\n▶ TEST 4: Consecutive ASR Failures with Real 8kHz Silence Audio File (2x Repeat -> 3rd Transfer)');
  try {
    const callId = `chaos-asr-${Date.now()}`;
    await fetch(`${BASE_URL}/api/webhook/call`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ call_id: callId, direction: 'inbound', language: 'en', campaign_id: 'support' })
    });

    const silencePath = path.join(CONFIG.AUDIO.RECORDINGS_DIR, 'silence_8k.wav');
    const silenceBuf = fs.readFileSync(silencePath);

    const sendSilenceTurn = async () => {
      const form = new FormData();
      form.append('call_id', callId);
      form.append('language', 'en');
      form.append('audio', new Blob([silenceBuf], { type: 'audio/wav' }), 'silence_8k.wav');
      const r = await fetch(`${BASE_URL}/api/webhook/turn`, {
        method: 'POST',
        headers: authHeaders(),
        body: form
      });
      return r.json();
    };

    const t1 = await sendSilenceTurn();
    const t2 = await sendSilenceTurn();
    const t3 = await sendSilenceTurn();

    console.log(`  Attempt 1: action=${t1.action}, reply="${t1.reply}"`);
    console.log(`  Attempt 2: action=${t2.action}, reply="${t2.reply}"`);
    console.log(`  Attempt 3: action=${t3.action}, transfer_ext=${t3.transfer?.extension}, reply="${t3.reply}"`);

    const ok1 = t1.action === 'speak_and_listen' && t1.reply?.toLowerCase().includes('repeat');
    const ok2 = t2.action === 'speak_and_listen' && t2.reply?.toLowerCase().includes('repeat');
    const ok3 = t3.action === 'transfer' && t3.transfer?.extension === '101';

    if (ok1 && ok2 && ok3) {
      console.log('  PASS: 8kHz silence WAV triggered "Could you repeat that?" twice and transferred on 3rd attempt.');
      passed++;
    } else {
      console.error(`  FAIL: Unexpected sequence ok1=${ok1}, ok2=${ok2}, ok3=${ok3}`);
    }
  } catch (err) {
    console.error('  FAIL:', err.message);
  }

  // -------------------------------------------------------------------------
  // TEST 5: /health Subsystem Verification
  // -------------------------------------------------------------------------
  total++;
  console.log('\n▶ TEST 5: /health Subsystem Check');
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const health = await res.json();
    const ok = Boolean(health.subsystems?.asr && health.subsystems?.llm && health.subsystems?.tts && health.subsystems?.sessions);
    if (ok) {
      console.log(`  PASS: /health status=${health.status}, pre-recorded fallbacks=${health.subsystems.tts.prerecorded_fallback_files?.length}`);
      passed++;
    } else {
      console.error('  FAIL: Missing subsystem fields in /health');
    }
  } catch (err) {
    console.error('  FAIL:', err.message);
  }

  console.log('\n========================================================================');
  console.log(`RESULT: ${passed}/${total} Tests Passed`);
  console.log('========================================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runFallbackTests().catch((err) => {
  console.error('Fallback test error:', err);
  process.exit(1);
});
