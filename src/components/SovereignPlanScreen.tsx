import React, { useEffect, useState } from 'react';

interface SovereignOverview {
  sovereign_gpu: {
    SELF_HOSTED_ASR_URL: string;
    SELF_HOSTED_VLLM_URL: string;
    SELF_HOSTED_SMALL_LLM_URL: string;
    SELF_HOSTED_TTS_URL: string;
    PRIMARY_ASR_MODEL: string;
    PRIMARY_LLM_MODEL: string;
    BACKUP_SMALL_LLM_MODEL: string;
    PRIMARY_TTS_MODEL: string;
    EXTERNAL_API_SUNSET_DATE: string;
    disable_external_apis: boolean;
    days_until_external_api_sunset: number;
    STREAMING_PIPELINE: {
      enabled: boolean;
      targetFirstAudioMs: number;
      hardSlaCeilingMs: number;
      transport: string;
    };
  };
  stage_budgets_ms: {
    vad: number;
    asr: number;
    llm: number;
    tts: number;
    total_ttfa: number;
  };
  stage_latency_bugs: Array<{
    bugId: string;
    severity: string;
    callId: string;
    clientId: string;
    language: string;
    timestamp: string;
    timings: Record<string, number>;
    overruns: Array<{ stage: string; measured_ms: number; budget_ms: number; excess_ms: number }>;
  }>;
  license_ledger: Array<{
    id: string;
    category: string;
    name: string;
    license: string;
    spdxId: string;
    commercialUseAllowed: boolean;
    resaleAllowed: boolean;
    weightsStorageUri: string;
    verifiedBy: string;
    verifiedDate: string;
  }>;
  voice_catalog: Record<
    string,
    Array<{
      id: string;
      name: string;
      gender: string;
      engine: string;
      sampleRate: number;
      phoneMosScore: number;
    }>
  >;
  tenant_clients: Array<{
    clientId: string;
    clientName: string;
    whiteLabelBrand: string;
    dataNamespace: string;
    storageBucketPrefix: string;
    redisKeyPrefix: string;
    consentedForTraining: boolean;
    dpaSignedDate: string;
    languages: string[];
    defaultLanguage: string;
    voices: { female: string; male: string };
    vicidialTrunk: string;
    transferExtension: string;
    prompts: { systemPrompt: string; greeting: string };
    faqs: Array<{ q: string; a: string }>;
    flows: string[];
    dispositions: string[];
  }>;
  data_governance: {
    dailyCallVolume: number;
    consentedCallsFilteredDaily: number;
    cleanStratifiedSamplesDaily: number;
    piiScrubberRules: string[];
    goldenTestSet: {
      minimumCallsPerLanguage: number;
      neverTrainLock: boolean;
      humanVerified: boolean;
      languages: Record<
        string,
        {
          totalCalls: number;
          humanVerifiedBy: string;
          baselineWerPct: number;
          passRatePct: number;
          sha256Manifest: string;
        }
      >;
    };
    weeklyRetrainingFlywheel: {
      scheduleCron: string;
      asrPipeline: string;
      llmPipeline: string;
      goldenSetExclusionEnforced: boolean;
    };
    infrastructureAndIp: {
      gitRepository: string;
      objectStorage: string;
      secretsManager: string;
      deployRunbookPath: string;
      ipAssignmentStatus: string;
    };
  };
  rollout_gates: Array<{
    gateId: string;
    title: string;
    clientScope: string;
    languages: string[];
    status: string;
    exitCriteria: string[];
    targetDate: string;
  }>;
  cost_comparison: {
    currency: string;
    dailyCallVolume: number;
    avgCallDurationMins: number;
    dailyMinutes: number;
    monthlyMinutes: number;
    providers: {
      sovereign_self_hosted: {
        name: string;
        breakdownPerMinInr: Record<string, number>;
        totalCostPerMinInr: number;
      };
      plivo_stack: {
        name: string;
        breakdownPerMinInr: Record<string, number>;
        totalCostPerMinInr: number;
      };
      vaani_stack: {
        name: string;
        breakdownPerMinInr: Record<string, number>;
        totalCostPerMinInr: number;
      };
    };
  };
  retraining_runs: Array<{
    runId: string;
    timestamp: string;
    language: string;
    consentedCallsSampled: number;
    analystCorrectionsMerged: number;
    goldenCallsExcluded: number;
    piiTokensRedacted: number;
    asrBeforeWerPct: number;
    asrAfterWerPct: number;
    llmPassRatePct: number;
    status: string;
  }>;
}

