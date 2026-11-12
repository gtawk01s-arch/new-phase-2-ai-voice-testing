import { generate } from './llm.js';
import { CONFIG, getCampaign, getLanguage } from './config.js';

// Clean spoken text: strip markdown, asterisks, hashtags, code blocks, emojis
export function cleanSpokenText(text) {
  if (!text) return '';
  return text
    .replace(/\*+/g, '')
    .replace(/#+/g, '')
    .replace(/[_`~]/g, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if silence or inaudible audio
 */
function isSilenceOrInaudible(text) {
  if (!text) return true;
  const t = text.trim();
  if (t === '' || t === '...' || /^[\s\.\,\?\!_-]+$/.test(t)) return true;
  if (/^\[(silence|inaudible|blank|noise|unintelligible)\]$/i.test(t)) return true;
  if (/^\((silence|inaudible|blank)\)$/i.test(t)) return true;
  return false;
}

/**
 * Check if the caller is visibly angry or demanding escalation (supports Hindi, English, Hinglish)
 */
function isAngryCaller(text) {
  const angryPatterns = [
    /\b(i am|i'm|feeling)?\s*(angry|furious|livid|pissed off)\b/i,
    /\b(unacceptable|terrible|horrible|worst|awful)\s*(service|company|support)?\b/i,
    /\b(sue you|call my lawyer|legal action)\b/i,
    /\b(demand to (talk|speak)|want to (talk|speak)|transfer me|connect me|put me through|get me|let me talk to)\s*(to)?\s*(a|the|your)?\s*(supervisor|manager|senior)\b/i,
    /\b(manager|supervisor)\s+(right now|immediately)\b/i,
    /\bescalate (this|my call|to a supervisor|to a manager)\b/i,
    // Hindi / Hinglish expressions (including 8kHz ASR phonetic variations)
    /\b(bahut gussa|gussa aa raha|bekaar service|bakwas service)\b/i,
    /\b(manager se baat karao|senior se baat karao|supervisor se connect karo|manager se connect karo)\b/i,
    /मैनेजर से बात|सुपरवाइजर से बात|सुपरवाइज़र से बात|सुपवाईजर से बात|शिकायत दर्ज|बहुत खराब सर्विस|(सुपरवाइजर|सुपवाईजर).*ट्रांसफर/i
  ];
  return angryPatterns.some(p => p.test(text));
}

/**
 * Check if caller demanded Do Not Call (DNC) in Hindi, English, or Hinglish
 */
function isDncRequest(text) {
  const dncPatterns = [
    /don't call me/i, /dont call me/i, /do not call/i, /stop calling/i,
    /remove my number/i, /take me off (your|the|our|this|contact) list/i, /lose my number/i,
    /delete my number/i, /never call/i, /\bdnc\b/i, /opt out/i, /unsubscribe/i,
    /contact list permanently/i,
    // Hindi / Hinglish expressions
    /call mat karo/i, /phone mat karo/i, /number hatao/i, /list se hatao/i,
    /dobara call mat karna/i, /kabhi call mat/i, /number delete/i,
    /दोबारा.*कॉल/i, /नंबर हटा/i, /कॉल मत/i, /फ़ोन मत/i, /डू नॉट कॉल/i
  ];
  return dncPatterns.some(p => p.test(text));
}

/**
 * Check if caller asked for an explicit extension or department
 */
function findRequestedExtension(text) {
  const lower = text.toLowerCase();
  const spokenNumberMap = {
    '101': ['एक सौ एक', 'एक सो एक', 'एकसो एक'],
    '102': ['एक सौ दो', 'एक सो दो', 'एकसो दो', 'एकसोद दो'],
    '103': ['एक सौ तीन', 'एक सो तीन', 'एकसो तीन'],
    '104': ['एक सौ चार', 'एक सो चार', 'एकसो चार'],
    '200': ['दो सौ', 'दो सो']
  };

  for (const ext of CONFIG.EXTENSIONS) {
    const spokenVariants = spokenNumberMap[ext.id] || [];
    if (
      lower.includes(`extension ${ext.id}`) ||
      lower.includes(`ext ${ext.id}`) ||
      lower.includes(`ext. ${ext.id}`) ||
      lower.includes(`एक्सटेंशन ${ext.id}`) ||
      lower.includes(`एक्स्टेंशन ${ext.id}`) ||
      lower.includes(`एक्स्टिंशन ${ext.id}`) ||
      spokenVariants.some(v => lower.includes(v)) ||
      new RegExp(`\\bext\\s*#?\\s*${ext.id}\\b`, 'i').test(lower)
    ) {
      return ext;
    }
  }

  // Check department keywords when transfer command phrasing was used
  const transferCommandPatterns = [
    /\b(transfer|connect|route|put me through|escalate)\b/i,
    /\b(want to|need to|like to)\s+(talk to|talk with|speak to|speak with)\s+(an agent|a representative|a person|a human|a human being|a specialist|someone|an operator|billing|sales|support)\b/i,
    /\b(transfer karo|transfer kar do|transfer kar dijiye|connect karo|connect kar do|baat karao|baat kara do|baat karni hai)\b/i,
    /(जोड़ें|जोड़ें|जोडें|ट्रांसफर|ट्रांस्फर|कनेक्ट|बात कराओ|बात करा दें|बात करनी है)/i
  ];
  const wantsTransfer = transferCommandPatterns.some(p => p.test(lower));
  if (wantsTransfer) {
    // Prioritize specific departments (102, 103, 104, 200) before generic support (101)
    const prioritizedExts = [
      ...CONFIG.EXTENSIONS.filter(e => e.id !== '101'),
      ...CONFIG.EXTENSIONS.filter(e => e.id === '101')
    ];
    for (const ext of prioritizedExts) {
      if (ext.keywords.some(kw => lower.includes(kw))) {
        return ext;
      }
    }
    if (/\b(agent|human|human being|representative|person|someone|operator)\b/i.test(lower)) {
      return CONFIG.EXTENSIONS[0]; // Default to general support (101)
    }
  }

  return null;
}

/**
 * Detect if the caller is speaking in Hindi (Devanagari), asking to speak in Hindi, or speaking Hinglish
 */
export function detectCallerLanguage(text, currentLang = 'en') {
  if (!text) return currentLang;
  const clean = text.trim();
  // 1. Devanagari script -> Hindi ('hi')
  if (/[\u0900-\u097F]/.test(clean)) {
    return 'hi';
  }
  // 2. Explicit request to talk in Hindi
  if (/\b(speak in hindi|talk in hindi|hindi mein|hindi me|in hindi please|can you speak hindi|do you speak hindi|know hindi)\b/i.test(clean)) {
    return 'hi';
  }
  // 3. Explicit request to talk in English
  if (/\b(speak in english|talk in english|english mein|in english please)\b/i.test(clean)) {
    return 'en';
  }
  // 4. Conversational Hinglish detection (Romanized Hindi words)
  const hinglishWords = clean
    .toLowerCase()
    .match(/\b(mujhe|mera|meri|kya|kaise|kahan|kab|kyun|aap|aapka|aapki|hain|hoon|nahi|karna|karo|batao|bataiye|madad|sahayata|chahiye|kitna|paisa|baat|namaste|dhanyawad|shukriya|suno|sunai)\b/g);
  if (hinglishWords && hinglishWords.length >= 2) {
    return currentLang === 'hi' ? 'hi' : 'hi-Latn';
  }
  return currentLang;
}

/**
 * Process a conversation turn through the structured engine.
 * No canned test answers exist in this module: all conversational turns go through the LLM chain,
 * and if all LLMs fail, it plays a single scripted line and transfers the caller.
 */
export async function processTurn(session, userText) {
  const t0 = Date.now();
  const cleanInput = (userText || '').trim();

  // Auto-detect Hindi / Hinglish if caller speaks in Devanagari or asks for Hindi
  if (cleanInput) {
    const detectedLang = detectCallerLanguage(cleanInput, session.language || 'en');
    if (detectedLang !== session.language) {
      session.language = detectedLang;
      if (detectedLang === 'hi' && (!session.campaignId || session.campaignId === 'support' || session.campaignId === 'support_hinglish')) {
        session.campaignId = 'support_hi';
      } else if (detectedLang === 'hi-Latn' && (!session.campaignId || session.campaignId === 'support')) {
        session.campaignId = 'support_hinglish';
      } else if (detectedLang === 'en' && (session.campaignId === 'support_hi' || session.campaignId === 'support_hinglish')) {
        session.campaignId = 'support';
      }
    }
  }

  const campaign = getCampaign(session.campaignId);
  const langConfig = getLanguage(session.language || campaign.language || 'en');

  // 1. HARD RULE: Do Not Call (DNC) Request -> Immediate DNC disposition and hangup
  if (isDncRequest(cleanInput)) {
    const farewell = langConfig.dncLine ||
      'Understood. I have recorded your request and removed your phone number from our call list. Goodbye.';
    session.recordTurn('user', cleanInput, { intent: 'do_not_call' });
    session.recordTurn('assistant', farewell, { action: 'hangup', intent: 'dnc_farewell' });
    session.disposition = 'DNC';
    session.status = 'completed';

    return {
      action: 'hangup',
      intent: 'do_not_call',
      reply: farewell,
      disposition: 'DNC',
      confidence: 1.0,
      transfer: null,
      timing_ms: { llm: 0, total_engine: Date.now() - t0 }
    };
  }

  // 2. HARD RULE: Angry Caller -> Immediate Escalation to Supervisor (Extension 200)
  if (isAngryCaller(cleanInput)) {
    const supervisorExt = CONFIG.EXTENSIONS.find(e => e.id === '200') || CONFIG.EXTENSIONS[0];
    const reply = session.language === 'hi'
      ? `मैं आपकी परेशानी समझ सकता हूँ और क्षमा चाहता हूँ। मैं आपकी कॉल तुरंत हमारे वरिष्ठ सुपरवाइज़र (एक्सटेंशन ${supervisorExt.id}) को ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।`
      : (session.language === 'hi-Latn'
        ? `Main aapki pareshani samajh sakta hoon aur kshama chahta hoon. Main aapki call turant hamare Senior Supervisor (extension ${supervisorExt.id}) ko transfer kar raha hoon. Kripya line par bane rahein.`
        : `I sincerely apologize for your frustration. I am escalating your call immediately to our Senior Supervisor on extension ${supervisorExt.id}. Please hold.`);

    session.recordTurn('user', cleanInput, { intent: 'angry_escalation' });
    session.recordTurn('assistant', reply, { action: 'transfer', intent: 'supervisor_escalation' });
    session.disposition = 'escalated_supervisor';
    session.status = 'transferred';
    session.transferredTo = supervisorExt;

    return {
      action: 'transfer',
      intent: 'angry_escalation',
      reply,
      disposition: 'escalated_supervisor',
      confidence: 1.0,
      transfer: supervisorExt,
      timing_ms: { llm: 0, total_engine: Date.now() - t0 }
    };
  }

  // 3. HARD RULE: Explicit Extension or Department Request
  const explicitExt = findRequestedExtension(cleanInput);
  if (explicitExt) {
    const reply = session.language === 'hi'
      ? `अवश्य! मैं आपकी कॉल एक्सटेंशन ${explicitExt.id} पर ${explicitExt.name} को ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।`
      : (session.language === 'hi-Latn'
        ? `Sure! Main aapki call extension ${explicitExt.id} par ${explicitExt.name} ko transfer kar raha hoon. Please hold kijiye.`
        : `Certainly! I am transferring your call to ${explicitExt.name} on extension ${explicitExt.id}. Please stay on the line while I connect you.`);

    session.recordTurn('user', cleanInput, { intent: 'transfer_request' });
    session.recordTurn('assistant', reply, { action: 'transfer', intent: 'transfer_routed' });
    session.disposition = 'transferred';
    session.status = 'transferred';
    session.transferredTo = explicitExt;

    return {
      action: 'transfer',
      intent: 'transfer_request',
      reply,
      disposition: 'transferred',
      confidence: 1.0,
      transfer: explicitExt,
      timing_ms: { llm: 0, total_engine: Date.now() - t0 }
    };
  }

  // 4. TASK 8 RULE: ASR fails -> “Could you repeat that?” twice, then transfer to a human on 3rd failure
  if (isSilenceOrInaudible(cleanInput)) {
    session.asrFailures = (session.asrFailures || 0) + 1;

    if (session.asrFailures >= 3) {
      const supportExt = CONFIG.EXTENSIONS.find(e => e.id === campaign.defaultTransferExt) || CONFIG.EXTENSIONS[0];
      const transferMsg = session.language === 'hi'
        ? `मुझे आपकी आवाज़ स्पष्ट रूप से सुनाई नहीं दे रही है। मैं आपकी कॉल हमारे ग्राहक सहायता डेस्क एक्सटेंशन ${supportExt.id} पर ट्रांसफर कर रहा हूँ।`
        : (session.language === 'hi-Latn'
          ? `Mujhe aapki aawaz saaf sunai nahi de rahi hai. Main aapki call hamare Customer Support desk extension ${supportExt.id} par transfer kar raha hoon.`
          : `I am having trouble hearing your audio clearly. Let me connect you directly to our Customer Support desk on extension ${supportExt.id}.`);

      session.recordTurn('assistant', transferMsg, { action: 'transfer', intent: 'asr_failure_transfer' });
      session.status = 'transferred';
      session.disposition = 'audio_failed_transfer';
      session.transferredTo = supportExt;

      return {
        action: 'transfer',
        intent: 'asr_failure_transfer',
        reply: transferMsg,
        disposition: 'audio_failed_transfer',
        confidence: 0.95,
        transfer: supportExt,
        timing_ms: { llm: 0, total_engine: Date.now() - t0 }
      };
    }

    const repeatReply = langConfig.repeatPrompt || 'Could you repeat that?';
    session.recordTurn('assistant', repeatReply, { action: 'speak_and_listen', intent: 'no_speech_repeat' });

    return {
      action: 'speak_and_listen',
      intent: 'silence_retry',
      reply: repeatReply,
      disposition: 'in_progress',
      confidence: 0.5,
      transfer: null,
      asr_retry_count: session.asrFailures,
      timing_ms: { llm: 0, total_engine: Date.now() - t0 }
    };
  }

  // Reset ASR failure counter on valid spoken utterance
  session.asrFailures = 0;

  // 5. Farewell / Hangup Phrases
  const lowerInput = cleanInput.toLowerCase();
  if (
    lowerInput === 'bye' ||
    lowerInput === 'goodbye' ||
    lowerInput.includes('goodbye') ||
    lowerInput === 'bye bye' ||
    lowerInput.includes('hang up') ||
    lowerInput === 'alvida' ||
    lowerInput.includes('phone rakh raha') ||
    cleanInput === 'अलविदा' ||
    cleanInput === 'धन्यवाद बाय'
  ) {
    const farewell = session.language === 'hi'
      ? 'कॉल करने के लिए धन्यवाद। आपका दिन शुभ हो! नमस्ते।'
      : (session.language === 'hi-Latn'
        ? 'Call karne ke liye dhanyawad. Aapka din shubh ho! Namaste.'
        : 'Thank you for calling. Have a great day! Goodbye.');

    session.recordTurn('user', cleanInput, { intent: 'farewell' });
    session.recordTurn('assistant', farewell, { action: 'hangup', intent: 'farewell_response' });
    session.status = 'completed';
    session.disposition = 'resolved';

    return {
      action: 'hangup',
      intent: 'farewell',
      reply: farewell,
      disposition: 'resolved',
      confidence: 1.0,
      transfer: null,
      timing_ms: { llm: 0, total_engine: Date.now() - t0 }
    };
  }

  // 6. Conversational Turn via Multi-Provider LLM Chain (Gemini -> Groq -> OpenRouter)
  session.recordTurn('user', cleanInput, { intent: 'user_turn' });
  const recentHistory = session.getRecentHistory(8);

  const scriptGuideline = session.language === 'hi'
    ? 'Reply strictly in natural, polite spoken Hindi using Devanagari script (हिंदी). Do NOT reply in English.'
    : (session.language === 'hi-Latn'
      ? 'For Hinglish, output words strictly in Latin/Roman script (e.g. "Main aapki call transfer kar raha hoon"). Do NOT output Devanagari characters.'
      : 'Output words in natural spoken English.');

  const systemInstruction = `You are ${campaign.persona} on a telephone call for "${campaign.name}".
Goal: ${campaign.goal}
Language: ${langConfig.name} (${langConfig.code})
Script format: ${scriptGuideline}

Campaign Knowledge:
${campaign.faqSnippet}

Rules:
- Answer the caller's question directly, accurately, and concisely in 1 to 2 spoken sentences (under 30 words) in ${langConfig.name}.
- Never use emojis, asterisks, hashtags, bullet points, code formatting, or JSON. Reply with the spoken words only.`;

  const tLlm0 = Date.now();
  const llmResult = await generate(recentHistory, {
    systemInstruction,
    timeoutMs: CONFIG.TIMEOUTS.LLM_PER_PROVIDER,
    callId: session.callId,
    language: session.language
  });
  const llmLatency = Date.now() - tLlm0;

  // TASK 8 RULE: If all LLMs fail (real outage or simulated chaos), say one scripted line and transfer immediately.
  if (llmResult.isLlmOutage) {
    const fallbackExt = CONFIG.EXTENSIONS.find(e => e.id === campaign.defaultTransferExt) || CONFIG.EXTENSIONS[0];
    const reply = langConfig.llmFallback ||
      'I apologize, our automated system is currently experiencing technical difficulties. Let me transfer you directly to a specialist. Please hold.';

    session.recordTurn('assistant', reply, {
      action: 'transfer',
      intent: 'llm_outage_fallback',
      provider: 'local/emergency-scripted-transfer',
      timings: { llm: llmLatency, total: Date.now() - t0 }
    });
    session.status = 'transferred';
    session.disposition = 'llm_outage_transfer';
    session.transferredTo = fallbackExt;

    return {
      action: 'transfer',
      intent: 'llm_outage_fallback',
      reply,
      disposition: 'llm_outage_transfer',
      confidence: 1.0,
      transfer: fallbackExt,
      timing_ms: { llm: llmLatency, total_engine: Date.now() - t0 },
      provider: 'local/emergency-scripted-transfer'
    };
  }

  let reply = cleanSpokenText(llmResult.content);
  if (!reply || reply.length < 2) {
    const fallbackExt = CONFIG.EXTENSIONS.find(e => e.id === campaign.defaultTransferExt) || CONFIG.EXTENSIONS[0];
    const fallbackReply = langConfig.llmFallback;
    session.recordTurn('assistant', fallbackReply, {
      action: 'transfer',
      intent: 'llm_empty_fallback',
      provider: llmResult.provider
    });
    session.status = 'transferred';
    session.disposition = 'llm_outage_transfer';
    session.transferredTo = fallbackExt;

    return {
      action: 'transfer',
      intent: 'llm_outage_fallback',
      reply: fallbackReply,
      disposition: 'llm_outage_transfer',
      confidence: 1.0,
      transfer: fallbackExt,
      timing_ms: { llm: llmLatency, total_engine: Date.now() - t0 },
      provider: llmResult.provider
    };
  }

  session.recordTurn('assistant', reply, {
    intent: 'inquiry',
    action: 'speak_and_listen',
    confidence: 0.95,
    provider: llmResult.provider,
    timings: { llm: llmLatency, total: Date.now() - t0 }
  });

  return {
    action: 'speak_and_listen',
    intent: 'inquiry',
    reply,
    disposition: 'in_progress',
    confidence: 0.95,
    transfer: null,
    timing_ms: {
      llm: llmLatency,
      total_engine: Date.now() - t0
    },
    provider: llmResult.provider
  };
}
