export interface Extension {
  id: string;
  name: string;
  dept: string;
  sip: string;
  phone: string;
  keywords: string[];
}

export interface ExtensionTransfer {
  extension: string;
  name: string;
  department: string;
  sip_uri: string;
  phone_number: string;
  reason?: string;
  warm_transfer_notes?: string;
}

export interface MessageItem {
  id: string;
  type: 'user' | 'bot' | 'transfer' | 'summary';
  text: string;
  audioUrl?: string | null;
  timestamp: number;
  transfer?: ExtensionTransfer;
  summaryData?: {
    duration: number;
    callId: string;
  };
  flagged?: boolean;
  flagReason?: string;
  correctedText?: string;
  timings?: {
    asr?: number;
    llm?: number;
    tts?: number;
    total?: number;
  };
}

export interface TurnRecord {
  turnId: string;
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string | null;
  timestamp: number;
  timings?: {
    asr?: number;
    llm?: number;
    tts?: number;
    total?: number;
  };
  provider?: string;
  intent?: string;
  action?: string;
  confidence?: number;
  flagged?: boolean;
  flagReason?: string;
  correctedText?: string;
}

export interface CallLogSession {
  callId: string;
  direction: 'inbound' | 'outbound';
  callerId: string;
  customerName?: string;
  status: string;
  disposition: string;
  campaign?: string;
  language?: string;
  turns?: number;
  startTime?: number;
  endTime?: number;
  duration_seconds?: number;
  transferredTo?: Extension;
  history?: TurnRecord[];
  flagged?: boolean;
}

export interface LanguageConfig {
  code: string;
  name: string;
  nativeName: string;
  voice: string;
  geminiVoice: string;
  asrCode: string;
  scriptType: 'Latin' | 'Devanagari';
  repeatPrompt: string;
  llmFallback: string;
  transferLine: string;
  dncLine: string;
  maxCallLengthSecs: number;
}

export interface CampaignConfig {
  id: string;
  name: string;
  persona: string;
  goal: string;
  language: string;
  voice: string;
  greeting: string;
  defaultTransferExt: string;
  callingHours: {
    start: string;
    end: string;
    timezone: string;
    is24x7: boolean;
  };
  maxCallLengthSecs: number;
  faqSnippet: string;
  dos: string[];
  donts: string[];
}

export interface WebhookTurnResult {
  call_id: string;
  action: string;
  intent: string;
  transcription?: string;
  reply: string;
  audio_url?: string;
  audio_format?: string;
  disposition: string;
  confidence?: number;
  transfer?: ExtensionTransfer | null;
  timing_ms?: {
    asr?: number;
    llm?: number;
    tts?: number;
    total?: number;
  };
  session?: {
    turns?: number;
    status?: string;
    disposition?: string;
    language?: string;
  };
  idempotent_replay?: boolean;
}

export interface ChaosConfig {
  simulateAsrFail: boolean;
  simulateLlmFail: boolean;
  simulateTtsFail: boolean;
  forceProvider: 'none' | 'groq' | 'gemini' | 'all_down';
}

export interface AcceptanceTestItem {
  id: string;
  category: string;
  name: string;
  scenario: string;
  input: string;
  expectedAction: 'continue' | 'transfer' | 'hangup' | 'speak_and_listen';
  expectedDisposition?: string;
  expectedIntent?: string;
  language?: string;
  campaign?: string;
  passed?: boolean;
  actualReply?: string;
  actualAction?: string;
  latency_ms?: number;
}