export const SovereignPlanScreen: React.FC = () => {
  const [data, setData] = useState<SovereignOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTenantId, setSelectedTenantId] = useState<string>('bharatfin_hi');
  const [piiInput, setPiiInput] = useState<string>(
    'नमस्ते, मेरा मोबाइल नंबर +91 9876543210 है, आधार 4589 1234 9087, पैन ABCDE1234F, यूपीआई rahul.sharma@okhdfcbank और ओटीपी 482910 है।'
  );
  const [piiResult, setPiiResult] = useState<{
    scrubbedText: string;
    redactionsCount: number;
    redactedTypes: string[];
  } | null>(null);
  const [dailyCallsCalc, setDailyCallsCalc] = useState<number>(400000);
  const [avgDurationMinsCalc, setAvgDurationMinsCalc] = useState<number>(2.2);
  const [retrainingBusy, setRetrainingBusy] = useState(false);

  const fetchOverview = async () => {
    try {
      const res = await fetch('/api/sovereign/overview');
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to load sovereign overview:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
  }, []);

  const handleToggleExternalApis = async () => {
    if (!data) return;
    const nextState = !data.sovereign_gpu.disable_external_apis;
    try {
      await fetch('/api/sovereign/toggle-external-apis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disable_external_apis: nextState })
      });
      await fetchOverview();
    } catch (err) {
      console.error('Failed to toggle external APIs:', err);
    }
  };

  const handleScrubPii = async () => {
    try {
      const res = await fetch('/api/sovereign/scrub-pii', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: piiInput })
      });
      const json = await res.json();
      setPiiResult(json);
    } catch (err) {
      console.error('PII scrub error:', err);
    }
  };

  const handleTriggerRetraining = async (lang: string) => {
    setRetrainingBusy(true);
    try {
      await fetch('/api/sovereign/retrain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang })
      });
      await fetchOverview();
    } catch (err) {
      console.error('Retraining trigger error:', err);
    } finally {
      setRetrainingBusy(false);
    }
  };

  if (loading || !data) {
    return (
      <div className="p-8 text-center text-slate-500 text-sm">
        Loading 15-Point Sovereign GPU & White-Label Architecture...
      </div>
    );
  }

  const selectedTenant =
    data.tenant_clients.find((t) => t.clientId === selectedTenantId) || data.tenant_clients[0];

  const monthlyMins = dailyCallsCalc * avgDurationMinsCalc * 30;
  const selfHostedRate = data.cost_comparison.providers.sovereign_self_hosted.totalCostPerMinInr;
  const plivoRate = data.cost_comparison.providers.plivo_stack.totalCostPerMinInr;
  const vaaniRate = data.cost_comparison.providers.vaani_stack.totalCostPerMinInr;

  const monthlySelfHostedCr = (monthlyMins * selfHostedRate) / 10000000;
  const monthlyPlivoCr = (monthlyMins * plivoRate) / 10000000;
  const monthlyVaaniCr = (monthlyMins * vaaniRate) / 10000000;

  return (
    <div className="space-y-6">
      {/* 1. Sovereign GPU Architecture Banner & External API Sunset Date (Guidelines 1, 4, 5, 6, 8, 12) */}
      <div className="bg-slate-900 text-white rounded-2xl p-5 border border-slate-700 shadow-lg">
        <div className="flex flex-wrap justify-between items-start gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="bg-indigo-500/30 border border-indigo-400 text-indigo-200 text-xs font-bold px-2.5 py-0.5 rounded uppercase">
                15-Point Sovereign GPU Plan
              </span>
              <span className="bg-amber-500/25 border border-amber-400 text-amber-200 text-xs font-bold px-2.5 py-0.5 rounded">
                External API Sunset: {data.sovereign_gpu.EXTERNAL_API_SUNSET_DATE} (
                {data.sovereign_gpu.days_until_external_api_sunset} days left)
              </span>
            </div>
            <h2 className="text-lg sm:text-xl font-bold mt-2">
              In-House GPU Live Call Path & Zero-3rd-Party Backup Chain
            </h2>
            <p className="text-slate-300 text-xs sm:text-sm mt-1">
              Temporary external APIs (Gemini / Groq / OpenRouter) are scheduled for hard removal on{' '}
              <strong className="text-white">{data.sovereign_gpu.EXTERNAL_API_SUNSET_DATE}</strong>.
              All live telephony runs on self-hosted GPUs with streaming{' '}
              <strong className="text-emerald-300">&lt; 1,000ms First Audio (TTFA)</strong>.
            </p>
          </div>

          <button
            type="button"
            onClick={handleToggleExternalApis}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
              data.sovereign_gpu.disable_external_apis
                ? 'bg-emerald-600 border-emerald-400 text-white'
                : 'bg-slate-800 border-slate-600 text-slate-200 hover:bg-slate-700'
            }`}
          >
            {data.sovereign_gpu.disable_external_apis
              ? '🔒 Sovereign Mode ON (External APIs Disabled)'
              : '⚡ Test Sovereign Cutover (Disable External APIs)'}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-4 text-xs">
          <div className="bg-slate-800/90 p-3 rounded-xl border border-slate-700">
            <div className="text-slate-400 font-semibold">1. 8kHz Call ASR (GPU)</div>
            <div className="font-bold text-white mt-1">{data.sovereign_gpu.PRIMARY_ASR_MODEL}</div>
            <div className="text-emerald-400 mt-1">Whisper-v3-turbo / IndicConformer 8kHz</div>
          </div>
          <div className="bg-slate-800/90 p-3 rounded-xl border border-slate-700">
            <div className="text-slate-400 font-semibold">2. Primary 7B LLM (vLLM)</div>
            <div className="font-bold text-white mt-1">{data.sovereign_gpu.PRIMARY_LLM_MODEL}</div>
            <div className="text-emerald-400 mt-1">AWQ 4-bit • PagedAttention SSE</div>
          </div>
          <div className="bg-slate-800/90 p-3 rounded-xl border border-slate-700">
            <div className="text-slate-400 font-semibold">3. Open Indic TTS (2 Voices/Lang)</div>
            <div className="font-bold text-white mt-1">{data.sovereign_gpu.PRIMARY_TTS_MODEL}</div>
            <div className="text-emerald-400 mt-1">Indic Parler-TTS + Piper 8kHz</div>
          </div>
          <div className="bg-slate-800/90 p-3 rounded-xl border border-slate-700">
            <div className="text-slate-400 font-semibold">4. In-House Backup Chain</div>
            <div className="font-bold text-white mt-1">{data.sovereign_gpu.BACKUP_SMALL_LLM_MODEL}</div>
            <div className="text-amber-300 mt-1">3B vLLM → Pre-Recorded WAV → Human Ext</div>
          </div>
        </div>
      </div>

      {/* 2. Per-Stage Time Budgets (< 1,000ms First Audio) & Overrun Bug Tracker (Guidelines 8 & 9) */}
      <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              ⏱️ Streaming Stage Time Budgets (&lt; 1s First Audio) &amp; Automatic Overrun Bug Log
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Guideline 8 &amp; 9: Every call logs VAD, ASR, LLM, and TTS latency. Any stage exceeding its budget is automatically recorded as a{' '}
              <code className="bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded font-mono">STAGE_LATENCY_BUG</code>.
            </p>
          </div>
          <span className="text-xs font-bold px-3 py-1 rounded-lg bg-rose-100 text-rose-800">
            Logged Latency Bugs: {data.stage_latency_bugs.length}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mt-4 text-center">
          <div className="bg-white p-3 rounded-xl border border-slate-200">
            <div className="text-xs text-slate-500">VAD + 8k→16k Sinc</div>
            <div className="text-lg font-extrabold text-slate-900">&le; {data.stage_budgets_ms.vad}ms</div>
          </div>
          <div className="bg-white p-3 rounded-xl border border-slate-200">
            <div className="text-xs text-slate-500">Streaming ASR</div>
            <div className="text-lg font-extrabold text-slate-900">&le; {data.stage_budgets_ms.asr}ms</div>
          </div>
          <div className="bg-white p-3 rounded-xl border border-slate-200">
            <div className="text-xs text-slate-500">vLLM 7B TTFT</div>
            <div className="text-lg font-extrabold text-slate-900">&le; {data.stage_budgets_ms.llm}ms</div>
          </div>
          <div className="bg-white p-3 rounded-xl border border-slate-200">
            <div className="text-xs text-slate-500">TTS First Chunk</div>
            <div className="text-lg font-extrabold text-slate-900">&le; {data.stage_budgets_ms.tts}ms</div>
          </div>
          <div className="bg-emerald-50 p-3 rounded-xl border border-emerald-300 col-span-2 sm:col-span-1">
            <div className="text-xs text-emerald-800 font-semibold">Total First Audio</div>
            <div className="text-lg font-extrabold text-emerald-700">&le; {data.stage_budgets_ms.total_ttfa}ms</div>
          </div>
        </div>

        {data.stage_latency_bugs.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-200/70 text-slate-700">
                  <th className="p-2 rounded-tl-lg">Bug ID</th>
                  <th className="p-2">Call ID / Tenant</th>
                  <th className="p-2">Overrun Stages (Measured vs Budget)</th>
                  <th className="p-2 rounded-tr-lg">Severity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {data.stage_latency_bugs.slice(0, 5).map((b) => (
                  <tr key={b.bugId}>
                    <td className="p-2 font-mono font-semibold text-rose-700">{b.bugId}</td>
                    <td className="p-2">
                      {b.callId} <span className="text-slate-400">({b.clientId})</span>
                    </td>
                    <td className="p-2">
                      {b.overruns.map((o) => (
                        <span
                          key={o.stage}
                          className="inline-block bg-rose-50 border border-rose-200 text-rose-800 px-2 py-0.5 rounded mr-1.5 mb-1 font-mono"
                        >
                          {o.stage.toUpperCase()}: {o.measured_ms}ms &gt; {o.budget_ms}ms (+{o.excess_ms}ms)
                        </span>
                      ))}
                    </td>
                    <td className="p-2 font-bold text-rose-700">{b.severity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3. 400k Calls/Day Data Pipeline, Live PII Scrubber & 500+ Golden Test Set Lock (Guidelines 2, 3, 13) */}
      <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200 space-y-4">
        <div className="flex justify-between items-start flex-wrap gap-2">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              🧹 400k Calls/Day Data Funnel, Indian PII Scrubber &amp; 500+ Golden Test Set Lock
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Guideline 2, 3 &amp; 13: Filter for consented clients only, scrub Indian PII, keep 500+ human-checked golden calls per language strictly locked from training, and fold analyst corrections into weekly Sunday retraining.
            </p>
          </div>
          <button
            type="button"
            disabled={retrainingBusy}
            onClick={() => handleTriggerRetraining('hi')}
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3.5 py-2 rounded-xl cursor-pointer transition-all"
          >
            {retrainingBusy ? 'Running Weekly LoRA Job...' : '🔄 Run Weekly Analyst Retraining (HI)'}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="bg-white p-3.5 rounded-xl border border-slate-200">
            <div className="text-slate-500">Raw Daily Ingestion</div>
            <div className="text-xl font-extrabold text-slate-900 mt-0.5">
              {data.data_governance.dailyCallVolume.toLocaleString()} calls/day
            </div>
            <div className="text-slate-500 mt-1">Sorted by language &amp; SNR &ge; 15dB</div>
          </div>
          <div className="bg-white p-3.5 rounded-xl border border-slate-200">
            <div className="text-slate-500">Consented Clients Filter</div>
            <div className="text-xl font-extrabold text-indigo-700 mt-0.5">
              {data.data_governance.consentedCallsFilteredDaily.toLocaleString()} calls/day
            </div>
            <div className="text-slate-500 mt-1">Non-consented tenants (e.g. QuickMart) dropped</div>
          </div>
          <div className="bg-white p-3.5 rounded-xl border border-slate-200">
            <div className="text-slate-500">Clean Stratified Training Set</div>
            <div className="text-xl font-extrabold text-emerald-700 mt-0.5">
              {data.data_governance.cleanStratifiedSamplesDaily.toLocaleString()} calls/day
            </div>
            <div className="text-slate-500 mt-1">PII-scrubbed + 500+/lang Golden Set excluded</div>
          </div>
        </div>

        {/* Golden Test Set Table */}
        <div className="bg-white p-4 rounded-xl border border-slate-200">
          <div className="text-xs font-bold text-slate-800 mb-2">
            🔒 Immutable 500+ Real Call Golden Benchmark Set (Human-Verified • Never Trained On)
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 text-xs">
            {Object.entries(data.data_governance.goldenTestSet.languages).map(([lang, stats]) => (
              <div key={lang} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                <div className="flex justify-between font-bold text-slate-900">
                  <span>{lang.toUpperCase()} Golden Set</span>
                  <span className="text-emerald-700">{stats.totalCalls} calls</span>
                </div>
                <div className="text-slate-600 mt-1">
                  WER: <strong>{stats.baselineWerPct}%</strong> • Pass: <strong>{stats.passRatePct}%</strong>
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5 font-mono truncate">
                  SHA256: {stats.sha256Manifest.slice(0, 14)}...
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Interactive Indian PII Scrubber */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-2.5">
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold text-slate-800">
              🛡️ Test Live Indian PII Scrubber (Aadhaar, PAN, UPI ID, Phone, OTP, Bank Account)
            </span>
            <button
              type="button"
              onClick={handleScrubPii}
              className="bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-3 py-1.5 rounded-lg cursor-pointer"
            >
              Scrub PII Now
            </button>
          </div>
          <textarea
            value={piiInput}
            onChange={(e) => setPiiInput(e.target.value)}
            rows={2}
            className="w-full text-xs p-2.5 rounded-lg border border-slate-300 font-mono"
          />
          {piiResult && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs space-y-1">
              <div className="font-bold text-emerald-900">
                Redacted {piiResult.redactionsCount} PII tokens ({piiResult.redactedTypes.join(', ')}):
              </div>
              <div className="font-mono text-slate-800">{piiResult.scrubbedText}</div>
            </div>
          )}
        </div>
      </div>

      {/* 4. Multi-Tenant Per-Client Config & Data Isolation (Guideline 11) */}
      <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200 space-y-4">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              🏢 Multi-Tenant Per-Client Config &amp; White-Label Data Isolation
            </h3>
            <p className="text-xs text-slate-600">
              Guideline 11: Prompts, FAQs, flows, voices, and dispositions are configured per client with isolated S3 buckets and Redis namespaces.
            </p>
          </div>
          <div className="flex gap-1.5">
            {data.tenant_clients.map((t) => (
              <button
                key={t.clientId}
                type="button"
                onClick={() => setSelectedTenantId(t.clientId)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-all ${
                  selectedTenant.clientId === t.clientId
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-100'
                }`}
              >
                {t.whiteLabelBrand}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-200 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div className="space-y-2">
            <div className="font-bold text-slate-900 text-sm">{selectedTenant.clientName}</div>
            <div>
              <span className="text-slate-500">Isolated Namespace:</span>{' '}
              <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono">{selectedTenant.dataNamespace}</code>
            </div>
            <div>
              <span className="text-slate-500">Storage Bucket Prefix:</span>{' '}
              <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono break-all">
                {selectedTenant.storageBucketPrefix}
              </code>
            </div>
            <div>
              <span className="text-slate-500">Training Consent:</span>{' '}
              <span
                className={`font-bold px-2 py-0.5 rounded ${
                  selectedTenant.consentedForTraining
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-rose-100 text-rose-800'
                }`}
              >
                {selectedTenant.consentedForTraining
                  ? '✓ Consented for 400k/day Training'
                  : '✗ Excluded from Training (Strict Isolation)'}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Flows:</span>{' '}
              {selectedTenant.flows.map((f) => (
                <span key={f} className="inline-block bg-blue-50 text-blue-800 px-2 py-0.5 rounded mr-1 mb-1 font-mono">
                  {f}
                </span>
              ))}
            </div>
            <div>
              <span className="text-slate-500">Dispositions:</span>{' '}
              {selectedTenant.dispositions.map((d) => (
                <span key={d} className="inline-block bg-slate-100 text-slate-700 px-2 py-0.5 rounded mr-1 mb-1 font-mono">
                  {d}
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <div className="font-semibold text-slate-700">Tenant System Prompt:</div>
              <div className="p-2 bg-slate-50 rounded border border-slate-200 text-slate-800 mt-1">
                {selectedTenant.prompts.systemPrompt}
              </div>
            </div>
            <div>
              <div className="font-semibold text-slate-700">Tenant FAQs:</div>
              <div className="space-y-1 mt-1">
                {selectedTenant.faqs.map((faq, idx) => (
                  <div key={idx} className="p-2 bg-slate-50 rounded border border-slate-200">
                    <strong>Q: {faq.q}</strong> — {faq.a}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 5. Written Commercial License & Dataset Ledger + 2 Voices/Language Catalog (Guidelines 6 & 7) */}
      <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200 space-y-4">
        <h3 className="text-base font-bold text-slate-900">
          📜 Written Commercial License Ledger &amp; Open Indic TTS Voice Catalog (2 Voices / Lang)
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse bg-white rounded-xl overflow-hidden">
            <thead>
              <tr className="bg-slate-200/80 text-slate-800">
                <th className="p-2.5">Component</th>
                <th className="p-2.5">Model / Dataset</th>
                <th className="p-2.5">SPDX License</th>
                <th className="p-2.5">Commercial &amp; Resale</th>
                <th className="p-2.5">Self-Hosted Vault URI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {data.license_ledger.map((item) => (
                <tr key={item.id}>
                  <td className="p-2.5 font-semibold text-slate-700">{item.category}</td>
                  <td className="p-2.5 font-bold text-slate-900">{item.name}</td>
                  <td className="p-2.5">
                    <span className="bg-indigo-50 text-indigo-800 px-2 py-0.5 rounded font-mono">
                      {item.spdxId}
                    </span>
                  </td>
                  <td className="p-2.5">
                    {item.commercialUseAllowed && item.resaleAllowed ? (
                      <span className="bg-emerald-100 text-emerald-800 font-bold px-2 py-0.5 rounded">
                        ✓ Commercial + Resale Allowed
                      </span>
                    ) : (
                      <span className="bg-rose-100 text-rose-800 font-bold px-2 py-0.5 rounded">Restricted</span>
                    )}
                  </td>
                  <td className="p-2.5 font-mono text-[11px] text-slate-500">{item.weightsStorageUri}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          {Object.entries(data.voice_catalog).map(([lang, voices]) => (
            <div key={lang} className="bg-white p-3 rounded-xl border border-slate-200">
              <div className="font-bold text-slate-900 uppercase mb-1.5">
                {lang} — 2 Open Indic Voices (8kHz Phone Tested)
              </div>
              {voices.map((v) => (
                <div key={v.id} className="flex justify-between items-center py-1 border-t border-slate-100">
                  <span>{v.name}</span>
                  <span className="text-emerald-700 font-semibold">MOS {v.phoneMosScore}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* 6. 3-Gate Rollout & Cost-per-Minute Tracker vs. Plivo & Vaani (Guidelines 14 & 15) */}
      <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200 space-y-4">
        <h3 className="text-base font-bold text-slate-900">
          🚦 3-Gate Production Rollout &amp; Cost-per-Minute vs. Plivo &amp; Vaani
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          {data.rollout_gates.map((gate) => (
            <div key={gate.gateId} className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center">
                  <span className="font-extrabold text-indigo-700">{gate.gateId}</span>
                  <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-semibold">
                    Target: {gate.targetDate}
                  </span>
                </div>
                <div className="font-bold text-slate-900 mt-1.5">{gate.title}</div>
                <div className="text-slate-500 mt-0.5">{gate.clientScope}</div>
                <ul className="mt-2.5 space-y-1 text-slate-700 list-disc pl-4">
                  {gate.exitCriteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
              <div className="mt-3 pt-2 border-t border-slate-100 font-bold text-emerald-700">
                Languages: {gate.languages.join(', ').toUpperCase()}
              </div>
            </div>
          ))}
        </div>

        {/* Interactive Cost-per-Minute Comparison vs Plivo and Vaani */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-3">
          <div className="flex justify-between items-center flex-wrap gap-3">
            <div className="text-xs font-bold text-slate-900">
              💰 Unit Economics Benchmark (₹/Minute &amp; Monthly Run-Rate at {dailyCallsCalc.toLocaleString()} Calls/Day)
            </div>
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <span className="text-slate-500">Daily Calls:</span>
                <input
                  type="number"
                  value={dailyCallsCalc}
                  onChange={(e) => setDailyCallsCalc(Math.max(1000, Number(e.target.value) || 0))}
                  className="w-28 px-2 py-1 border border-slate-300 rounded font-mono"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-slate-500">Avg Mins/Call:</span>
                <input
                  type="number"
                  step="0.1"
                  value={avgDurationMinsCalc}
                  onChange={(e) => setAvgDurationMinsCalc(Math.max(0.5, Number(e.target.value) || 1))}
                  className="w-16 px-2 py-1 border border-slate-300 rounded font-mono"
                />
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-300">
              <div className="font-bold text-emerald-950">
                {data.cost_comparison.providers.sovereign_self_hosted.name}
              </div>
              <div className="text-2xl font-extrabold text-emerald-700 mt-1">₹{selfHostedRate.toFixed(2)} / min</div>
              <div className="text-emerald-900 mt-1">
                Monthly: <strong>₹{monthlySelfHostedCr.toFixed(2)} Cr</strong> ({monthlyMins.toLocaleString()} mins)
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <div className="font-bold text-slate-800">{data.cost_comparison.providers.plivo_stack.name}</div>
              <div className="text-2xl font-extrabold text-slate-700 mt-1">₹{plivoRate.toFixed(2)} / min</div>
              <div className="text-rose-700 font-semibold mt-1">
                Monthly: ₹{monthlyPlivoCr.toFixed(2)} Cr (Save ₹{(monthlyPlivoCr - monthlySelfHostedCr).toFixed(2)} Cr/mo)
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <div className="font-bold text-slate-800">{data.cost_comparison.providers.vaani_stack.name}</div>
              <div className="text-2xl font-extrabold text-slate-700 mt-1">₹{vaaniRate.toFixed(2)} / min</div>
              <div className="text-rose-700 font-semibold mt-1">
                Monthly: ₹{monthlyVaaniCr.toFixed(2)} Cr (Save ₹{(monthlyVaaniCr - monthlySelfHostedCr).toFixed(2)} Cr/mo)
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
