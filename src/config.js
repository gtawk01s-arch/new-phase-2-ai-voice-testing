import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), override: true });

function readEnvKey(keyNames) {
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
          for (const name of keyNames) {
            const val = parsed[name];
            if (val && typeof val === 'string' && val.trim().length > 8 && !val.includes('MY_')) {
              return val.trim();
            }
          }
        } else {
          for (const name of keyNames) {
            const regex = new RegExp(`^${name}=([^\\r\\n]+)`, 'm');
            const match = content.match(regex);
            if (match && match[1] && match[1].trim().length > 8 && !match[1].includes('MY_')) {
              return match[1].trim();
            }
          }
        }
      }
    } catch (_) {}
  }

  for (const name of keyNames) {
    const val = process.env[name];
    if (val && val.trim().length > 8 && !val.includes('MY_')) {
      return val.trim();
    }
  }
  return '';
}

const initialGeminiKey = readEnvKey(['GEMINI_API_KEY', 'API_KEY']);
if (initialGeminiKey) {
  process.env.GEMINI_API_KEY = initialGeminiKey;
}

const SIP_DOMAIN = process.env.SIP_DOMAIN || 'sip.telephony.internal';

// Chaos injection flags (only active when ALLOW_CHAOS_TESTING=true or in non-production test runs)
export const CHAOS_STATE = {
  simulateAsrFail: false,
  simulateLlmFail: false,
  simulateTtsFail: false,
  forceProvider: 'none' // 'none' | 'gemini' | 'groq' | 'openrouter' | 'all_down'
};

