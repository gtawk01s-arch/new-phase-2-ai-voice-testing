import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), override: true });

function getGeminiKey() {
  const candidatePaths = [
    path.join(ROOT_DIR, '.env'),
    path.join(ROOT_DIR, '..', '.dev.env.json'),
    '/app/.dev.env.json',
    path.join(ROOT_DIR, '.dev.env.json')
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8');
        if (p.endsWith('.json')) {
          const parsed = JSON.parse(content);
          const k = parsed.GEMINI_API_KEY || parsed.API_KEY;
          if (k && k !== 'MY_GEMINI_API_KEY' && k.length > 10) return k.trim();
        } else {
          const match = content.match(/(?:GEMINI_API_KEY|API_KEY)=([^\r\n]+)/);
          if (match && match[1] && match[1].length > 10 && match[1] !== 'MY_GEMINI_API_KEY') {
            return match[1].trim();
          }
        }
      }
    } catch (e) {}
  }

  const k = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  if (k && k !== 'MY_GEMINI_API_KEY' && k.length > 10) {
    return k.trim();
  }
  return '';
}

function getGroqKey() {
  const candidatePaths = [
    path.join(ROOT_DIR, '.env'),
    path.join(ROOT_DIR, '..', '.dev.env.json'),
    '/app/.dev.env.json',
    path.join(ROOT_DIR, '.dev.env.json')
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8');
        if (p.endsWith('.json')) {
          const parsed = JSON.parse(content);
          const k = parsed.GROQ_API_KEY;
          if (k && k.startsWith('gsk_')) return k.trim();
        } else {
          const match = content.match(/GROQ_API_KEY=([^\r\n]+)/);
          if (match && match[1] && match[1].trim().startsWith('gsk_')) {
            return match[1].trim();
          }
        }
      }
    } catch (e) {}
  }
  const k = process.env.GROQ_API_KEY || '';
  if (k && k.startsWith('gsk_')) return k.trim();
  return '';
}

