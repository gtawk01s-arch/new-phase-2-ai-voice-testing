import React, { useState } from 'react';
import { WebhookTurnResult } from '../types';

export const WebhookContract: React.FC = () => {
  const [inspectorResult, setInspectorResult] = useState<WebhookTurnResult | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [customText, setCustomText] = useState('');
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const scenarios = [
    {
      title: 'Scenario 1: General Knowledge',
      tag: 'General Inquiry',
      query: 'What is the speed of light in vacuum?',
      desc: 'Tests factual 1-2 sentence spoken reply under 1.5s'
    },
    {
      title: 'Scenario 2: Department Transfer',
      tag: 'Billing Transfer',
      query: 'Can you please transfer my call to the billing department?',
      desc: 'Tests routing to Extension 102 (Billing & Payments)'
    },
    {
      title: 'Scenario 3: Angry Escalation',
      tag: 'Angry Escalation',
      query: 'This service is completely unacceptable, get me your manager right now!',
      desc: 'Tests supervisor escalation to Extension 200',
      urgent: true
    },
    {
      title: 'Scenario 4: DNC Compliance',
      tag: 'DNC Compliance',
      query: 'Stop calling me and remove my phone number from your list.',
      desc: 'Tests Do Not Call (DNC) hangup disposition'
    }
  ];

  const runWebhookTest = async (queryText: string) => {
    setIsLoading(true);
    setInspectorResult(null);
    const t0 = Date.now();

    try {
      const res = await fetch('/api/webhook/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          call_id: `sim-${Date.now()}`,
          text: queryText
        })
      });

      const data = await res.json();
      setElapsedMs(Date.now() - t0);
      setInspectorResult(data);
    } catch (err: any) {
      console.error('Simulator test error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopyStatus(id);
      setTimeout(() => setCopyStatus(null), 2000);
    });
  };

  return (
    <div className="space-y-6">
      <p className="text-slate-600 text-sm sm:text-[0.95rem] leading-relaxed">
        Integrate your dialer software (Vicidial, Asterisk, FreePBX, Twilio, Plivo, Telnyx, or custom SIP media server)
        directly into this AI Call Assistant using the standardized REST endpoints and telephony webhooks below.
      </p>

      {/* Interactive Webhook Call Simulator */}
      <div className="bg-slate-50 border-2 border-blue-500 rounded-2xl p-5 sm:p-6 shadow-xs">
        <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
          <div>
            <div className="font-extrabold text-base sm:text-lg text-slate-900 flex items-center gap-2">
              <span>🧪</span> Interactive Webhook Call Simulator
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Simulate live PBX telephony turns through the /api/webhook contract with real-time latency metrics
            </p>
          </div>
          <span className="bg-blue-100 border border-blue-300 text-blue-800 text-xs font-bold px-3 py-1 rounded-full uppercase">
            Webhook Contract v1.0
          </span>
        </div>

        {/* 4 Scenario Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          {scenarios.map((sc, i) => (
            <button
              key={i}
              type="button"
              onClick={() => runWebhookTest(sc.query)}
              className="bg-white hover:bg-blue-50/50 border border-slate-300 hover:border-blue-500 rounded-xl p-3.5 text-left transition-all cursor-pointer flex flex-col gap-1.5 shadow-2xs group"
            >
              <span
                className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded w-fit ${
                  sc.urgent ? 'bg-rose-100 text-rose-800' : 'bg-blue-100 text-blue-800'
                }`}
              >
                {sc.tag}
              </span>
              <span className="font-bold text-xs sm:text-sm text-slate-800 group-hover:text-blue-700">
                "{sc.query}"
              </span>
              <span className="text-xs text-slate-500">{sc.desc}</span>
            </button>
          ))}
        </div>

        {/* Custom Input */}
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Or type any custom telephony turn to simulate webhook contract..."
            className="flex-1 bg-white border border-slate-300 rounded-xl px-3.5 py-2 text-xs sm:text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          <button
            type="button"
            onClick={() => {
              if (customText.trim()) runWebhookTest(customText.trim());
            }}
            disabled={!customText.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold px-4 py-2 rounded-xl text-xs sm:text-sm transition-all cursor-pointer"
          >
            Send Turn 🚀
          </button>
        </div>

        {/* Live Inspector Terminal */}
        <div className="bg-slate-950 text-slate-200 border border-slate-800 rounded-xl p-4 font-mono text-xs overflow-x-auto min-h-36 relative">
          {isLoading ? (
            <div className="text-amber-400 flex items-center gap-2">
              <span className="animate-spin">⏳</span> [Webhook Contract] Dispatching turn to telephony engine...
            </div>
          ) : inspectorResult ? (
            <div className="space-y-2">
              <div className="text-emerald-400 font-bold flex items-center justify-between border-b border-slate-800 pb-2">
                <span>✅ HTTP 200 OK — Turn Response ({elapsedMs}ms total roundtrip):</span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(JSON.stringify(inspectorResult, null, 2), 'inspector')}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded text-[11px] font-sans font-semibold cursor-pointer"
                >
                  {copyStatus === 'inspector' ? 'Copied!' : 'Copy JSON'}
                </button>
              </div>

              <div className="text-sky-400 font-semibold">
                Action: <span className="text-white font-normal">{inspectorResult.action}</span> | Intent:{' '}
                <span className="text-white font-normal">{inspectorResult.intent}</span> | Disposition:{' '}
                <span className="text-white font-normal">{inspectorResult.disposition}</span>
              </div>

              <div className="text-amber-300">
                Spoken Reply: <span className="text-white font-normal">"{inspectorResult.reply}"</span>
              </div>

              <div className="text-indigo-400">
                Latency Budget:{' '}
                <span className="text-white font-normal">
                  ASR: {inspectorResult.timing_ms?.asr || 0}ms | LLM: {inspectorResult.timing_ms?.llm || 0}ms | TTS:{' '}
                  {inspectorResult.timing_ms?.tts || 0}ms | Total: {inspectorResult.timing_ms?.total || 0}ms
                </span>
              </div>

              {inspectorResult.transfer && (
                <div className="text-pink-400 font-semibold bg-pink-950/40 border border-pink-800/50 p-2 rounded-lg">
                  🔀 PBX Transfer: Extension {inspectorResult.transfer.extension} ({inspectorResult.transfer.name} -{' '}
                  {inspectorResult.transfer.department}) [{inspectorResult.transfer.sip_uri}]
                </div>
              )}

              <details className="mt-3 text-slate-400 cursor-pointer">
                <summary className="font-sans font-semibold hover:text-slate-200">View Full JSON Contract</summary>
                <pre className="mt-2 text-slate-300 overflow-x-auto p-2 bg-black/40 rounded">
                  {JSON.stringify(inspectorResult, null, 2)}
                </pre>
              </details>
            </div>
          ) : (
            <div className="text-slate-500 py-6 text-center">
              Click any scenario card above or send a custom turn to inspect the live Webhook JSON Contract and latency metrics.
            </div>
          )}
        </div>
      </div>

      {/* Integration Guide & Code Snippets */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 shadow-xs space-y-4">
        <div className="font-extrabold text-base text-slate-900 flex items-center gap-2">
          <span>📖</span> Telephony Webhook API Specification
        </div>

        <div className="space-y-4">
          {/* Endpoint 1 */}
          <div className="bg-slate-950 text-slate-200 rounded-xl p-4 font-mono text-xs relative">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="bg-emerald-600 text-white font-bold px-2 py-0.5 rounded text-[10px]">POST</span>
                <span className="text-sky-400 font-bold font-mono">/api/webhook/call</span>
                <span className="text-slate-400 font-sans text-xs">— Call Answered Webhook</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  copyToClipboard(
                    `curl -X POST https://your-server.com/api/webhook/call \\\n  -H "Content-Type: application/json" \\\n  -d '{"call_id": "call-1234", "direction": "inbound", "caller_id": "+15551234567"}'`,
                    'curl-call'
                  )
                }
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded text-[11px] font-sans font-semibold cursor-pointer"
              >
                {copyStatus === 'curl-call' ? 'Copied!' : 'Copy cURL'}
              </button>
            </div>
            <pre className="text-slate-300 overflow-x-auto whitespace-pre">
{`curl -X POST https://your-server.com/api/webhook/call \\
  -H "Content-Type: application/json" \\
  -d '{"call_id": "call-1234", "direction": "inbound", "caller_id": "+15551234567"}'`}
            </pre>
          </div>

          {/* Endpoint 2 */}
          <div className="bg-slate-950 text-slate-200 rounded-xl p-4 font-mono text-xs relative">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="bg-emerald-600 text-white font-bold px-2 py-0.5 rounded text-[10px]">POST</span>
                <span className="text-sky-400 font-bold font-mono">/api/webhook/turn</span>
                <span className="text-slate-400 font-sans text-xs">— Caller Turn Webhook</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  copyToClipboard(
                    `curl -X POST https://your-server.com/api/webhook/turn \\\n  -H "Content-Type: application/json" \\\n  -d '{"call_id": "call-1234", "text": "Transfer me to Billing"}'`,
                    'curl-turn'
                  )
                }
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded text-[11px] font-sans font-semibold cursor-pointer"
              >
                {copyStatus === 'curl-turn' ? 'Copied!' : 'Copy cURL'}
              </button>
            </div>
            <pre className="text-slate-300 overflow-x-auto whitespace-pre">
{`curl -X POST https://your-server.com/api/webhook/turn \\
  -H "Content-Type: application/json" \\
  -d '{"call_id": "call-1234", "text": "Transfer me to Billing"}'`}
            </pre>
          </div>

          {/* Endpoint 3 */}
          <div className="bg-slate-950 text-slate-200 rounded-xl p-4 font-mono text-xs relative">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="bg-emerald-600 text-white font-bold px-2 py-0.5 rounded text-[10px]">POST</span>
                <span className="text-sky-400 font-bold font-mono">/api/webhook/hangup</span>
                <span className="text-slate-400 font-sans text-xs">— Call Ended & Analytics</span>
              </div>
              <button
                type="button"
                onClick={() =>
                  copyToClipboard(
                    `curl -X POST https://your-server.com/api/webhook/hangup \\\n  -H "Content-Type: application/json" \\\n  -d '{"call_id": "call-1234", "reason": "normal_clearing"}'`,
                    'curl-hangup'
                  )
                }
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded text-[11px] font-sans font-semibold cursor-pointer"
              >
                {copyStatus === 'curl-hangup' ? 'Copied!' : 'Copy cURL'}
              </button>
            </div>
            <pre className="text-slate-300 overflow-x-auto whitespace-pre">
{`curl -X POST https://your-server.com/api/webhook/hangup \\
  -H "Content-Type: application/json" \\
  -d '{"call_id": "call-1234", "reason": "normal_clearing"}'`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
