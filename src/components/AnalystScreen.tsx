import React, { useState, useEffect } from 'react';
import { CallLogSession, TurnRecord, ChaosConfig } from '../types';
import { playVoiceAudio } from '../utils/audio';

export const AnalystScreen: React.FC = () => {
  const [calls, setCalls] = useState<CallLogSession[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'flagged' | 'transferred' | 'hi'>('all');

  // Corrections & Flagging state
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [correctedText, setCorrectedText] = useState('');
  const [flagReasonModal, setFlagReasonModal] = useState<{ callId: string; turnId: string } | null>(null);
  const [selectedFlagReason, setSelectedFlagReason] = useState('Bad Tone / Unnatural Phrasing');

  // Chaos Injection state (Phase 2 Task 8)
  const [chaos, setChaos] = useState<ChaosConfig>({
    simulateAsrFail: false,
    simulateLlmFail: false,
    simulateTtsFail: false,
    forceProvider: 'none'
  });

  // Automated 8kHz Audio Acceptance Test Suite state
  const [isRunning50Tests, setIsRunning50Tests] = useState(false);
  const [testResults, setTestResults] = useState<{
    total: number;
    passed: number;
    failed: number;
    p50Latency?: number;
    p95Latency: number;
    legMedians?: { vad: number; asr: number; llm: number; tts: number };
    werHindi: string;
    werEnglish: string;
    items: Array<{
      id: number;
      category: string;
      referenceText?: string;
      input: string;
      passed: boolean;
      reply: string;
      latency: number;
      timings?: { vad?: number; asr?: number; llm?: number; tts?: number; total?: number };
      werPct?: string;
    }>;
  } | null>(null);

  // Load call audit list and chaos state
  const fetchCallsAndChaos = async () => {
    setIsLoading(true);
    try {
      const [callsRes, chaosRes] = await Promise.all([
        fetch('/api/qa/calls').then(r => r.json()).catch(() => ({ calls: [] })),
        fetch('/api/admin/chaos').then(r => r.json()).catch(() => ({ chaos: {} }))
      ]);

      if (callsRes.calls) {
        setCalls(callsRes.calls);
        if (!selectedCallId && callsRes.calls.length > 0) {
          setSelectedCallId(callsRes.calls[0].callId);
        }
      }
      if (chaosRes.chaos) {
        setChaos(prev => ({ ...prev, ...chaosRes.chaos }));
      }
    } catch (err) {
      console.warn('Error fetching QA audit data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCallsAndChaos();
    const interval = setInterval(fetchCallsAndChaos, 10000);
    return () => clearInterval(interval);
  }, []);

  // Update Chaos State
  const updateChaos = async (updates: Partial<ChaosConfig>) => {
    const nextChaos = { ...chaos, ...updates };
    setChaos(nextChaos);
    try {
      await fetch('/api/admin/chaos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextChaos)
      });
    } catch (e) {
      console.warn('Failed to update chaos state:', e);
    }
  };

  // Flag Turn
  const handleFlagTurn = async (callId: string, turnId: string, reason: string) => {
    try {
      await fetch('/api/qa/flag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_id: callId, turn_id: turnId, reason })
      });
      setFlagReasonModal(null);
      await fetchCallsAndChaos();
    } catch (e) {
      console.warn('Failed to flag turn:', e);
    }
  };

  // Submit Correction
  const handleSaveCorrection = async (callId: string, turnId: string) => {
    if (!correctedText.trim()) return;
    try {
      await fetch('/api/qa/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_id: callId, turn_id: turnId, corrected_text: correctedText.trim() })
      });
      setEditingTurnId(null);
      setCorrectedText('');
      await fetchCallsAndChaos();
    } catch (e) {
      console.warn('Failed to save correction:', e);
    }
  };

  // Export fine-tuning dataset
  const handleExportJsonl = () => {
    const link = document.createElement('a');
    link.href = '/api/qa/export-finetuning';
    link.download = 'finetuning-dataset.jsonl';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Run the real 8kHz WAV Acceptance Test Suite via backend (/tests/recordings/en/*.wav & /tests/recordings/hi/*.wav)
  const run50AcceptanceTests = async () => {
    setIsRunning50Tests(true);
    setTestResults(null);
    try {
      const res = await fetch('/api/qa/run-audio-suite', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.items) {
        setTestResults(data);
      }
    } catch (err) {
      console.warn('Failed to run 8kHz audio suite:', err);
    } finally {
      setIsRunning50Tests(false);
      await fetchCallsAndChaos();
    }
  };

  const selectedCall = calls.find(c => c.callId === selectedCallId);

  const filteredCalls = calls.filter(c => {
    if (filter === 'flagged') return c.flagged;
    if (filter === 'transferred') return c.status === 'transferred' || c.disposition === 'transferred';
    if (filter === 'hi') return c.language?.startsWith('hi');
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Top Banner Notice */}
      <div className="bg-gradient-to-r from-indigo-900/80 to-purple-900/80 border border-indigo-500/30 rounded-2xl p-5 text-white shadow-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">🛡️</span>
            <h2 className="text-lg font-bold">QA Analyst & Telephony Compliance Dashboard</h2>
          </div>
          <p className="text-xs text-indigo-200 mt-1">
            Audit call transcripts & per-leg latencies • Flag bad replies • Human transcript corrections feed JSONL retraining
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleExportJsonl}
            className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition-colors flex items-center gap-1.5 shadow-md cursor-pointer"
          >
            <span>📥</span>
            <span>Export Fine-Tuning JSONL</span>
          </button>

          <button
            type="button"
            disabled={isRunning50Tests}
            onClick={run50AcceptanceTests}
            className={`px-4 py-2 rounded-xl font-bold text-xs transition-all flex items-center gap-1.5 shadow-md cursor-pointer ${
              isRunning50Tests
                ? 'bg-amber-500 text-white animate-pulse'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
          >
            <span>⚡</span>
            <span>{isRunning50Tests ? 'Running 8kHz WAV Suite...' : 'Run 8kHz Audio Test Suite (20 WAVs)'}</span>
          </button>
        </div>
      </div>

      {/* Measured 8kHz WAV Acceptance Tests Results Box */}
      {testResults && (
        <div className="bg-slate-900 border border-emerald-500/40 rounded-2xl p-5 text-white shadow-xl">
          <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-2xl">{testResults.failed === 0 ? '✅' : '⚠️'}</span>
              <div>
                <h3 className="font-bold text-base text-emerald-400">
                  Measured 8kHz WAV Suite: {testResults.passed}/{testResults.total} Passed ({testResults.failed} Failed)
                </h3>
                {testResults.legMedians && (
                  <p className="text-xs text-slate-400 font-mono">
                    Median Per-Leg Latency — VAD: {testResults.legMedians.vad}ms | ASR: {testResults.legMedians.asr}ms | LLM: {testResults.legMedians.llm}ms | TTS: {testResults.legMedians.tts}ms
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs font-mono flex-wrap">
              <span className="bg-emerald-500/20 text-emerald-300 px-3 py-1 rounded-lg border border-emerald-500/30">
                p50: {testResults.p50Latency ?? 0}ms | p95: {testResults.p95Latency}ms
              </span>
              <span className="bg-sky-500/20 text-sky-300 px-3 py-1 rounded-lg border border-sky-500/30">
                Measured WER (EN): {testResults.werEnglish} | (HI): {testResults.werHindi}
              </span>
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto space-y-2 pr-1 text-xs">
            {testResults.items.map(item => (
              <div
                key={item.id}
                className={`p-2.5 rounded-xl border flex items-start justify-between gap-3 ${
                  item.passed ? 'bg-slate-800/80 border-slate-700' : 'bg-rose-950/40 border-rose-500/40'
                }`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-400">#{item.id}</span>
                    <span className="px-2 py-0.5 rounded bg-slate-700 text-slate-300 text-[10px] font-semibold">
                      {item.category}
                    </span>
                    <span className="text-slate-300">ASR: "{item.input}"</span>
                    {item.werPct && (
                      <span className="text-[10px] font-mono text-sky-400">WER: {item.werPct}</span>
                    )}
                  </div>
                  <div className="text-slate-400 mt-1 pl-6">
                    Alex: <span className="text-slate-200">"{item.reply}"</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-slate-400 font-mono text-[11px]">
                    {item.timings
                      ? `ASR:${item.timings.asr}ms LLM:${item.timings.llm}ms TTS:${item.timings.tts}ms (${item.latency}ms)`
                      : `${item.latency}ms`}
                  </span>
                  <span className={item.passed ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                    {item.passed ? 'PASS' : 'FAIL'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Provider Chaos Injection Testing */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-white shadow-xl">
        <div className="flex justify-between items-center mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚡</span>
            <h3 className="font-bold text-sm text-slate-200">
              Provider Chaos & Failover Injection (Non-Production / Chaos Mode)
            </h3>
          </div>
          <span className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-full">
            Fault Tolerance Verification Mode
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
          <label className="flex items-center justify-between p-3 rounded-xl bg-slate-800/70 border border-slate-700/60 cursor-pointer">
            <span className="font-semibold text-slate-300">Simulate ASR Down</span>
            <input
              type="checkbox"
              checked={chaos.simulateAsrFail}
              onChange={e => updateChaos({ simulateAsrFail: e.target.checked })}
              className="w-4 h-4 accent-amber-500 rounded"
            />
          </label>

          <label className="flex items-center justify-between p-3 rounded-xl bg-slate-800/70 border border-slate-700/60 cursor-pointer">
            <span className="font-semibold text-slate-300">Simulate LLM Outage</span>
            <input
              type="checkbox"
              checked={chaos.simulateLlmFail}
              onChange={e => updateChaos({ simulateLlmFail: e.target.checked })}
              className="w-4 h-4 accent-rose-500 rounded"
            />
          </label>

          <label className="flex items-center justify-between p-3 rounded-xl bg-slate-800/70 border border-slate-700/60 cursor-pointer">
            <span className="font-semibold text-slate-300">Simulate TTS Failure</span>
            <input
              type="checkbox"
              checked={chaos.simulateTtsFail}
              onChange={e => updateChaos({ simulateTtsFail: e.target.checked })}
              className="w-4 h-4 accent-sky-500 rounded"
            />
          </label>

          <div className="flex items-center justify-between p-2 rounded-xl bg-slate-800/70 border border-slate-700/60">
            <span className="font-semibold text-slate-300 pl-1">Force Provider:</span>
            <select
              value={chaos.forceProvider}
              onChange={e => updateChaos({ forceProvider: e.target.value as any })}
              className="bg-slate-900 text-slate-200 border border-slate-700 rounded-lg px-2 py-1 text-xs"
            >
              <option value="none">Auto (Gemini/Groq/OpenRouter)</option>
              <option value="gemini">Force Gemini</option>
              <option value="groq">Force Groq</option>
              <option value="openrouter">Force OpenRouter</option>
              <option value="all_down">Kill All LLMs</option>
            </select>
          </div>
        </div>

        <p className="text-[11px] text-slate-400 mt-2">
          • ASR Down: Triggers 2x "Could you repeat that?", then transfers to Extension 101.<br />
          • LLM Down: Plays single scripted apology and immediately transfers to Extension 101.<br />
          • TTS Down: Plays pre-recorded spoken WAV fallback lines from /public/audio/fallbacks/.
        </p>
      </div>

      {/* Main Two-Column Layout: Call List vs Turn Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Call List (5 cols) */}
        <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-bold text-slate-800 text-sm flex items-center gap-1.5">
              <span>📋</span> Call Audit Sessions ({filteredCalls.length})
            </h3>
            <button
              type="button"
              onClick={fetchCallsAndChaos}
              className="text-xs text-indigo-600 hover:text-indigo-700 font-semibold cursor-pointer"
            >
              Refresh
            </button>
          </div>

          {/* Filter Pills */}
          <div className="flex gap-1.5 mb-3 flex-wrap text-xs">
            {(['all', 'flagged', 'transferred', 'hi'] as const).map(f => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded-lg font-semibold capitalize cursor-pointer transition-colors ${
                  filter === f ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {f === 'hi' ? 'Hindi/Hinglish' : f}
              </button>
            ))}
          </div>

          <div className="overflow-y-auto max-h-[500px] space-y-2 pr-1">
            {filteredCalls.length === 0 ? (
              <div className="text-center py-10 text-slate-400 text-xs">
                No calls recorded matching filter. Run simulator or make a voice call!
              </div>
            ) : (
              filteredCalls.map(c => {
                const isSelected = c.callId === selectedCallId;
                return (
                  <div
                    key={c.callId}
                    onClick={() => setSelectedCallId(c.callId)}
                    className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                      isSelected
                        ? 'border-indigo-500 bg-indigo-50/70 shadow-sm'
                        : 'border-slate-200 hover:border-slate-300 bg-white'
                    }`}
                  >
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-mono font-bold text-slate-800 truncate max-w-[170px]">
                        {c.callId}
                      </span>
                      <span className="font-mono text-slate-500 text-[11px]">
                        {c.duration_seconds || 0}s
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-slate-500 text-[11px] mb-1.5">
                      <span>{c.direction === 'inbound' ? '📥 Inbound' : '📤 Outbound'}</span>
                      <span>•</span>
                      <span className="capitalize">{c.campaign}</span>
                      <span>•</span>
                      <span className="uppercase font-semibold text-slate-600">{c.language || 'en'}</span>
                    </div>

                    <div className="flex justify-between items-center">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          c.disposition === 'transferred' || c.status === 'transferred'
                            ? 'bg-purple-100 text-purple-700'
                            : c.disposition === 'DNC'
                            ? 'bg-rose-100 text-rose-700'
                            : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        {c.disposition || c.status}
                      </span>

                      {c.flagged && (
                        <span className="text-rose-600 text-[11px] font-bold flex items-center gap-0.5">
                          🚩 Flagged
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Turn Inspector & Retraining Editor (7 cols) */}
        <div className="lg:col-span-7 bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex flex-col">
          {selectedCall ? (
            <div>
              <div className="border-b border-slate-100 pb-3 mb-4 flex justify-between items-center flex-wrap gap-2">
                <div>
                  <h3 className="font-extrabold text-slate-900 text-base flex items-center gap-2">
                    <span>Call Inspection:</span>
                    <span className="font-mono text-indigo-600 text-sm">{selectedCall.callId}</span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    Caller: {selectedCall.callerId} • Disposition: {selectedCall.disposition} • Language: {selectedCall.language}
                  </p>
                </div>

                <div className="text-xs text-slate-500 font-mono">
                  {selectedCall.history?.length || 0} Turns Recorded
                </div>
              </div>

              {/* Turn-by-Turn History */}
              <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
                {selectedCall.history && selectedCall.history.length > 0 ? (
                  selectedCall.history.map((turn: TurnRecord, idx: number) => {
                    const isUser = turn.role === 'user';
                    return (
                      <div
                        key={turn.turnId || idx}
                        className={`p-3.5 rounded-xl border text-xs ${
                          isUser
                            ? 'bg-slate-50 border-slate-200'
                            : 'bg-indigo-50/50 border-indigo-200'
                        }`}
                      >
                        <div className="flex justify-between items-center mb-1 text-[11px]">
                          <span className="font-bold text-slate-700 flex items-center gap-1.5">
                            <span>{isUser ? '👤 Caller' : '🤖 Alex Agent'}</span>
                            {turn.provider && (
                              <span className="text-[10px] text-slate-400 font-mono">
                                ({turn.provider})
                              </span>
                            )}
                          </span>

                          <div className="flex items-center gap-2">
                            {turn.timings?.total ? (
                              <span className="text-slate-400 font-mono text-[10px]">
                                {turn.timings.total}ms
                              </span>
                            ) : null}

                            {!isUser && (
                              <button
                                type="button"
                                onClick={() => playVoiceAudio(turn.text, turn.audioUrl)}
                                className="text-indigo-600 hover:text-indigo-800 font-semibold text-[11px] cursor-pointer flex items-center gap-0.5"
                              >
                                🔊 Listen
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => {
                                setEditingTurnId(turn.turnId);
                                setCorrectedText(turn.correctedText || turn.text);
                              }}
                              className="text-slate-600 hover:text-slate-800 font-semibold text-[11px] cursor-pointer"
                            >
                              ✏️ Correct
                            </button>

                            <button
                              type="button"
                              onClick={() => setFlagReasonModal({ callId: selectedCall.callId, turnId: turn.turnId })}
                              className={`text-[11px] font-semibold cursor-pointer ${
                                turn.flagged ? 'text-rose-600' : 'text-slate-400 hover:text-rose-600'
                              }`}
                            >
                              🚩 {turn.flagged ? 'Flagged' : 'Flag'}
                            </button>
                          </div>
                        </div>

                        {/* Text */}
                        <div className="text-slate-800 text-[13px] leading-relaxed">
                          {turn.text}
                        </div>

                        {/* Corrected Text if any */}
                        {turn.correctedText && (
                          <div className="mt-1.5 p-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
                            <span className="font-bold">Human Verified Correction:</span> "{turn.correctedText}"
                          </div>
                        )}

                        {/* Inline Correction Input */}
                        {editingTurnId === turn.turnId && (
                          <div className="mt-2.5 pt-2 border-t border-slate-200">
                            <label className="block text-[11px] font-bold text-slate-700 mb-1">
                              Correct Transcript for Retraining Dataset:
                            </label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={correctedText}
                                onChange={e => setCorrectedText(e.target.value)}
                                className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500"
                              />
                              <button
                                type="button"
                                onClick={() => handleSaveCorrection(selectedCall.callId, turn.turnId)}
                                className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-500 cursor-pointer"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingTurnId(null)}
                                className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-300 cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {turn.flagged && turn.flagReason && (
                          <div className="mt-1 text-[11px] text-rose-600 font-semibold">
                            Reason: {turn.flagReason}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="text-center py-8 text-slate-400 text-xs">
                    No turn-by-turn history recorded for this session.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-16 text-slate-400 text-sm">
              Select a call session on the left to inspect turns, timings, and perform human corrections.
            </div>
          )}
        </div>
      </div>

      {/* Flag Modal */}
      {flagReasonModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <h3 className="font-bold text-slate-900 text-base mb-2">🚩 Flag Bad Voice Response</h3>
            <p className="text-xs text-slate-500 mb-4">
              Flagging turns helps exclude hallucinated or low-quality replies from fine-tuning datasets.
            </p>

            <label className="block text-xs font-semibold text-slate-700 mb-1">Select Issue Category:</label>
            <select
              value={selectedFlagReason}
              onChange={e => setSelectedFlagReason(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-xl text-xs mb-5 focus:outline-none focus:ring-2 focus:ring-rose-500"
            >
              <option value="Bad Tone / Unnatural Phrasing">Bad Tone / Unnatural Phrasing</option>
              <option value="Model Hallucination / Factually Wrong">Model Hallucination / Factually Wrong</option>
              <option value="Cut Off Mid-Sentence">Cut Off Mid-Sentence</option>
              <option value="Failed Extension Routing">Failed Extension Routing</option>
              <option value="Ignored Customer Request">Ignored Customer Request</option>
            </select>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setFlagReasonModal(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleFlagTurn(flagReasonModal.callId, flagReasonModal.turnId, selectedFlagReason)}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl cursor-pointer"
              >
                Confirm Flag
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
