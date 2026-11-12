#!/usr/bin/env node

/**
 * Generates:
 *  1. Real spoken fallback WAV files (16kHz 16-bit mono PCM) in /public/audio/fallbacks/
 *  2. 20 real 8kHz phone-quality spoken WAV test recordings (10 Hindi + 10 English)
 *     in /tests/recordings/{hi,en}/ with PSTN 300-3400Hz bandpass filtering via ffmpeg.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { GoogleGenAI } from '@google/genai';
import { CONFIG } from '../src/config.js';
import { FALLBACK_LINES_MANIFEST, syncPreRecordedFallbacks } from '../src/tts.js';

const ai = new GoogleGenAI({
  apiKey: CONFIG.GEMINI_API_KEY,
  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
});

const RECORDINGS_SPEC = [
  // 10 English 8kHz Phone Recordings
  {
    id: 'en_01_refund',
    lang: 'en',
    campaign: 'support',
    voice: 'Kore',
    filename: 'en/en_01_refund.wav',
    referenceText: 'What is your refund policy for a recent order?',
    expectAction: 'speak_and_listen'
  },
  {
    id: 'en_02_billing_transfer',
    lang: 'en',
    campaign: 'support',
    voice: 'Puck',
    filename: 'en/en_02_billing_transfer.wav',
    referenceText: 'Please transfer my call to the billing department on extension 102.',
    expectAction: 'transfer',
    expectExt: '102'
  },
  {
    id: 'en_03_angry_supervisor',
    lang: 'en',
    campaign: 'support',
    voice: 'Charon',
    filename: 'en/en_03_angry_supervisor.wav',
    referenceText: 'This service is unacceptable, connect me to a supervisor immediately.',
    expectAction: 'transfer',
    expectExt: '200'
  },
  {
    id: 'en_04_dnc',
    lang: 'en',
    campaign: 'support',
    voice: 'Zephyr',
    filename: 'en/en_04_dnc.wav',
    referenceText: 'Stop calling me and remove my phone number from your list.',
    expectAction: 'hangup'
  },
  {
    id: 'en_05_hours',
    lang: 'en',
    campaign: 'support',
    voice: 'Kore',
    filename: 'en/en_05_hours.wav',
    referenceText: 'What are your customer support hours today?',
    expectAction: 'speak_and_listen'
  },
  {
    id: 'en_06_tech_transfer',
    lang: 'en',
    campaign: 'support',
    voice: 'Puck',
    filename: 'en/en_06_tech_transfer.wav',
    referenceText: 'Transfer me to technical support on extension 103.',
    expectAction: 'transfer',
    expectExt: '103'
  },
  {
    id: 'en_07_sales_transfer',
    lang: 'en',
    campaign: 'support',
    voice: 'Zephyr',
    filename: 'en/en_07_sales_transfer.wav',
    referenceText: 'Connect me to sales on extension 104 for enterprise pricing.',
    expectAction: 'transfer',
    expectExt: '104'
  },
  {
    id: 'en_08_yes_confirm',
    lang: 'en',
    campaign: 'support',
    voice: 'Kore',
    filename: 'en/en_08_yes_confirm.wav',
    referenceText: 'Yes, I would like to verify my account details.',
    expectAction: 'speak_and_listen'
  },
  {
    id: 'en_09_callback',
    lang: 'en',
    campaign: 'support',
    voice: 'Puck',
    filename: 'en/en_09_callback.wav',
    referenceText: 'I am in a meeting right now, please call me back tomorrow morning.',
    expectAction: 'speak_and_listen'
  },
  {
    id: 'en_10_goodbye',
    lang: 'en',
    campaign: 'support',
    voice: 'Kore',
    filename: 'en/en_10_goodbye.wav',
    referenceText: 'Thank you for your help today, goodbye.',
    expectAction: 'hangup'
  },

  // 10 Hindi 8kHz Phone Recordings (Devanagari)
  {
    id: 'hi_01_account_info',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Kore',
    filename: 'hi/hi_01_account_info.wav',
    referenceText: 'नमस्ते मुझे अपने खाते की जानकारी चाहिए',
    expectAction: 'speak_and_listen'
  },
  {
    id: 'hi_02_billing_transfer',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Puck',
    filename: 'hi/hi_02_billing_transfer.wav',
    referenceText: 'कृपया मुझे बिलिंग विभाग एक्सटेंशन 102 से जोड़ें',
    expectAction: 'transfer',
    expectExt: '102'
  },
  {
    id: 'hi_03_supervisor',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Charon',
    filename: 'hi/hi_03_supervisor.wav',
    referenceText: 'मुझे तुरंत सुपरवाइजर से बात करनी है कॉल ट्रांसफर करें',
    expectAction: 'transfer',
    expectExt: '200'
  },
  {
    id: 'hi_04_dnc',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Zephyr',
    filename: 'hi/hi_04_dnc.wav',
    referenceText: 'मुझे दोबारा कॉल मत करना मेरा नंबर हटा दो',
    expectAction: 'hangup'
  },
  {
    id: 'hi_05_hours',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Kore',
    filename: 'hi/hi_05_hours.wav',
    referenceText: 'आपकी ग्राहक सहायता सेवा का समय क्या है',
    expectAction: 'speak_and_listen'
  },
  {
    id: 'hi_06_refund',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Puck',
    filename: 'hi/hi_06_refund.wav',
    referenceText: 'आपकी रिफंड नीति क्या है और पैसे कब मिलेंगे',
    expectAction: 'speak_and_listen'
  },
  {
    id: 'hi_07_tech_transfer',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Kore',
    filename: 'hi/hi_07_tech_transfer.wav',
    referenceText: 'मुझे तकनीकी सहायता एक्सटेंशन 103 पर ट्रांसफर करें',
    expectAction: 'transfer',
    expectExt: '103'
  },
  {
    id: 'hi_08_sales_plan',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Puck',
    filename: 'hi/hi_08_sales_plan.wav',
    referenceText: 'मुझे नया प्लान खरीदना है सेल्स एक्सटेंशन 104 से जोड़ें',
    expectAction: 'transfer',
    expectExt: '104'
  },
  {
    id: 'hi_09_support_agent',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Zephyr',
    filename: 'hi/hi_09_support_agent.wav',
    referenceText: 'कृपया मेरी कॉल एक्सटेंशन 101 पर ट्रांसफर करें',
    expectAction: 'transfer',
    expectExt: '101'
  },
  {
    id: 'hi_10_plans_price',
    lang: 'hi',
    campaign: 'support_hi',
    voice: 'Kore',
    filename: 'hi/hi_10_plans_price.wav',
    referenceText: 'आपके मासिक प्लान का शुल्क कितना है',
    expectAction: 'speak_and_listen'
  }
];

async function synthesizeRawSpeech(text, voice = 'Kore', lang = 'en') {
  // Primary: Gemini Neural TTS (high-clarity speech for ground-truth reference recordings)
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice }
          }
        }
      }
    });
    const b64 = response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (b64) {
      return { buffer: Buffer.from(b64, 'base64'), ext: 'wav' };
    }
  } catch (err) {
    console.warn(`  [Gemini TTS rate note for "${text.slice(0, 28)}..."]: ${err.message?.slice(0, 80)}`);
  }

  // Secondary: Google Cloud Text-to-Speech API if GOOGLE_CLOUD_TTS_KEY is configured
  if (CONFIG.GOOGLE_CLOUD_TTS_KEY) {
    const isHindi = lang === 'hi' || /[\u0900-\u097F]/.test(text);
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(CONFIG.GOOGLE_CLOUD_TTS_KEY)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: isHindi ? 'hi-IN' : 'en-IN',
          name: isHindi ? 'hi-IN-Neural2-A' : 'en-IN-Neural2-A'
        },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 16000 }
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.audioContent) {
        return { buffer: Buffer.from(data.audioContent, 'base64'), ext: 'wav' };
      }
    }
  }

  throw new Error('TTS synthesis requires GEMINI_API_KEY or GOOGLE_CLOUD_TTS_KEY');
}

function convertWithFfmpeg(inputBuffer, inputExt, outputWavPath, sampleRate, phoneBandpass = false) {
  const tmpIn = path.join(os.tmpdir(), `gen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${inputExt}`);
  try {
    fs.writeFileSync(tmpIn, inputBuffer);
    const args = ['-y', '-i', tmpIn];
    if (phoneBandpass) {
      // PSTN telephone line bandpass filter (300Hz - 3400Hz) at 8000 Hz mono 16-bit PCM
      args.push('-af', 'highpass=f=300,lowpass=f=3400');
    }
    args.push('-ar', String(sampleRate), '-ac', '1', '-acodec', 'pcm_s16le', outputWavPath);
    execFileSync('/usr/bin/ffmpeg', args, { stdio: 'ignore' });
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch (_) {}
  }
}

async function main() {
  console.log('=== 1. Generating Real Spoken Fallback WAV Files (16kHz PCM) ===');
  fs.mkdirSync(CONFIG.AUDIO.FALLBACK_DIR, { recursive: true });

  for (const [lang, group] of Object.entries(FALLBACK_LINES_MANIFEST)) {
    for (const [key, item] of Object.entries(group)) {
      const outPath = path.join(CONFIG.AUDIO.FALLBACK_DIR, item.filename);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
        console.log(`  [Skip existing] ${item.filename} (${fs.statSync(outPath).size} bytes)`);
        continue;
      }
      const { buffer, ext } = await synthesizeRawSpeech(item.text, 'Kore', lang);
      convertWithFfmpeg(buffer, ext, outPath, 16000, false);
      const stat = fs.statSync(outPath);
      console.log(`  [Generated] ${item.filename} (${lang}/${key}) -> ${stat.size} bytes (16kHz WAV)`);
    }
  }

  syncPreRecordedFallbacks();

  console.log('\n=== 2. Generating 20 Real 8kHz Phone-Quality Test Recordings (10 EN + 10 HI) ===');
  const enDir = path.join(CONFIG.AUDIO.RECORDINGS_DIR, 'en');
  const hiDir = path.join(CONFIG.AUDIO.RECORDINGS_DIR, 'hi');
  fs.mkdirSync(enDir, { recursive: true });
  fs.mkdirSync(hiDir, { recursive: true });

  const manifestItems = [];
  for (const rec of RECORDINGS_SPEC) {
    const outPath = path.join(CONFIG.AUDIO.RECORDINGS_DIR, rec.filename);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4000) {
      const { buffer, ext } = await synthesizeRawSpeech(rec.referenceText, rec.voice, rec.lang);
      convertWithFfmpeg(buffer, ext, outPath, 8000, true);
    }
    const sizeBytes = fs.statSync(outPath).size;
    const durationSec = Number(((sizeBytes - 44) / (8000 * 2)).toFixed(2));
    console.log(`  [8kHz WAV] ${rec.filename} (${durationSec}s, ${sizeBytes} bytes) -> "${rec.referenceText}"`);
    manifestItems.push({
      ...rec,
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
      sizeBytes,
      durationSec
    });
  }

  // Also generate an 8kHz silence/noise WAV file for testing ASR silence & VAD
  const silencePath = path.join(CONFIG.AUDIO.RECORDINGS_DIR, 'silence_8k.wav');
  execFileSync('/usr/bin/ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=r=8000:cl=mono',
    '-t', '1.5',
    '-acodec', 'pcm_s16le',
    silencePath
  ], { stdio: 'ignore' });
  console.log(`  [8kHz Silence WAV] silence_8k.wav (${fs.statSync(silencePath).size} bytes)`);

  const manifestPath = path.join(CONFIG.AUDIO.RECORDINGS_DIR, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        format: '8000 Hz, 16-bit mono PCM WAV (300-3400Hz telephone bandpass)',
        totalRecordings: manifestItems.length,
        recordings: manifestItems
      },
      null,
      2
    )
  );
  console.log(`\nSaved manifest to ${manifestPath}`);
}

main().catch((err) => {
  console.error('Asset generation failed:', err);
  process.exit(1);
});
