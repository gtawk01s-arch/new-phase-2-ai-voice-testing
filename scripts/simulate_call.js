#!/usr/bin/env node

/**
 * Telephony Webhook Call Simulator
 * Simulates real PBX / Dialer phone calls through the webhook contract
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function runScenario(scenarioName, turns, options = {}) {
  console.log(`\n======================================================`);
  console.log(`📞 STARTING SIMULATOR SCENARIO: ${scenarioName}`);
  console.log(`======================================================`);

  const callId = `sim-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  const t0 = Date.now();

  // 1. Answer Call
  const startRes = await fetch(`${BASE_URL}/api/webhook/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      call_id: callId,
      direction: options.direction || 'inbound',
      caller_id: '+15551234567',
      campaign_id: options.campaign_id || 'support'
    })
  });

  const startData = await startRes.json();
  console.log(`[Call Answered] Agent: "${startData.reply}" (TTS latency: ${startData.timing_ms?.tts || 0}ms)`);

  // 2. Play Turns
  for (let i = 0; i < turns.length; i++) {
    const userUtterance = turns[i];
    console.log(`\n[Turn ${i + 1}] Caller: "${userUtterance}"`);

    const turnRes = await fetch(`${BASE_URL}/api/webhook/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call_id: callId,
        text: userUtterance
      })
    });

    const turnData = await turnRes.json();
    console.log(`[Turn ${i + 1} Reply] Action: [${turnData.action}], Intent: [${turnData.intent}]`);
    console.log(`            Agent: "${turnData.reply}"`);
    console.log(`            Latency Breakdown: ASR: ${turnData.timing_ms?.asr || 0}ms | LLM: ${turnData.timing_ms?.llm || 0}ms | TTS: ${turnData.timing_ms?.tts || 0}ms | Total: ${turnData.timing_ms?.total || 0}ms`);

    if (turnData.transfer) {
      console.log(`🔀 [CALL TRANSFERRED] Ext: ${turnData.transfer.extension} (${turnData.transfer.name} - ${turnData.transfer.department})`);
      break;
    }

    if (turnData.action === 'hangup') {
      console.log(`📴 [CALL HUNG UP] Disposition: ${turnData.disposition}`);
      break;
    }
  }

  // 3. Hangup
  const hangupRes = await fetch(`${BASE_URL}/api/webhook/hangup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call_id: callId, reason: 'scenario_completed' })
  });

  const hangupData = await hangupRes.json();
  console.log(`\n📊 [Call Concluded] Duration: ${hangupData.summary?.duration_seconds || 0}s, Disposition: ${hangupData.summary?.disposition}, p50 Latency: ${hangupData.summary?.p50_latency_ms || 0}ms, p95 Latency: ${hangupData.summary?.p95_latency_ms || 0}ms`);
}

async function main() {
  console.log('🤖 Launching Automated Telephony Webhook Simulator on', BASE_URL);

  // Scenario 1: General Knowledge
  await runScenario('General Knowledge Inquiry', [
    'What is the capital of France?',
    'What is the speed of light?'
  ]);

  // Scenario 2: Extension Transfer
  await runScenario('Billing Extension Transfer', [
    'Hello, can you transfer me to billing?'
  ]);

  // Scenario 3: Angry Caller Escalation
  await runScenario('Angry Escalation to Supervisor', [
    'This is completely unacceptable service, get me your manager right now!'
  ]);

  // Scenario 4: DNC Request
  await runScenario('Do Not Call (DNC) Compliance', [
    'Stop calling me and remove my number immediately.'
  ]);

  // Scenario 5: AI Transparency
  await runScenario('AI Identity Transparency', [
    'Are you a robot or a real person?'
  ]);

  console.log('\n✅ All simulation scenarios executed successfully!\n');
}

main().catch(err => {
  console.error('Simulator error:', err);
  process.exit(1);
});
