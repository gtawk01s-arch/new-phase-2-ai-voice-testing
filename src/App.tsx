import React, { useState } from 'react';
import { Header } from './components/Header';
import { LiveVoiceAssistant } from './components/LiveVoiceAssistant';
import { DialerSimulator } from './components/DialerSimulator';
import { AnalystScreen } from './components/AnalystScreen';
import { WebhookContract } from './components/WebhookContract';
import { Extension } from './types';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'voice' | 'dialer' | 'qa' | 'api'>('voice');

  // Triggered by Dialer Simulator to start Inbound Call
  const handleStartInbound = async (callerId: string, greeting: string) => {
    setActiveTab('voice');
    try {
      await fetch('/api/dialer/call/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction: 'inbound',
          caller_id: callerId,
          custom_greeting: greeting
        })
      });
    } catch (err) {
      console.error('Inbound simulation error:', err);
    }
  };

  // Triggered by Dialer Simulator to start Outbound Call
  const handleStartOutbound = async (name: string, phone: string, campaign: string) => {
    setActiveTab('voice');
    try {
      await fetch('/api/dialer/call/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction: 'outbound',
          caller_id: phone,
          customer_name: name,
          campaign
        })
      });
    } catch (err) {
      console.error('Outbound simulation error:', err);
    }
  };

  // Triggered by Extension Board to Route Call
  const handleTransferToExt = async (ext: Extension) => {
    setActiveTab('voice');
    try {
      await fetch('/api/dialer/call/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extension_id: ext.id
        })
      });
    } catch (err) {
      console.error('Transfer route error:', err);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-950 p-3 sm:p-6 flex justify-center items-start text-slate-800 font-sans">
      <div className="bg-white rounded-3xl shadow-2xl max-w-4xl w-full overflow-hidden flex flex-col my-3 sm:my-6 border border-slate-700/30">
        <Header activeTab={activeTab} onTabChange={setActiveTab} />

        <div className="p-5 sm:p-8">
          {activeTab === 'voice' && (
            <LiveVoiceAssistant onNavigateToDialer={() => setActiveTab('dialer')} />
          )}

          {activeTab === 'dialer' && (
            <DialerSimulator
              onStartInboundCall={handleStartInbound}
              onStartOutboundCall={handleStartOutbound}
              onTransferToExt={handleTransferToExt}
            />
          )}

          {activeTab === 'qa' && <AnalystScreen />}

          {activeTab === 'api' && <WebhookContract />}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 text-center text-xs text-slate-400">
          AI Call Assistant & Telephony PBX Engine • Built with React, Vite & Express
        </div>
      </div>
    </div>
  );
};

export default App;
