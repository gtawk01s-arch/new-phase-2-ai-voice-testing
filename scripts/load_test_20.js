#!/usr/bin/env node

/**
 * 20 Concurrent Sessions Load Test
 *
 * Spawns 20 parallel call sessions with valid webhook authentication (X-Shared-Secret),
 * verifies X-Idempotency-Key replay headers, measures concurrent latencies,
 * and checks active session count after hangup.
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (WEBHOOK_SECRET) {
    headers['X-Shared-Secret'] = WEBHOOK_SECRET;
  }
  return headers;
}

async function simulateSession(index) {
  const callId = `load-sess-${index}-${Date.now()}`;
  const callerId = `+91980000${(1000 + index).toString()}`;
  const tStart = Date.now();
  const sessionLatencies = [];

  try {
    const idempotencyKey = `idem-call-${callId}`;
    const campaignId = index % 3 === 0 ? 'support_hinglish' : (index % 2 === 0 ? 'support_hi' : 'support');

    const startRes = await fetch(`${BASE_URL}/api/webhook/call`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      }),
      body: JSON.stringify({
        call_id: callId,
        direction: index % 2 === 0 ? 'inbound' : 'outbound',
        caller_id: callerId,
        campaign_id: campaignId,
        non_blocking_tts: true
      })
    });
    const startData = await startRes.json();

    // Replay same request to test idempotency
    const replayRes = await fetch(`${BASE_URL}/api/webhook/call`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      }),
      body: JSON.stringify({
        call_id: callId,
        direction: index % 2 === 0 ? 'inbound' : 'outbound',
        caller_id: callerId,
        campaign_id: campaignId,
        non_blocking_tts: true
      })
    });
    const replayData = await replayRes.json();
    const isIdempotent = replayRes.headers.get('x-idempotent-replay') === 'true' && replayData.call_id === startData.call_id;

    // Turn 1
    const tTurn1 = Date.now();
    const turn1Res = await fetch(`${BASE_URL}/api/webhook/turn`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        call_id: callId,
        text: index % 2 === 0
          ? 'कृपया मुझे बिलिंग विभाग एक्सटेंशन 102 से जोड़ें'
          : 'Please connect me to technical support on extension 103.',
        non_blocking_tts: true
      })
    });
    const turn1Data = await turn1Res.json();
    sessionLatencies.push(Date.now() - tTurn1);

    // Hangup
    const hangupRes = await fetch(`${BASE_URL}/api/webhook/hangup`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        call_id: callId,
        reason: 'caller_hangup'
      })
    });
    const hangupData = await hangupRes.json();

    const totalDuration = Date.now() - tStart;
    const ok = Boolean(turn1Data.reply && hangupData.status === 'closed');
    return {
      index,
      callId,
      success: ok,
      isIdempotent,
      durationMs: totalDuration,
      latencies: sessionLatencies,
      error: ok ? null : `status=${turn1Res.status} err=${turn1Data.error || 'missing reply'}`
    };
  } catch (err) {
    return {
      index,
      callId,
      success: false,
      error: err.message,
      latencies: []
    };
  }
}

function calculatePercentile(array, p) {
  if (array.length === 0) return 0;
  const sorted = [...array].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function runLoadTest() {
  const CONCURRENCY = 20;
  console.log('========================================================================');
  console.log(`20 CONCURRENT SESSIONS LOAD TEST (Server: ${BASE_URL})`);
  console.log('========================================================================\n');

  const tStartAll = Date.now();
  const promises = [];
  for (let i = 1; i <= CONCURRENCY; i++) {
    promises.push(simulateSession(i));
  }

  const results = await Promise.all(promises);
  const totalWallTime = Date.now() - tStartAll;

  let successfulSessions = 0;
  const allLatencies = [];
  let idempotencySuccessCount = 0;

  for (const res of results) {
    if (res.success) {
      successfulSessions++;
      allLatencies.push(...res.latencies);
      if (res.isIdempotent) idempotencySuccessCount++;
      console.log(`  Session ${res.index.toString().padStart(2, '0')}: PASS (${res.durationMs}ms, idempotent=${res.isIdempotent})`);
    } else {
      console.error(`  Session ${res.index.toString().padStart(2, '0')}: FAIL (${res.error})`);
    }
  }

  const p50 = calculatePercentile(allLatencies, 50);
  const p90 = calculatePercentile(allLatencies, 90);
  const p95 = calculatePercentile(allLatencies, 95);

  const healthRes = await fetch(`${BASE_URL}/health`);
  const healthData = await healthRes.json();

  console.log('\n========================================================================');
  console.log('LOAD TEST MEASURED RESULTS');
  console.log(`  Completed Sessions     : ${successfulSessions}/${CONCURRENCY}`);
  console.log(`  Wall Clock Duration    : ${totalWallTime}ms`);
  console.log(`  Idempotent Retries     : ${idempotencySuccessCount}/${CONCURRENCY}`);
  console.log(`  Turn Latencies         : p50 = ${p50}ms | p90 = ${p90}ms | p95 = ${p95}ms`);
  console.log(`  Active Sessions After  : ${healthData.subsystems?.sessions?.active ?? 0}`);
  console.log('========================================================================\n');

  if (successfulSessions !== CONCURRENCY) {
    process.exit(1);
  }
}

runLoadTest().catch((err) => {
  console.error('Load test runner failed:', err);
  process.exit(1);
});
