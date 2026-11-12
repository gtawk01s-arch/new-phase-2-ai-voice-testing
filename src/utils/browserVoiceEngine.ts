/**
 * Browser Offline Emergency Fallback
 * If the backend server is unreachable from the browser UI, this plays a single
 * scripted outage line in the active language and routes to a specialist extension.
 * No canned test-question answers or client-side API keys exist here.
 */

import type { ExtensionTransfer } from '../types/index';

export interface EngineTurnResult {
  response: string;
  action?: 'continue' | 'transfer' | 'hangup' | 'schedule';
  transfer?: ExtensionTransfer;
}

const DEFAULT_SUPPORT_EXT: ExtensionTransfer = {
  name: 'General Customer Support',
  extension: '101',
  department: 'Customer Support Desk',
  sip_uri: 'sip:101@sip.telephony.internal',
  phone_number: '+9118001020101'
};

export function cleanSpokenText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\*+/g, '')
    .replace(/#+/g, '')
    .replace(/[_`~]/g, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function generateBrowserVoiceResponse(
  userText: string,
  _history: Array<{ role: 'user' | 'assistant'; text: string }> = []
): Promise<EngineTurnResult> {
  const isHindi = /[\u0900-\u097F]/.test(userText);

  if (isHindi) {
    return {
      response: 'क्षमा करें, हमारे सिस्टम में अभी तकनीकी समस्या आ रही है। मैं आपकी कॉल तुरंत हमारे सहायता विशेषज्ञ (एक्सटेंशन 101) को ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।',
      action: 'transfer',
      transfer: DEFAULT_SUPPORT_EXT
    };
  }

  return {
    response: 'I apologize, our automated system is experiencing a technical issue. Let me transfer you directly to a specialist on extension 101. Please stay on the line.',
    action: 'transfer',
    transfer: DEFAULT_SUPPORT_EXT
  };
}
