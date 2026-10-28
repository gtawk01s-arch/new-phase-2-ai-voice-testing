import React, { useState, useEffect } from 'react';
import { Extension, CallLogSession } from '../types';

interface DialerSimulatorProps {
  onStartInboundCall: (callerId: string, greeting: string) => void;
  onStartOutboundCall: (name: string, phone: string, campaign: string) => void;
  onTransferToExt: (ext: Extension) => void;
}

export const DialerSimulator: React.FC<DialerSimulatorProps> = ({
  onStartInboundCall,
  onStartOutboundCall,
  onTransferToExt
}) => {
  // Inbound Form
  const [inboundCallerId, setInboundCallerId] = useState('+1 (555) 345-6789');
  const [inboundGreeting, setInboundGreeting] = useState(
    'Thank you for calling Customer Support. I am your automated AI assistant. How can I help you today?'
  );

  // Outbound Form
  const [outboundName, setOutboundName] = useState('Sarah Jenkins');
  const [outboundPhone, setOutboundPhone] = useState('+1 (555) 789-0123');
  const [outboundCampaign, setOutboundCampaign] = useState('Account Follow-up');

  // Extensions & Call Sessions
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [recentCalls, setRecentCalls] = useState<CallLogSession[]>([]);
  const [isLoadingCalls, setIsLoadingCalls] = useState(false);

  // Load Extensions
  useEffect(() => {
    fetch('/api/dialer/extensions')
      .then((res) => res.json())
      .then((data) => {
        if (data.extensions) {
          setExtensions(data.extensions);
        }
      })
      .catch((err) => console.error('Failed to load extensions:', err));
  }, []);

  // Load Recent Calls
  const loadRecentCalls = async () => {
    setIsLoadingCalls(true);
    try {
      const res = await fetch('/api/dialer/calls');
      const data = await res.json();
      if (data.calls) {
        setRecentCalls(data.calls);
      }
    } catch (err) {
      console.error('Failed to load recent calls:', err);
    } finally {
      setIsLoadingCalls(false);
    }
  };

  useEffect(() => {
    loadRecentCalls();
  }, []);

  return (
    <div className="space-y-6">
      {/* 2-Column Simulator Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Inbound Call Simulator */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 sm:p-6 flex flex-col justify-between shadow-xs">
          <div>
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
              <span className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                <span>📥</span> Inbound Call Simulator
              </span>
              <span className="bg-sky-100 text-sky-800 text-xs font-bold px-2.5 py-0.5 rounded-full uppercase">
                PBX Inbound
              </span>
            </div>

            <div className="space-y-3.5 mb-4">
              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1.5">
                  Caller Phone Number (ANI)
                </label>
                <input
                  type="text"
                  value={inboundCallerId}
                  onChange={(e) => setInboundCallerId(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1.5">
                  Welcome Greeting
                </label>
                <textarea
                  rows={3}
                  value={inboundGreeting}
                  onChange={(e) => setInboundGreeting(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onStartInboundCall(inboundCallerId, inboundGreeting)}
            className="w-full mt-2 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-xl text-sm flex items-center justify-center gap-2 transition-all cursor-pointer shadow-sm hover:shadow"
          >
            <span>📞</span> Simulate Inbound Call
          </button>
        </div>

        {/* Outbound AI Agent Calling Simulator */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 sm:p-6 flex flex-col justify-between shadow-xs">
          <div>
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
              <span className="font-extrabold text-base text-slate-900 flex items-center gap-2">
                <span>📤</span> Outbound AI Agent Calling
              </span>
              <span className="bg-amber-100 text-amber-800 text-xs font-bold px-2.5 py-0.5 rounded-full uppercase">
                Dialer Campaign
              </span>
            </div>

            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1.5">
                  Customer Name
                </label>
                <input
                  type="text"
                  value={outboundName}
                  onChange={(e) => setOutboundName(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1.5">
                  Destination Number
                </label>
                <input
                  type="text"
                  value={outboundPhone}
                  onChange={(e) => setOutboundPhone(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1.5">
                  Campaign Type
                </label>
                <select
                  value={outboundCampaign}
                  onChange={(e) => setOutboundCampaign(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 cursor-pointer"
                >
                  <option value="Payment Reminder">Payment Reminder</option>
                  <option value="Appointment Confirmation">Appointment Confirmation</option>
                  <option value="Account Follow-up">Account Follow-up</option>
                  <option value="Customer Satisfaction Survey">Customer Satisfaction Survey</option>
                </select>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onStartOutboundCall(outboundName, outboundPhone, outboundCampaign)}
            className="w-full mt-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 px-4 rounded-xl text-sm flex items-center justify-center gap-2 transition-all cursor-pointer shadow-sm hover:shadow"
          >
            <span>🚀</span> Launch Outbound Agent Call
          </button>
        </div>
      </div>

      {/* Extension Directory Section */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 shadow-xs">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
          <span className="font-extrabold text-base text-slate-900 flex items-center gap-2">
            <span>🏢</span> Configured Agent Extension Directory
          </span>
          <span className="text-xs text-slate-500">Auto-detected and routed via speech</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {extensions.map((ext) => (
            <div
              key={ext.id}
              className="bg-slate-50 hover:bg-slate-100 border border-slate-200 hover:border-blue-300 rounded-xl p-4 flex flex-col justify-between transition-all"
            >
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <span className="bg-sky-100 text-sky-800 font-extrabold text-xs px-2 py-0.5 rounded-md">
                    Ext {ext.id}
                  </span>
                  <span className="text-xs text-slate-500">{ext.dept}</span>
                </div>
                <div className="font-bold text-sm text-slate-800">{ext.name}</div>
                <div className="font-mono text-xs text-slate-500 mt-0.5">{ext.sip}</div>
              </div>

              <button
                type="button"
                onClick={() => onTransferToExt(ext)}
                className="mt-3.5 bg-white hover:bg-blue-600 hover:text-white border border-slate-300 hover:border-blue-600 text-slate-700 py-1.5 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-2xs"
              >
                <span>🔀</span> Route Call to Ext {ext.id}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Dialer Call Sessions Monitor */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 shadow-xs">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <span className="font-extrabold text-base text-slate-900 flex items-center gap-2">
            <span>📊</span> Recent Dialer Call Sessions
          </span>
          <button
            type="button"
            onClick={loadRecentCalls}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
          >
            <span>🔄</span> {isLoadingCalls ? 'Refreshing...' : 'Refresh Calls'}
          </button>
        </div>

        <div className="overflow-x-auto">
          {recentCalls.length === 0 ? (
            <div className="text-slate-500 text-sm py-4 text-center">
              No calls logged yet. Start an inbound or outbound call above.
            </div>
          ) : (
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 uppercase tracking-wider">
                  <th className="py-2.5 px-3">Call ID</th>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">Contact</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Duration</th>
                  <th className="py-2.5 px-3">Transfer Route</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentCalls.slice(0, 8).map((c) => (
                  <tr key={c.callId} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-2.5 px-3 font-mono text-slate-600">{c.callId}</td>
                    <td className="py-2.5 px-3 font-semibold capitalize text-slate-700">{c.direction}</td>
                    <td className="py-2.5 px-3 text-slate-800 font-medium">
                      {c.customerName || c.callerId}
                    </td>
                    <td className="py-2.5 px-3 font-bold">
                      <span
                        className={
                          c.status === 'transferred'
                            ? 'text-blue-600'
                            : c.status === 'connected'
                            ? 'text-emerald-600'
                            : 'text-slate-500'
                        }
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-slate-600 font-mono">
                      {c.duration_seconds !== undefined ? `${c.duration_seconds}s` : '—'}
                    </td>
                    <td className="py-2.5 px-3">
                      {c.transferredTo ? (
                        <span className="bg-sky-50 text-sky-800 border border-sky-200 font-semibold px-2 py-0.5 rounded text-[11px]">
                          Ext {c.transferredTo.id} ({c.transferredTo.name})
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