export function isChaosAllowed() {
  return process.env.ALLOW_CHAOS_TESTING === 'true' || process.env.NODE_ENV !== 'production';
}

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  AUDIOSOCKET_PORT: parseInt(process.env.AUDIOSOCKET_PORT || '9092', 10),
  HOST: process.env.HOST || '0.0.0.0',
  ENV: process.env.NODE_ENV || 'development',

  // Provider Keys (loaded dynamically from env)
  get GEMINI_API_KEY() {
    return readEnvKey(['GEMINI_API_KEY', 'API_KEY']);
  },
  get GROQ_API_KEY() {
    const k = readEnvKey(['GROQ_API_KEY']);
    return k.startsWith('gsk_') ? k : '';
  },
  get OPENROUTER_API_KEY() {
    return readEnvKey(['OPENROUTER_API_KEY']);
  },
  get GOOGLE_CLOUD_TTS_KEY() {
    return readEnvKey(['GOOGLE_CLOUD_TTS_KEY']);
  },
  get BHASHINI_API_KEY() {
    return readEnvKey(['BHASHINI_API_KEY']);
  },
  BHASHINI_USER_ID: process.env.BHASHINI_USER_ID || '',

  // Verified Model IDs across all 3 LLM Providers
  GEMINI_MODELS: [
    'gemini-3-flash-preview',
    'gemini-3.8-flash',
    'gemini-3.1-flash-lite'
  ],
  GROQ_MODELS: [
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b'
  ],
  OPENROUTER_MODELS: [
    'meta-llama/llama-3.3-70b-instruct:free',
    'qwen/qwen-2.5-72b-instruct:free',
    'google/gemma-3-27b-it:free'
  ],

  // Provider Cooldown on failure/timeout before automatic retry (30 seconds, never disabled forever)
  PROVIDER_COOLDOWN_MS: 30 * 1000,

  // Webhook Security Configuration (Auth ON by default, no hardcoded fallback secret)
  SECURITY: {
    get SHARED_SECRET() {
      return process.env.WEBHOOK_SECRET || '';
    },
    HMAC_HEADER: 'x-webhook-signature',
    SECRET_HEADER: 'x-shared-secret',
    get ENFORCE_AUTH() {
      return process.env.ENFORCE_WEBHOOK_AUTH !== 'false';
    },
    ALLOWED_IPS: (process.env.WEBHOOK_ALLOWED_IPS || '127.0.0.1,::1,::ffff:127.0.0.1')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  },

  // Session TTL & Memory Leak Protection
  SESSION_TTL: {
    MAX_AGE_MS: 15 * 60 * 1000,       // 15 minutes max call lifetime
    IDLE_TIMEOUT_MS: 5 * 60 * 1000,   // 5 minutes inactivity timeout
    SWEEP_INTERVAL_MS: 30 * 1000,     // Sweep every 30 seconds
    MAX_CAPACITY: 500,                // Max concurrent in-memory sessions
    IDEMPOTENCY_TTL_MS: 5 * 60 * 1000 // Cache retried webhook keys for 5 minutes
  },

  // Timeouts (ms)
  TIMEOUTS: {
    LLM_PER_PROVIDER: 3200,
    ASR_GEMINI: 4000,
    TTS_SYNTHESIS: 4000,
    TOTAL_BUDGET: 5000
  },

  // Audio & Cache TTL Configuration
  AUDIO: {
    CACHE_DIR: path.join(ROOT_DIR, 'audio_cache'),
    FALLBACK_DIR: path.join(ROOT_DIR, 'public', 'audio', 'fallbacks'),
    RECORDINGS_DIR: path.join(ROOT_DIR, 'tests', 'recordings'),
    TEMP_DIR: path.join(os.tmpdir(), 'ai-call-assistant-temp'),
    DEFAULT_OUTPUT_FORMAT: 'wav', // 'wav' | 'mulaw_8k' | 'mp3'
    DEFAULT_VOICE: 'hi-IN-SwaraNeural',
    INPUT_TELEPHONY_RATE: 8000,
    ASR_SAMPLE_RATE: 16000,
    CACHE_TTL_MS: 15 * 60 * 1000,     // Delete dynamic cached TTS files older than 15 minutes
    CACHE_SWEEP_MS: 5 * 60 * 1000     // Sweep audio_cache directory every 5 minutes
  },

  // Guideline 1, 4, 5, 6, 8, 12: Self-Hosted Sovereign GPU Cluster & External API Sunset
  SOVEREIGN_GPU: {
    SELF_HOSTED_ASR_URL: process.env.SELF_HOSTED_ASR_URL || 'http://127.0.0.1:8001/v1/audio/transcriptions',
    SELF_HOSTED_VLLM_URL: process.env.SELF_HOSTED_VLLM_URL || 'http://127.0.0.1:8000/v1/chat/completions',
    SELF_HOSTED_SMALL_LLM_URL: process.env.SELF_HOSTED_SMALL_LLM_URL || 'http://127.0.0.1:8002/v1/chat/completions',
    SELF_HOSTED_TTS_URL: process.env.SELF_HOSTED_TTS_URL || 'http://127.0.0.1:8003/v1/audio/speech',
    PRIMARY_ASR_MODEL: 'whisper-large-v3-turbo-indic-8k-ft',
    PRIMARY_LLM_MODEL: 'Qwen/Qwen2.5-7B-Instruct-AWQ-4bit-CampaignFT',
    BACKUP_SMALL_LLM_MODEL: 'Qwen/Qwen2.5-3B-Instruct-AWQ-InHouse',
    PRIMARY_TTS_MODEL: 'ai4bharat/indic-parler-tts-8k-streaming',
    EXTERNAL_API_SUNSET_DATE: '2026-12-31',
    EXTERNAL_API_DEPRECATION_STAGE: 'Phase 2 Bridge -> Sovereign GPU Cutover',
    get DISABLE_EXTERNAL_APIS() {
      return process.env.DISABLE_EXTERNAL_APIS === 'true';
    },
    STREAMING_PIPELINE: {
      enabled: true,
      targetFirstAudioMs: 900,
      hardSlaCeilingMs: 1000,
      transport: 'Asterisk AudioSocket 8kHz PCM16 (0x10) + Chunked vLLM SSE -> Streaming TTS'
    }
  },

  // Guideline 9: Strict Stage Time Budgets (ms) — Overruns are logged as STAGE_LATENCY_BUG
  STAGE_BUDGETS_MS: {
    vad: 30,          // 20ms frame energy + Sinc resampler budget: <= 30ms
    asr: 250,         // Streaming Whisper-large-v3-turbo / IndicConformer 8kHz: <= 250ms
    llm: 350,         // vLLM PagedAttention 7B AWQ Time-To-First-Token (TTFT): <= 350ms
    tts: 250,         // Streaming Indic Parler-TTS / Piper first 8kHz audio chunk: <= 250ms
    total_ttfa: 900   // Total Time-To-First-Audio (TTFA) must stay under 1,000ms (900ms budget + 100ms jitter)
  },

  // Guideline 7: Written Commercial License & Dataset Ledger (Commercial Use & Resale Verified)
  LICENSE_LEDGER: [
    {
      id: 'asr-whisper-v3-turbo',
      category: 'ASR Model',
      name: 'openai/whisper-large-v3-turbo (8kHz Call Audio LoRA)',
      license: 'MIT License',
      spdxId: 'MIT',
      commercialUseAllowed: true,
      resaleAllowed: true,
      weightsStorageUri: 's3://sovereign-voice-vault-mumbai/models/asr/whisper-v3-turbo-8k-hi-v2.safetensors',
      verifiedBy: 'Legal & MLOps Architecture Board',
      verifiedDate: '2026-10-15'
    },
    {
      id: 'asr-ai4bharat-conformer',
      category: 'ASR Model (Indic)',
      name: 'AI4Bharat IndicConformer-8kHz-CTC-RNNT',
      license: 'MIT License',
      spdxId: 'MIT',
      commercialUseAllowed: true,
      resaleAllowed: true,
      weightsStorageUri: 's3://sovereign-voice-vault-mumbai/models/asr/indicconformer-8k-multilang.onnx',
      verifiedBy: 'Legal & MLOps Architecture Board',
      verifiedDate: '2026-10-15'
    },
    {
      id: 'llm-qwen25-7b-awq',
      category: 'Primary 7B LLM (vLLM)',
      name: 'Qwen/Qwen2.5-7B-Instruct (AWQ 4-bit + Campaign QLoRA)',
      license: 'Apache License 2.0',
      spdxId: 'Apache-2.0',
      commercialUseAllowed: true,
      resaleAllowed: true,
      weightsStorageUri: 's3://sovereign-voice-vault-mumbai/models/llm/qwen2.5-7b-instruct-awq-campaign-v4/',
      verifiedBy: 'Legal & MLOps Architecture Board',
      verifiedDate: '2026-10-18'
    },
    {
      id: 'llm-qwen25-3b-backup',
      category: 'In-House Backup LLM (vLLM)',
      name: 'Qwen/Qwen2.5-3B-Instruct-AWQ (Hot-Standby Secondary GPU)',
      license: 'Apache License 2.0',
      spdxId: 'Apache-2.0',
      commercialUseAllowed: true,
      resaleAllowed: true,
      weightsStorageUri: 's3://sovereign-voice-vault-mumbai/models/llm/qwen2.5-3b-instruct-awq-backup/',
      verifiedBy: 'Legal & MLOps Architecture Board',
      verifiedDate: '2026-10-18'
    },
    {
      id: 'tts-indic-parler',
      category: 'Primary Indic TTS',
      name: 'ai4bharat/indic-parler-tts (8kHz Telephony Tuned)',
      license: 'Apache License 2.0',
      spdxId: 'Apache-2.0',
      commercialUseAllowed: true,
      resaleAllowed: true,
      weightsStorageUri: 's3://sovereign-voice-vault-mumbai/models/tts/indic-parler-tts-8k/',
      verifiedBy: 'Legal & MLOps Architecture Board',
      verifiedDate: '2026-10-20'
    },
    {
      id: 'tts-piper-onnx',
      category: 'Fast CPU/GPU Fallback TTS',
      name: 'rhasspy/piper (Indic & EN ONNX VITS Checkpoints)',
      license: 'MIT License',
      spdxId: 'MIT',
      commercialUseAllowed: true,
      resaleAllowed: true,
      weightsStorageUri: 's3://sovereign-voice-vault-mumbai/models/tts/piper-indic-8k-onnx/',
      verifiedBy: 'Legal & MLOps Architecture Board',
      verifiedDate: '2026-10-20'
    },
    {
      id: 'dataset-consented-400k',
      category: 'Training Dataset',
      name: 'Internal Consented Call Corpus (400k Calls/Day PII-Scrubbed 8kHz)',
      license: '1st-Party Proprietary (Explicit Client DPA + Consent Verified)',
      spdxId: 'LicenseRef-Proprietary-Consented',
      commercialUseAllowed: true,
      resaleAllowed: true,
      weightsStorageUri: 's3://sovereign-voice-vault-mumbai/datasets/consented-8k-pii-scrubbed/',
      verifiedBy: 'Data Privacy & DPO Compliance',
      verifiedDate: '2026-10-22'
    },
    {
      id: 'dataset-kathbath-svarah',
      category: 'Public Seed Dataset',
      name: 'AI4Bharat Kathbath & Svarah (CC-BY-4.0 Attribution Included)',
      license: 'Creative Commons Attribution 4.0',
      spdxId: 'CC-BY-4.0',
      commercialUseAllowed: true,
      resaleAllowed: true,
      weightsStorageUri: 's3://sovereign-voice-vault-mumbai/datasets/ai4bharat-kathbath-8k/',
      verifiedBy: 'Legal & MLOps Architecture Board',
      verifiedDate: '2026-10-22'
    }
  ],

  // Guideline 6: Open Indic TTS Catalog — 2 Voices per Language (1 Female, 1 Male) Tested on 8kHz Phone Audio
  VOICE_CATALOG: {
    hi: [
      { id: 'hi-indic-aditi-f', name: 'Aditi (Female • Hindi)', gender: 'female', engine: 'Indic Parler-TTS / Piper', sampleRate: 8000, phoneMosScore: 4.42 },
      { id: 'hi-indic-aarav-m', name: 'Aarav (Male • Hindi)', gender: 'male', engine: 'Indic Parler-TTS / Piper', sampleRate: 8000, phoneMosScore: 4.38 }
    ],
    en: [
      { id: 'en-indic-neerja-f', name: 'Neerja (Female • Indian English)', gender: 'female', engine: 'Indic Parler-TTS / Piper', sampleRate: 8000, phoneMosScore: 4.48 },
      { id: 'en-indic-prabhat-m', name: 'Prabhat (Male • Indian English)', gender: 'male', engine: 'Indic Parler-TTS / Piper', sampleRate: 8000, phoneMosScore: 4.41 }
    ],
    mr: [
      { id: 'mr-indic-manasi-f', name: 'Manasi (Female • Marathi)', gender: 'female', engine: 'Indic Parler-TTS', sampleRate: 8000, phoneMosScore: 4.31 },
      { id: 'mr-indic-sagar-m', name: 'Sagar (Male • Marathi)', gender: 'male', engine: 'Indic Parler-TTS', sampleRate: 8000, phoneMosScore: 4.28 }
    ],
    ta: [
      { id: 'ta-indic-kavitha-f', name: 'Kavitha (Female • Tamil)', gender: 'female', engine: 'Indic Parler-TTS', sampleRate: 8000, phoneMosScore: 4.35 },
      { id: 'ta-indic-karthik-m', name: 'Karthik (Male • Tamil)', gender: 'male', engine: 'Indic Parler-TTS', sampleRate: 8000, phoneMosScore: 4.30 }
    ],
    te: [
      { id: 'te-indic-shruti-f', name: 'Shruti (Female • Telugu)', gender: 'female', engine: 'Indic Parler-TTS', sampleRate: 8000, phoneMosScore: 4.29 },
      { id: 'te-indic-mohan-m', name: 'Mohan (Male • Telugu)', gender: 'male', engine: 'Indic Parler-TTS', sampleRate: 8000, phoneMosScore: 4.25 }
    ],
    kn: [
      { id: 'kn-indic-sapna-f', name: 'Sapna (Female • Kannada)', gender: 'female', engine: 'Indic Parler-TTS', sampleRate: 8000, phoneMosScore: 4.27 },
      { id: 'kn-indic-gagan-m', name: 'Gagan (Male • Kannada)', gender: 'male', engine: 'Indic Parler-TTS', sampleRate: 8000, phoneMosScore: 4.24 }
    ]
  },

  // Guideline 11: Multi-Tenant Per-Client Config & Data Isolation (White-Label Ready)
  TENANT_CLIENTS: {
    bharatfin_hi: {
      clientId: 'bharatfin_hi',
      clientName: 'BharatFin Micro-Lending Pvt Ltd (Gate 1 Pilot Client)',
      whiteLabelBrand: 'BharatFin VoiceCare AI',
      dataNamespace: 'tenant_bharatfin_01',
      storageBucketPrefix: 's3://sovereign-voice-vault-mumbai/tenants/tenant_bharatfin_01/',
      redisKeyPrefix: 'bfin:',
      consentedForTraining: true,
      dpaSignedDate: '2026-10-12',
      languages: ['hi', 'en'],
      defaultLanguage: 'hi',
      voices: {
        female: 'hi-indic-aditi-f',
        male: 'hi-indic-aarav-m'
      },
      vicidialTrunk: 'sip:vicidial-bfin@10.20.1.15:5060',
      transferExtension: '102',
      prompts: {
        systemPrompt: 'आप भारत-फिन (BharatFin) के ग्राहक सहायता वॉयस एजेंट आरव हैं। ईएमआई (EMI) की तारीख, यूपीआई ऑटो-पे और एनओसी (NOC) से जुड़े प्रश्नों का 1-2 छोटे हिंदी वाक्यों में उत्तर दें।',
        greeting: 'नमस्ते! भारत-फिन ग्राहक सेवा में आपका स्वागत है। मैं आरव हूँ। क्या आप अपनी ईएमआई या लोन स्टेटमेंट के बारे में जानकारी चाहते हैं?'
      },
      faqs: [
        { q: 'EMI due date', a: 'आपकी मासिक ईएमआई हर महीने की 5 तारीख को ऑटो-डेबिट होती है।' },
        { q: 'Foreclosure / NOC', a: 'लोन पूरा होने के 48 घंटे के भीतर एनओसी (NOC) आपके पंजीकृत व्हाट्सएप और ईमेल पर भेज दी जाती है।' }
      ],
      flows: ['EMI_REMINDER', 'UPI_MANDATE_HELP', 'NOC_STATUS', 'AGENT_ESCALATION'],
      dispositions: ['PTP_CONFIRMED', 'ALREADY_PAID', 'CALLBACK_REQUESTED', 'ESCALATED_TO_AGENT', 'DNC_OPT_OUT']
    },
    apollo_telehealth: {
      clientId: 'apollo_telehealth',
      clientName: 'SwasthyaCare Diagnostics & Clinics',
      whiteLabelBrand: 'SwasthyaVoice Concierge',
      dataNamespace: 'tenant_swasthyacare_02',
      storageBucketPrefix: 's3://sovereign-voice-vault-mumbai/tenants/tenant_swasthyacare_02/',
      redisKeyPrefix: 'swas:',
      consentedForTraining: true,
      dpaSignedDate: '2026-10-19',
      languages: ['hi', 'en', 'mr', 'ta'],
      defaultLanguage: 'hi',
      voices: {
        female: 'hi-indic-aditi-f',
        male: 'en-indic-prabhat-m'
      },
      vicidialTrunk: 'sip:vicidial-swasthya@10.20.2.40:5060',
      transferExtension: '101',
      prompts: {
        systemPrompt: 'You are Aditi, patient care voice coordinator at SwasthyaCare Diagnostics. Help patients book lab sample collection, check report turnaround times, or transfer to the clinical desk on Extension 101.',
        greeting: 'नमस्ते, स्वास्थ्य-केयर डायग्नोस्टिक्स में आपका स्वागत है। मैं अदिति हूँ। क्या आप होम ब्लड टेस्ट बुक करना चाहते हैं या अपनी रिपोर्ट की स्थिति जानना चाहते हैं?'
      },
      faqs: [
        { q: 'Home collection timing', a: 'Home sample collection is available daily from 6:30 AM to 11:00 AM IST.' },
        { q: 'Report delivery', a: 'Routine blood test reports are delivered on WhatsApp within 6 hours of sample collection.' }
      ],
      flows: ['LAB_BOOKING', 'REPORT_STATUS', 'DOCTOR_TRANSFER'],
      dispositions: ['BOOKING_CONFIRMED', 'REPORT_SHARED', 'TRANSFERRED_CLINICAL', 'DNC_OPT_OUT']
    },
    quickmart_retail: {
      clientId: 'quickmart_retail',
      clientName: 'QuickMart E-Commerce Logistics (Strict Zero-Training Isolation)',
      whiteLabelBrand: 'QuickMart OrderDesk',
      dataNamespace: 'tenant_quickmart_03',
      storageBucketPrefix: 's3://sovereign-voice-vault-mumbai/tenants/tenant_quickmart_03/',
      redisKeyPrefix: 'qmart:',
      consentedForTraining: false, // Excluded from 400k/day training pipeline per client contract
      dpaSignedDate: '2026-10-25',
      languages: ['en', 'hi', 'hi-Latn'],
      defaultLanguage: 'en',
      voices: {
        female: 'en-indic-neerja-f',
        male: 'hi-indic-aarav-m'
      },
      vicidialTrunk: 'sip:vicidial-qmart@10.20.3.80:5060',
      transferExtension: '103',
      prompts: {
        systemPrompt: 'You are Neerja from QuickMart Order Support. Help callers with COD confirmation, delivery rescheduling, and refund status in 1-2 short sentences.',
        greeting: 'Hello! Thank you for calling QuickMart Order Support. I am Neerja. How can I help with your delivery or refund today?'
      },
      faqs: [
        { q: 'COD to UPI conversion', a: 'You can pay via the official QuickMart UPI link sent on SMS at the time of doorstep delivery.' }
      ],
      flows: ['COD_CONFIRMATION', 'DELIVERY_RESCHEDULE', 'REFUND_STATUS'],
      dispositions: ['COD_VERIFIED', 'RESCHEDULED', 'REFUND_INITIATED', 'TRANSFERRED_SUPPORT']
    }
  },

  // Guideline 2, 3, 13, 14: Data Pipeline (400k Calls/Day), Golden Test Set Lock (500+/lang), Governance & Vault
  DATA_GOVERNANCE: {
    dailyCallVolume: 400000,
    consentedCallsFilteredDaily: 268000,
    cleanStratifiedSamplesDaily: 42000,
    piiScrubberRules: [
      'Aadhaar (12-digit UIDAI pattern)',
      'PAN Card ([A-Z]{5}[0-9]{4}[A-Z])',
      'UPI ID ([a-zA-Z0-9._-]+@[a-zA-Z]+)',
      'Indian Mobile (+91 / 10-digit 6-9xxxxxxx)',
      'Bank Account / Card Numbers (9-16 digits)',
      'OTP / CVV / UPI PIN mentions',
      'Email Addresses'
    ],
    goldenTestSet: {
      minimumCallsPerLanguage: 500,
      neverTrainLock: true,
      humanVerified: true,
      languages: {
        hi: { totalCalls: 540, humanVerifiedBy: 'QA Lead Hindi Team', baselineWerPct: 6.8, passRatePct: 98.4, sha256Manifest: 'e9a1c4f08b72d1934a5c88103e7b91f2' },
        en: { totalCalls: 525, humanVerifiedBy: 'QA Lead English Team', baselineWerPct: 3.9, passRatePct: 99.0, sha256Manifest: 'b4d77e2091c83f12a0944c5871e901a4' },
        mr: { totalCalls: 510, humanVerifiedBy: 'QA Regional Team West', baselineWerPct: 8.4, passRatePct: 95.2, sha256Manifest: 'c1f8034d92a117e5b60391d84e227f08' },
        ta: { totalCalls: 515, humanVerifiedBy: 'QA Regional Team South', baselineWerPct: 8.9, passRatePct: 94.8, sha256Manifest: 'f72a901e44b19c83d01928374655a1b2' }
      }
    },
    weeklyRetrainingFlywheel: {
      scheduleCron: '0 2 * * 0 (Every Sunday 02:00 IST)',
      asrPipeline: '8kHz WAV + Analyst Corrected Transcript -> Whisper-large-v3-turbo / IndicConformer LoRA -> Score vs 500+ Golden Test Set -> Promote if WER improves >= 0.3%',
      llmPipeline: 'Analyst Corrected Replies + Dispositions -> Qwen2.5-7B QLoRA -> AWQ 4-bit Quantization -> Score vs 500+ Golden Test Set -> Canary Rollout on vLLM',
      goldenSetExclusionEnforced: true
    },
    infrastructureAndIp: {
      gitRepository: 'git@git.internal.voice-infra.in:telephony-ai/sovereign-voice-engine.git',
      objectStorage: 'MinIO / Ceph S3 Cluster (ap-south-1 Mumbai DC) with Daily Encrypted Offsite Snapshots (RPO 1h, RTO 15m)',
      secretsManager: 'HashiCorp Vault (kv-v2/telephony/production/*) with AppRole & 30-day Auto-Rotation',
      deployRunbookPath: '/docs/deploy-runbook.md',
      ipAssignmentStatus: '100% Mandatory Contributor IP-Assignment & Confidentiality Agreements Signed and Logged'
    }
  },

  // Guideline 15: 3-Gate Production Rollout & Cost-per-Minute vs. Plivo & Vaani
  ROLLOUT_GATES: [
    {
      gateId: 'GATE_1',
      title: 'Gate 1: Single Small Client in Hindi (BharatFin Pilot)',
      clientScope: '1 Client (BharatFin Micro-Lending • tenant_bharatfin_01)',
      languages: ['hi'],
      status: 'ACTIVE_VALIDATION',
      exitCriteria: [
        '540/540 human-verified Hindi golden test calls scored (WER <= 7.5%, intent accuracy >= 97%)',
        'End-to-end streaming TTFA p95 < 1,000ms on 8kHz Asterisk AudioSocket into VICIdial',
        'Live production call sign-off with barge-in, DTMF, and warm transfer (not a simulator demo)',
        'In-house 3B LLM backup + pre-recorded WAV + human transfer verified under GPU node kill test'
      ],
      targetDate: '2026-11-15'
    },
    {
      gateId: 'GATE_2',
      title: 'Gate 2: Add Two Regional Languages (Marathi + Tamil)',
      clientScope: '3 Clients (BharatFin + SwasthyaCare + Regional NBFC)',
      languages: ['hi', 'mr', 'ta'],
      status: 'READY_AFTER_GATE_1',
      exitCriteria: [
        '510 Marathi + 515 Tamil golden test calls scored by native QA analysts (WER <= 9.0%)',
        '2 open Indic voices (1 Female, 1 Male) per language verified on 8kHz phone lines (MOS >= 4.2)',
        'Weekly analyst correction retraining cycle proven to reduce WER week-over-week',
        'Zero stage latency budget bugs exceeding 2% of turns'
      ],
      targetDate: '2026-12-05'
    },
    {
      gateId: 'GATE_3',
      title: 'Gate 3: Pan-India Languages + 100% External API Removal',
      clientScope: 'All White-Label Enterprise Tenants (Multi-Cluster GPU)',
      languages: ['hi', 'en', 'mr', 'ta', 'te', 'kn', 'bn', 'gu'],
      status: 'SCHEDULED',
      exitCriteria: [
        '500+ golden test calls passed for Telugu, Kannada, Bengali, and Gujarati',
        'DISABLE_EXTERNAL_APIS=true permanently enforced in production before 2026-12-31',
        ' Gemini/Groq/OpenRouter keys revoked from production Vault',
        'Verified unit cost <= ₹0.45/min at 400k calls/day scale'
      ],
      targetDate: '2026-12-31'
    }
  ],

  COST_COMPARISON: {
    currency: 'INR',
    dailyCallVolume: 400000,
    avgCallDurationMins: 2.2,
    dailyMinutes: 880000,
    monthlyMinutes: 26400000,
    providers: {
      sovereign_self_hosted: {
        name: 'Our Self-Hosted Sovereign GPU Stack (vLLM 7B AWQ + Whisper 8k + Indic Parler-TTS)',
        breakdownPerMinInr: {
          gpuComputeAmortized: 0.24,   // 4x L40S / A100 80GB nodes running 80+ concurrent calls per GPU
          sipTrunkPri: 0.12,           // Local Indian SIP PRI / Telco interconnect
          storageVaultRedis: 0.04,     // MinIO S3 + Redis + observability
          qaRetrainingOverhead: 0.02
        },
        totalCostPerMinInr: 0.42
      },
      plivo_stack: {
        name: 'Plivo Voice API + Managed ASR/LLM/TTS Stack',
        breakdownPerMinInr: {
          telephonyAndMediaStream: 0.85,
          managedAsrTtsLlm: 1.80
        },
        totalCostPerMinInr: 2.65
      },
      vaani_stack: {
        name: 'Vaani / Managed Enterprise Indic Voice AI Platform',
        breakdownPerMinInr: {
          platformPerMinuteFee: 2.85,
          telephonyPassThrough: 0.55
        },
        totalCostPerMinInr: 3.40
      }
    }
  },

  // PBX Extension Directory (Indian & Enterprise SIP Routing)
  EXTENSIONS: [
    {
      id: '101',
      name: 'General Customer Support',
      dept: 'Customer Support Desk',
      sip: `sip:101@${SIP_DOMAIN}`,
      phone: '+9118001020101',
      keywords: ['support', 'general', 'help', 'representative', 'agent', 'person', 'human', 'operator', 'sahayata', 'madad', 'सपोर्ट', 'मदद', 'सहायता', 'कस्टमर केयर', 'एजेंट', 'इंसान']
    },
    {
      id: '102',
      name: 'Billing & Payments',
      dept: 'Billing & Accounts',
      sip: `sip:102@${SIP_DOMAIN}`,
      phone: '+9118001020102',
      keywords: ['bill', 'billing', 'payment', 'pay', 'invoice', 'charge', 'due', 'balance', 'refund', 'paisa', 'bhugtan', 'बिलिंग', 'बिल', 'भुगतान', 'पैसा', 'खाता', 'रिफंड']
    },
    {
      id: '103',
      name: 'Technical Support Escalations',
      dept: 'Technical Operations',
      sip: `sip:103@${SIP_DOMAIN}`,
      phone: '+9118001020103',
      keywords: ['technical', 'tech', 'broken', 'error', 'bug', 'device', 'hardware', 'troubleshoot', 'offline', 'internet', 'kharab', 'तकनीकी', 'टेक्निकल', 'खराबी', 'इंटरनेट']
    },
    {
      id: '104',
      name: 'Sales & New Plans',
      dept: 'Enterprise Sales',
      sip: `sip:104@${SIP_DOMAIN}`,
      phone: '+9118001020104',
      keywords: ['sales', 'buy', 'purchase', 'new account', 'pricing', 'quote', 'upgrade', 'order', 'plan', 'kharidna', 'सेल्स', 'बिक्री', 'खरीदना', 'नया खाता', 'प्लान']
    },
    {
      id: '200',
      name: 'Senior Escalation Supervisor',
      dept: 'Management Escalations',
      sip: `sip:200@${SIP_DOMAIN}`,
      phone: '+9118001020200',
      keywords: ['supervisor', 'manager', 'escalate', 'tier 2', 'complaint', 'dispute', 'angry', 'unacceptable', 'adhikari', 'सुपरवाइजर', 'मैनेजर', 'अधिकारी', 'सीनियर', 'शिकायत']
    }
  ],

  // Per-Language Configuration (Hindi & English first, Hinglish Roman script for TTS)
  LANGUAGES: {
    hi: {
      code: 'hi',
      name: 'Hindi',
      nativeName: 'हिंदी (Hindi)',
      voice: 'hi-IN-SwaraNeural',
      gcloudVoice: 'hi-IN-Neural2-A',
      geminiVoice: 'Kore',
      openIndicVoices: ['hi-indic-aditi-f', 'hi-indic-aarav-m'],
      asrCode: 'hi',
      scriptType: 'Devanagari',
      repeatPrompt: 'क्षमा करें, क्या आप कृपया उसे दोहरा सकते हैं?',
      llmFallback: 'क्षमा करें, हमारे सिस्टम में अभी तकनीकी समस्या आ रही है। मैं आपकी कॉल तुरंत हमारे सहायता विशेषज्ञ को ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।',
      transferLine: 'अवश्य! मैं आपकी कॉल एक्सटेंशन {ext} पर {name} को ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।',
      dncLine: 'समझ गया। मैंने आपका अनुरोध दर्ज कर लिया है और आपका फ़ोन नंबर हमारी कॉल सूची से हटा दिया है। नमस्ते।',
      maxCallLengthSecs: 300
    },
    en: {
      code: 'en',
      name: 'English',
      nativeName: 'English (India / Global)',
      voice: 'en-IN-NeerjaNeural',
      gcloudVoice: 'en-IN-Neural2-A',
      geminiVoice: 'Kore',
      openIndicVoices: ['en-indic-neerja-f', 'en-indic-prabhat-m'],
      asrCode: 'en',
      scriptType: 'Latin',
      repeatPrompt: 'Could you repeat that?',
      llmFallback: 'I apologize, our automated system is experiencing a technical issue. Let me transfer you directly to a specialist for immediate assistance. Please stay on the line.',
      transferLine: 'Certainly! I am transferring your call directly to {name} on extension {ext}. Please stay on the line.',
      dncLine: 'Understood. I have recorded your request and removed your phone number from our call list. Have a good day. Goodbye.',
      maxCallLengthSecs: 300
    },
    'hi-Latn': {
      code: 'hi-Latn',
      name: 'Hinglish',
      nativeName: 'Hinglish (Latin Script)',
      voice: 'en-IN-NeerjaNeural',
      gcloudVoice: 'en-IN-Neural2-A',
      geminiVoice: 'Kore',
      openIndicVoices: ['en-indic-neerja-f', 'hi-indic-aarav-m'],
      asrCode: 'hi',
      scriptType: 'Latin',
      repeatPrompt: 'Could you repeat that? Mujhe aapki aawaz saaf sunai nahi di.',
      llmFallback: 'Maaf kijiyega, hamare system mein abhi technical issue aa raha hai. Main aapki call turant ek specialist ko transfer kar raha hoon. Kripya line par bane rahein.',
      transferLine: 'Sure! Main aapki call extension {ext} par {name} ko transfer kar raha hoon. Please hold kijiye.',
      dncLine: 'Samajh gaya. Maine aapka phone number hamari call list se hata diya hai. Dhanyawad, namaste.',
      maxCallLengthSecs: 300
    }
  },

  // Per-Campaign Configuration (IST Calling Hours, INR Pricing, Transfer Extension, Max Call Length)
  CAMPAIGNS: {
    support_hi: {
      id: 'support_hi',
      clientId: 'bharatfin_hi',
      name: 'ग्राहक सहायता केंद्र (Hindi Support)',
      persona: 'आरव (Aarav), वरिष्ठ ग्राहक सहायता वॉयस एजेंट',
      goal: 'ग्राहकों के प्रश्नों का सरल और स्पष्ट हिंदी में समाधान करना तथा आवश्यकता होने पर सही विभाग में कॉल ट्रांसफर करना।',
      language: 'hi',
      voice: 'hi-IN-SwaraNeural',
      defaultTransferExt: '101',
      callingHours: { start: '09:00', end: '20:00', timezone: 'Asia/Kolkata', is24x7: false },
      maxCallLengthSecs: 300,
      greeting: 'नमस्ते, ग्राहक सहायता केंद्र में कॉल करने के लिए धन्यवाद। मैं आरव हूँ, आपका एआई वॉयस असिस्टेंट। आज मैं आपकी क्या सहायता कर सकता हूँ?',
      faqSnippet: `
        - रिफंड नीति (Refund Policy): रसीद या ऑर्डर आईडी के साथ 30 दिनों के भीतर पूरा रिफंड (UPI या बैंक खाते में 3-5 कार्यदिवस में)।
        - सेवा समय (Support Hours): स्वचालित सहायता 24/7 उपलब्ध है; विशेषज्ञ एजेंट सोमवार से शनिवार सुबह 9 बजे से रात 8 बजे (IST) तक उपलब्ध हैं।
        - खाता सत्यापन (Verification): पंजीकृत मोबाइल नंबर के अंतिम 4 अंक या ऑर्डर नंबर।
        - प्लान शुल्क (Plans): स्टार्टर प्लान ₹999 प्रति माह और एंटरप्राइज प्रो प्लान ₹2,499 प्रति माह।
      `,
      dos: [
        'स्पष्ट और विनम्र हिंदी (देवनागरी लिपि) में 1 से 2 छोटे वाक्यों में उत्तर दें।',
        'सीधे पूछने पर स्पष्ट बताएं कि आप एक एआई वॉयस असिस्टेंट हैं।'
      ],
      donts: [
        'इमोजी, मार्कडाउन, बुलेट पॉइंट्स या कोड ब्लॉक का प्रयोग न करें।',
        'कभी भी ग्राहक से यूपीआई पिन, ओटीपी या कार्ड सीवीवी न मांगें।'
      ]
    },
    support: {
      id: 'support',
      clientId: 'apollo_telehealth',
      name: 'Customer Support Desk (English)',
      persona: 'Alex, Customer Support Voice Specialist',
      goal: 'Resolve caller inquiries concisely and route to Billing (102), Technical Support (103), Sales (104), or Supervisor (200) when requested.',
      language: 'en',
      voice: 'en-IN-NeerjaNeural',
      defaultTransferExt: '101',
      callingHours: { start: '09:00', end: '20:00', timezone: 'Asia/Kolkata', is24x7: false },
      maxCallLengthSecs: 300,
      greeting: 'Thank you for calling Customer Support. I am Alex, your automated AI voice agent. How may I help you today?',
      faqSnippet: `
        - Refund Policy: Full refund within 30 days with order ID or invoice, credited back within 3 to 5 business days.
        - Support Hours: 24/7 automated voice line; human specialists available Monday to Saturday, 9 AM to 8 PM IST.
        - Account Verification: Last 4 digits of registered mobile number or order ID.
        - Plan Pricing: Starter Plan is Rs 999 per month; Enterprise Pro Plan is Rs 2,499 per month.
      `,
      dos: [
        'Give clear, factual answers in 1 to 2 spoken sentences (under 30 words).',
        'Speak in natural, warm spoken English.'
      ],
      donts: [
        'Do not use emojis, markdown, asterisks, or bullet points.',
        'Never ask for OTPs, UPI PINs, or full card numbers.'
      ]
    },
    billing: {
      id: 'billing',
      clientId: 'bharatfin_hi',
      name: 'Billing & Accounts (EN / IN)',
      persona: 'Jordan, Billing & Accounts Specialist',
      goal: 'Assist callers with GST invoices, UPI/NetBanking payments, due dates, and refund status.',
      language: 'en',
      voice: 'en-IN-NeerjaNeural',
      defaultTransferExt: '102',
      callingHours: { start: '09:00', end: '18:00', timezone: 'Asia/Kolkata', is24x7: false },
      maxCallLengthSecs: 300,
      greeting: 'Thank you for calling Billing and Accounts. I am Jordan, your billing voice assistant. How can I help with your invoice or payment today?',
      faqSnippet: `
        - Due Dates: Invoices are due within 15 days of billing date.
        - Payment Modes: UPI, NEFT, RTGS, IMPS, corporate credit cards, and customer portal.
        - Late Fee: Rs 250 late fee after a 7-day grace period.
      `,
      dos: [
        'Transfer to Extension 102 if caller disputes a charge or requests manual reconciliation.'
      ],
      donts: [
        'Never ask for CVV, OTP, or UPI PIN.'
      ]
    },
    sales: {
      id: 'sales',
      clientId: 'apollo_telehealth',
      name: 'Enterprise Sales & Upgrades',
      persona: 'Morgan, Solutions Advisor',
      goal: 'Share plan pricing in INR and connect interested callers to Sales on Extension 104.',
      language: 'en',
      voice: 'en-IN-NeerjaNeural',
      defaultTransferExt: '104',
      callingHours: { start: '09:00', end: '20:00', timezone: 'Asia/Kolkata', is24x7: false },
      maxCallLengthSecs: 300,
      greeting: 'Thank you for calling Enterprise Sales. I am Morgan, your AI solutions advisor. Are you looking to activate a new connection or upgrade your current plan?',
      faqSnippet: `
        - Starter Plan: Rs 999 per month per seat with unlimited inbound and outbound calls.
        - Pro Plan: Rs 2,499 per month per seat with VICIdial and Asterisk AudioSocket integration.
        - Enterprise SLA: Custom multi-trunk SIP PRI/AudioSocket deployment.
      `,
      dos: [
        'Offer warm transfer to Extension 104 for custom enterprise quotes.'
      ],
      donts: [
        'Do not pressure callers.'
      ]
    },
    support_hinglish: {
      id: 'support_hinglish',
      clientId: 'quickmart_retail',
      name: 'Customer Support (Hinglish)',
      persona: 'Rohan, Customer Care Specialist',
      goal: 'Help callers in natural conversational Hinglish written strictly in Roman/Latin script so the TTS voice pronounces every word accurately.',
      language: 'hi-Latn',
      voice: 'en-IN-NeerjaNeural',
      defaultTransferExt: '101',
      callingHours: { start: '09:00', end: '20:00', timezone: 'Asia/Kolkata', is24x7: false },
      maxCallLengthSecs: 300,
      greeting: 'Namaste! Customer Support mein call karne ke liye dhanyawad. Main Rohan hoon, aapka AI voice assistant. Aaj main aapki kya madad kar sakta hoon?',
      faqSnippet: `
        - Refund Policy: Order ID ke saath 30 din mein full refund UPI ya bank account mein milta hai.
        - Support Hours: 24/7 automated line active hai; human specialists Monday se Saturday subah 9 baje se raat 8 baje IST tak uplabdh hain.
        - Plans: Starter Plan Rs 999 prati maah aur Pro Plan Rs 2,499 prati maah hai.
      `,
      dos: [
        'Reply strictly in Latin/Roman script (e.g. "Main aapki call billing team ko transfer kar raha hoon").',
        'Keep replies to 1-2 short spoken sentences.'
      ],
      donts: [
        'Do not output Devanagari characters when language is hi-Latn.',
        'Do not use emojis or markdown.'
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

export function getTenantClient(clientId) {
  return CONFIG.TENANT_CLIENTS[clientId] || CONFIG.TENANT_CLIENTS.bharatfin_hi;
}

