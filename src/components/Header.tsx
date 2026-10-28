import React from 'react';

interface HeaderProps {
  activeTab: 'voice' | 'dialer' | 'qa' | 'api';
  onTabChange: (tab: 'voice' | 'dialer' | 'qa' | 'api') => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, onTabChange }) => {
  return (
    <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 sm:px-8 pt-7 pb-5 text-white">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <h1 className="text-2xl sm:text-[1.75rem] font-extrabold tracking-tight flex items-center gap-2.5">
          <span>🤖</span> AI Call Assistant
        </h1>
        <div className="flex items-center gap-2">
          <span className="bg-sky-500/25 border border-sky-400 text-sky-100 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
            Phase 2 • Multi-Lang & QA
          </span>
          <span className="bg-emerald-500/25 border border-emerald-400 text-emerald-100 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider hidden sm:inline">
            Telephony PBX Ready
          </span>
        </div>
      </div>
      <p className="text-slate-200 text-sm sm:text-[0.95rem] mt-1.5">
        Production Voice Engine • English, Hindi & Hinglish • Automatic Fallbacks, ASR Retries & QA Retraining
      </p>

      {/* Tabs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 bg-slate-900/35 rounded-xl p-1 mt-5 gap-1.5">
        <button
          type="button"
          onClick={() => onTabChange('voice')}
          className={`py-2 px-2.5 sm:px-3 rounded-lg text-xs sm:text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
            activeTab === 'voice'
              ? 'bg-white text-slate-900 shadow-md'
              : 'text-slate-200 hover:text-white hover:bg-white/10'
          }`}
        >
          <span>🎙️</span>
          <span>Voice Call</span>
        </button>

        <button
          type="button"
          onClick={() => onTabChange('dialer')}
          className={`py-2 px-2.5 sm:px-3 rounded-lg text-xs sm:text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
            activeTab === 'dialer'
              ? 'bg-white text-slate-900 shadow-md'
              : 'text-slate-200 hover:text-white hover:bg-white/10'
          }`}
        >
          <span>📞</span>
          <span>Dialer & PBX</span>
        </button>

        <button
          type="button"
          onClick={() => onTabChange('qa')}
          className={`py-2 px-2.5 sm:px-3 rounded-lg text-xs sm:text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
            activeTab === 'qa'
              ? 'bg-white text-slate-900 shadow-md'
              : 'text-slate-200 hover:text-white hover:bg-white/10'
          }`}
        >
          <span>🛡️</span>
          <span>QA & Analyst</span>
        </button>

        <button
          type="button"
          onClick={() => onTabChange('api')}
          className={`py-2 px-2.5 sm:px-3 rounded-lg text-xs sm:text-sm font-semibold transition-all duration-200 flex items-center justify-center gap-1.5 cursor-pointer ${
            activeTab === 'api'
              ? 'bg-white text-slate-900 shadow-md'
              : 'text-slate-200 hover:text-white hover:bg-white/10'
          }`}
        >
          <span>🔌</span>
          <span>API & Security</span>
        </button>
      </div>
    </div>
  );
};