// Runtime chaos injection for testing provider outages & fallbacks
export const CHAOS_STATE = {
  simulateAsrFail: false,
  simulateLlmFail: false,
  simulateTtsFail: false,
  forceProvider: 'none' // 'none' | 'groq' | 'gemini' | 'all_down'
};

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  ENV: process.env.NODE_ENV || 'development',

  // Providers & Keys
  get GEMINI_API_KEY() {
    return getGeminiKey();
  },
  get GROQ_API_KEY() {
    return getGroqKey();
  },
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',

  // Fallback Models Chain
  GEMINI_MODELS: [
    'gemini-3.8-flash',
    'gemini-3.1-flash-lite',
    'gemini-flash-latest'
  ],
  GROQ_MODELS: [
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b'
  ],

  // Security Configuration (HMAC, Shared Secret, IP Allowlist)
  SECURITY: {
    SHARED_SECRET: process.env.WEBHOOK_SECRET || 'ai-telephony-secret-2026',
    HMAC_HEADER: 'x-webhook-signature',
    SECRET_HEADER: 'x-shared-secret',
    ENFORCE_AUTH: process.env.ENFORCE_WEBHOOK_AUTH === 'true',
    ALLOWED_IPS: ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']
  },

  // Session TTL and Memory Leak Protection
  SESSION_TTL: {
    MAX_AGE_MS: 15 * 60 * 1000,      // 15 minutes max call session lifetime
    IDLE_TIMEOUT_MS: 5 * 60 * 1000,   // 5 minutes inactivity timeout
    SWEEP_INTERVAL_MS: 30 * 1000,     // Sweep every 30 seconds
    MAX_CAPACITY: 500,                // Max concurrent in-memory sessions
    IDEMPOTENCY_TTL_MS: 5 * 60 * 1000 // Cache retried webhook payloads for 5 minutes
  },

  // Timeouts (ms)
  TIMEOUTS: {
    LLM_PER_PROVIDER: 3000,
    ASR_GEMINI: 3000,
    TTS_EDGE: 3000,
    TOTAL_BUDGET: 3000
  },

  // Audio configuration
  AUDIO: {
    CACHE_DIR: path.join(ROOT_DIR, 'audio_cache'),
    TEMP_DIR: path.join(os.tmpdir(), 'ai-call-assistant-temp'),
    DEFAULT_OUTPUT_FORMAT: 'mp3', // 'mp3' | 'wav' | 'mulaw_8k'
    DEFAULT_VOICE: 'en-US-JennyNeural',
    SAMPLE_RATE: 16000
  },

  // Directory of PBX Extensions for Call Transfers
  EXTENSIONS: [
    {
      id: '101',
      name: 'General Customer Support',
      dept: 'Customer Support',
      sip: 'sip:101@pbx.local',
      phone: '+18005550101',
      keywords: ['support', 'general', 'help', 'representative', 'agent', 'person', 'human', 'sahayata', 'madad', 'सपोर्ट', 'मदद', 'सहायता', 'कस्टमर केयर']
    },
    {
      id: '102',
      name: 'Billing & Payments',
      dept: 'Billing & Accounting',
      sip: 'sip:102@pbx.local',
      phone: '+18005550102',
      keywords: ['bill', 'billing', 'payment', 'pay', 'invoice', 'charge', 'due', 'balance', 'refund', 'paisa', 'bhugtan', 'बिलिंग', 'बिल', 'भुगतान', 'पैसा', 'खाता']
    },
    {
      id: '103',
      name: 'Technical Support Escalations',
      dept: 'Technical Services',
      sip: 'sip:103@pbx.local',
      phone: '+18005550103',
      keywords: ['technical', 'tech', 'broken', 'error', 'bug', 'device', 'hardware', 'troubleshoot', 'offline', 'kharab', 'तकनीकी', 'टेक्निकल', 'खराबी']
    },
    {
      id: '104',
      name: 'Sales & New Accounts',
      dept: 'Sales',
      sip: 'sip:104@pbx.local',
      phone: '+18005550104',
      keywords: ['sales', 'buy', 'purchase', 'new account', 'pricing', 'quote', 'upgrade', 'order', 'deal', 'kharidna', 'सेल्स', 'बिक्री', 'खरीदना', 'नया खाता']
    },
    {
      id: '200',
      name: 'Human Supervisor / Tier 2 Escalation',
      dept: 'Executive Escalations',
      sip: 'sip:200@pbx.local',
      phone: '+18005550200',
      keywords: ['supervisor', 'manager', 'escalate', 'tier 2', 'complaint', 'dispute', 'angry', 'unacceptable', 'adhikari', 'सुपरवाइजर', 'मैनेजर', 'अधिकारी', 'सीनियर']
    }
  ],

  // Multi-Language System Configuration (English, Hindi, Hinglish)
  LANGUAGES: {
    en: {
      code: 'en',
      name: 'English',
      nativeName: 'English (US)',
      voice: 'en-US-JennyNeural',
      geminiVoice: 'Kore',
      asrCode: 'en',
      scriptType: 'Latin',
      repeatPrompt: 'Could you repeat that?',
      llmFallback: 'I apologize, our automated system is experiencing a technical issue. Let me transfer you directly to a specialist for immediate assistance. Please stay on the line.',
      transferLine: 'Certainly! I am transferring your call directly to {name} on extension {ext}. Please stay on the line.',
      dncLine: 'Understood. I have recorded your request and removed your phone number from our call list. Have a good day. Goodbye.',
      maxCallLengthSecs: 300
    },
    hi: {
      code: 'hi',
      name: 'Hindi',
      nativeName: 'हिंदी (Hindi)',
      voice: 'hi-IN-SwaraNeural',
      geminiVoice: 'Kore',
      asrCode: 'hi',
      scriptType: 'Devanagari',
      repeatPrompt: 'क्या आप कृपया उसे दोहरा सकते हैं?',
      llmFallback: 'क्षमा करें, हमारे सिस्टम में तकनीकी समस्या आ रही है। मैं आपकी कॉल तुरंत एक विशेषज्ञ को ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।',
      transferLine: 'अवश्य! मैं आपकी कॉल एक्सटेंशन {ext} पर {name} को ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।',
      dncLine: 'समझ गया। मैंने आपका अनुरोध दर्ज कर लिया है और आपका नंबर हमारी कॉल सूची से हटा दिया है। आपका दिन शुभ हो। नमस्ते।',
      maxCallLengthSecs: 300
    },
    'hi-Latn': {
      code: 'hi-Latn',
      name: 'Hinglish',
      nativeName: 'Hinglish (Conversational)',
      voice: 'hi-IN-SwaraNeural',
      geminiVoice: 'Kore',
      asrCode: 'hi',
      scriptType: 'Latin', // Conversational Roman script for TTS voices
      repeatPrompt: 'Could you please repeat that? Mujhe theek se sunai nahi diya.',
      llmFallback: 'Sorry, hamara system abhi technical issue face kar raha hai. Main aapki call turant ek specialist ko transfer kar raha hoon. Please line par bane rahein.',
      transferLine: 'Sure! Main aapki call extension {ext} par {name} ko transfer kar raha hoon. Please hold kijiye.',
      dncLine: 'Samajh gaya. Maine aapka phone number hamari call list se remove kar diya hai. Have a nice day. Goodbye.',
      maxCallLengthSecs: 300
    }
  },

  // Production Campaigns with realistic persona, language, goals, calling hours, max call length, dos/don'ts, and FAQs
  CAMPAIGNS: {
    support: {
      id: 'support',
      name: 'General Customer Care (EN)',
      persona: 'Alex, Senior Customer Care Voice Specialist',
      goal: 'Resolve customer questions efficiently, accurately, and courteously, transferring to specialist departments when required.',
      language: 'en',
      voice: 'en-US-JennyNeural',
      defaultTransferExt: '101',
      callingHours: { start: '09:00', end: '18:00', timezone: 'America/New_York', is24x7: false },
      maxCallLengthSecs: 300,
      greeting: 'Thank you for calling Customer Support. I am Alex, your automated AI voice agent. What can I help you with today?',
      faqSnippet: `
        - Return Policy: Full refund within 30 days with receipt, or store credit if receipt is missing.
        - Support Hours: 24/7 automated line; live specialist extensions available Monday-Friday 9 AM - 6 PM EST.
        - Account Verification: Verify with last 4 digits of phone number or order number.
      `,
      dos: [
        'Give clear, factual answers in 1-2 spoken sentences (max 25-30 words).',
        'Speak in natural, warm spoken English.',
        'Admit you are an automated AI agent if asked directly.'
      ],
      donts: [
        'Do not use emojis, markdown, bullet points, or code blocks.',
        'Do not give answers longer than 3 sentences.',
        'Do not invent fictional tracking numbers or personal details.'
      ]
    },
    billing: {
      id: 'billing',
      name: 'Billing & Invoice Inquiries (EN)',
      persona: 'Jordan, Billing Services Specialist',
      goal: 'Assist callers with balances, payment methods, due dates, and receipts.',
      language: 'en',
      voice: 'en-US-JennyNeural',
      defaultTransferExt: '102',
      callingHours: { start: '09:00', end: '17:00', timezone: 'America/New_York', is24x7: false },
      maxCallLengthSecs: 300,
      greeting: 'Thank you for calling Billing and Accounts. I am Jordan, your virtual billing assistant. How can I help with your account today?',
      faqSnippet: `
        - Due Dates: Invoices are net-30 days from billing date.
        - Accepted Payment: Visa, MasterCard, Amex, ACH bank transfer, and online portal.
        - Late Fees: $15 fee applied after a 7-day grace period.
      `,
      dos: [
        'Prompt for invoice or account number if needed.',
        'Transfer to Extension 102 if caller disputes a charge or wants manual processing.'
      ],
      donts: [
        'Never ask for or store full credit card numbers or CVV.'
      ]
    },
    sales: {
      id: 'sales',
      name: 'Inbound Sales & Solutions (EN)',
      persona: 'Morgan, Solutions Advisor',
      goal: 'Qualify inbound caller interest, provide high-level pricing, and connect to a sales executive.',
      language: 'en',
      voice: 'en-US-JennyNeural',
      defaultTransferExt: '104',
      callingHours: { start: '09:00', end: '19:00', timezone: 'America/New_York', is24x7: false },
      maxCallLengthSecs: 300,
      greeting: 'Thanks for calling Sales. I am Morgan, your AI solutions advisor. Are you looking to start a new service or upgrade an existing plan?',
      faqSnippet: `
        - Starter Plan: $29/month per seat, unlimited voice calls.
        - Pro Plan: $79/month per seat with dedicated dialer CRM integration.
        - Enterprise: Custom SLA with multi-trunk PBX routing.
      `,
      dos: [
        'Highlight the core benefits and offer connection to Extension 104 for a live quote.'
      ],
      donts: [
        'Do not hard-sell or press callers.'
      ]
    },
    support_hi: {
      id: 'support_hi',
      name: 'Customer Care (हिंदी - Hindi)',
      persona: 'आरव (Aarav), कस्टमर सपोर्ट वॉयस एजेंट',
      goal: 'ग्राहकों के सवालों का शुद्ध, सरल हिंदी में त्वरित समाधान करना और आवश्यकता पड़ने पर संबंधित विभाग को ट्रांसफर करना।',
      language: 'hi',
      voice: 'hi-IN-SwaraNeural',
      defaultTransferExt: '101',
      callingHours: { start: '09:00', end: '18:00', timezone: 'Asia/Kolkata', is24x7: true },
      maxCallLengthSecs: 300,
      greeting: 'कस्टमर सपोर्ट में कॉल करने के लिए धन्यवाद। मैं आरव हूँ, आपका एआई वॉयस असिस्टेंट। आज मैं आपकी क्या सहायता कर सकता हूँ?',
      faqSnippet: `
        - वापसी नीति (Return Policy): रसीद के साथ 30 दिनों के भीतर पूरा रिफंड, या रसीद न होने पर स्टोर क्रेडिट।
        - सहायता समय (Support Hours): 24/7 ऑटोमेटेड लाइन; लाइव एजेंट सोमवार से शुक्रवार सुबह 9 बजे से शाम 6 बजे तक।
        - सत्यापन (Verification): फ़ोन नंबर के अंतिम 4 अंक या आर्डर नंबर।
      `,
      dos: [
        'स्पष्ट और आदरणीय हिंदी में 1-2 वाक्यों में उत्तर दें।',
        'सीधे प्रश्न पूछने पर बताएं कि आप एक स्वचालित एआई सहायक हैं।'
      ],
      donts: [
        'इमोजी, मार्कडाउन या बुलेट पॉइंट्स का उपयोग न करें।',
        '2-3 वाक्यों से अधिक लंबा उत्तर न दें।'
      ]
    },
    support_hinglish: {
      id: 'support_hinglish',
      name: 'Customer Support (Hinglish)',
      persona: 'Rohan, Customer Voice Specialist',
      goal: 'Help users in natural conversational Hinglish (Romanized Hindi-English mix) and transfer to specialists when requested.',
      language: 'hi-Latn',
      voice: 'hi-IN-SwaraNeural',
      defaultTransferExt: '101',
      callingHours: { start: '09:00', end: '20:00', timezone: 'Asia/Kolkata', is24x7: true },
      maxCallLengthSecs: 300,
      greeting: 'Hello! Customer Support mein call karne ke liye thank you. Main Rohan hoon, aapka AI voice assistant. Aaj main aapki kya help kar sakta hoon?',
      faqSnippet: `
        - Return Policy: Receipt ke sath 30 days ke andar full refund milta hai, bina receipt ke store credit.
        - Support Hours: 24/7 automated assistant available hai; live executives Monday to Friday 9 AM to 6 PM IST milenge.
        - Verification: Phone number ke last 4 digits ya order ID se account verify hota hai.
      `,
      dos: [
        'Reply in natural conversational Hinglish in the exact Roman script (e.g., "Aapki call transfer kar raha hoon").',
        'Keep replies strictly to 1-2 spoken sentences.'
      ],
      donts: [
        'Do not use Devanagari script for Hinglish campaign (use Latin characters only).',
        'No emojis, markdown or bullet points.'
      ]
    }
  }
};

export function getCampaign(campaignId) {
  return CONFIG.CAMPAIGNS[campaignId] || CONFIG.CAMPAIGNS.support;
}

export function getLanguage(langCode) {
  return CONFIG.LANGUAGES[langCode] || CONFIG.LANGUAGES.en;
}
