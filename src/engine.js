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
 * Check if the caller is visibly angry or demanding escalation (supports English, Hindi, Hinglish)
 */
function isAngryCaller(text) {
  const angryPatterns = [
    /\b(i am|i'm|feeling)?\s*(angry|furious|livid|pissed off)\b/i,
    /\b(unacceptable|terrible|horrible|worst)\s*(service|company|support)\b/i,
    /\b(sue you|call my lawyer|legal action)\b/i,
    /\b(demand to (talk|speak)|want to (talk|speak)|transfer me|connect me|put me through|get me|let me talk to)\s*(to)?\s*(a|the|your)?\s*(supervisor|manager|senior)\b/i,
    /\b(manager|supervisor)\s+(right now|immediately)\b/i,
    /\bescalate (this|my call|to a supervisor|to a manager)\b/i,
    // Hindi / Hinglish expressions
    /\b(bahut gussa|gussa aa raha|bekaar service|bakwas service)\b/i,
    /\b(manager se baat karao|senior se baat karao|supervisor se connect karo)\b/i,
    /मैनेजर से बात|सुपरवाइजर से बात|शिकायत दर्ज|बहुत खराब सर्विस/i
  ];
  return angryPatterns.some(p => p.test(text));
}

/**
 * Check if caller demanded Do Not Call (DNC) in English, Hindi, or Hinglish
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
    /दोबारा.*कॉल/i, /नंबर हटा/i, /कॉल मत/i, /फ़ोन मत/i
  ];
  return dncPatterns.some(p => p.test(text));
}

/**
 * Check if caller asked for an explicit extension or department
 */
function findRequestedExtension(text) {
  const lower = text.toLowerCase();
  for (const ext of CONFIG.EXTENSIONS) {
    if (
      lower.includes(`extension ${ext.id}`) ||
      lower.includes(`ext ${ext.id}`) ||
      lower.includes(`ext. ${ext.id}`) ||
      new RegExp(`\\bext\\s*#?\\s*${ext.id}\\b`, 'i').test(lower)
    ) {
      return ext;
    }
  }

  // Check department keywords ONLY when explicit transfer command phrasing was used
  const transferCommandPatterns = [
    /\b(transfer (me|my call|this call|to)|connect (me|my call|this call|to)|put me through( to)?|route (me|my call|this call|to))\b/i,
    /\b(can you|could you|please)\s+(transfer|connect|route)\b/i,
    /\b(want to|need to|like to)\s+(talk to|speak to)\s+(an agent|a representative|a person|a human|a specialist|someone)\b/i,
    /\b(transfer karo|connect karo|baat karao|जोड़ें|ट्रांसफर)\b/i
  ];
  const wantsTransfer = transferCommandPatterns.some(p => p.test(lower));
  if (wantsTransfer) {
    for (const ext of CONFIG.EXTENSIONS) {
      if (ext.keywords.some(kw => lower.includes(kw))) {
        return ext;
      }
    }
    if (/\b(agent|human|representative|person|someone|live agent)\b/i.test(lower)) {
      return CONFIG.EXTENSIONS[0]; // Default to general support
    }
  }

  return null;
}

/**
 * Process a conversation turn through the structured engine
 */
export async function processTurn(session, userText, options = {}) {
  const t0 = Date.now();
  const campaign = getCampaign(session.campaignId);
  const langConfig = getLanguage(session.language || campaign.language || 'en');
  const cleanInput = (userText || '').trim();

  // 1. HARD RULE: Do Not Call (DNC) Request -> Immediate DNC disposition and hangup
  if (isDncRequest(cleanInput)) {
    const farewell = langConfig.dncLine ||
      "Understood. I have recorded your request and removed your phone number from our call list. Have a good day. Goodbye.";
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
      timing_ms: { engine: Date.now() - t0 }
    };
  }

  // 2. HARD RULE: Angry Caller -> Immediate Escalation to Supervisor (Extension 200)
  if (isAngryCaller(cleanInput)) {
    const supervisorExt = CONFIG.EXTENSIONS.find(e => e.id === '200') || CONFIG.EXTENSIONS[0];
    const reply = session.language.startsWith('hi')
      ? `मैं आपकी परेशानी समझ सकता हूँ और क्षमा चाहता हूँ। मैं आपकी कॉल तुरंत हमारे मैनेजमेंट सुपरवाइज़र (एक्सटेंशन ${supervisorExt.id}) को ट्रांसफर कर रहा हूँ। कृपया लाइन पर बने रहें।`
      : `I sincerely apologize for your frustration. I am escalating your call immediately to our Management Supervisor on extension ${supervisorExt.id}. Please hold.`;

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
      timing_ms: { engine: Date.now() - t0 }
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
      timing_ms: { engine: Date.now() - t0 }
    };
  }

  // 4. TASK 8 RULE: ASR fails: “Could you repeat that?” twice, then transfer to a human.
  if (isSilenceOrInaudible(cleanInput)) {
    session.asrFailures = (session.asrFailures || 0) + 1;

    // After failing twice, transfer on the 3rd attempt
    if (session.asrFailures >= 3) {
      const supportExt = CONFIG.EXTENSIONS.find(e => e.id === campaign.defaultTransferExt) || CONFIG.EXTENSIONS[0];
      const transferMsg = session.language.startsWith('hi')
        ? `मुझे आपकी आवाज़ स्पष्ट रूप से सुनाई नहीं दे रही है। मैं आपकी कॉल हमारे कस्टमर सपोर्ट डेस्क एक्सटेंशन ${supportExt.id} पर ट्रांसफर कर रहा हूँ।`
        : `I am having trouble hearing your audio clearly. Let me connect you directly to our Customer Support desk on extension ${supportExt.id}.`;

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
        timing_ms: { engine: Date.now() - t0 }
      };
    }

    // Attempt 1 or 2: Ask caller to repeat
    const repeatReply = langConfig.repeatPrompt || "Could you repeat that?";
    session.recordTurn('assistant', repeatReply, { action: 'speak_and_listen', intent: 'no_speech_repeat' });

    return {
      action: 'speak_and_listen',
      intent: 'no_speech',
      reply: repeatReply,
      disposition: 'in_progress',
      confidence: 0.5,
      transfer: null,
      asr_retry_count: session.asrFailures,
      timing_ms: { engine: Date.now() - t0 }
    };
  }

  // Reset ASR failure counter on successful spoken utterance
  session.asrFailures = 0;
  session.failedUnderstandings = 0;

  // Check hangup / farewell phrases
  const lowerInput = cleanInput.toLowerCase();
  if (
    lowerInput === 'bye' ||
    lowerInput === 'goodbye' ||
    lowerInput === 'bye bye' ||
    lowerInput.includes('hang up') ||
    lowerInput === 'alvida' ||
    lowerInput === 'namaste' ||
    lowerInput.includes('phone rakh raha')
  ) {
    const farewell = session.language.startsWith('hi')
      ? 'कॉल करने के लिए धन्यवाद। आपका दिन शुभ हो! नमस्ते।'
      : 'Thank you for calling. Have a great day! Goodbye.';

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
      timing_ms: { engine: Date.now() - t0 }
    };
  }

  // Build Context: Keep only last 8 turns
  session.recordTurn('user', cleanInput, { intent: 'user_turn' });
  const recentHistory = session.getRecentHistory(8);

  // Script rule for Hinglish vs Hindi
  const scriptGuideline = langConfig.scriptType === 'Latin'
    ? 'For Hinglish, output words strictly in Latin/Roman script (e.g. "Main aapki call transfer kar raha hoon"). Do NOT output Devanagari characters.'
    : (session.language === 'hi' ? 'Output words in clear, natural Devanagari Hindi script.' : 'Output words in natural spoken English.');

  // Construct System Instruction for Campaign & Language
  const systemInstruction = `You are ${campaign.persona} on a live telephone call for "${campaign.name}".
Goal: ${campaign.goal}
Language: ${langConfig.name} (${langConfig.code})
Script format: ${scriptGuideline}

Campaign Knowledge:
${campaign.faqSnippet}

Project & Architecture Context:
- This application is an AI Call Assistant with real-time speech-to-text (ASR), multi-provider conversational LLM, edge text-to-speech (TTS), PBX extension routing (Support 101, Billing 102, Tech 103, Sales 104, Supervisor 200), and automated failover.
- If asked what we did, what is working, or for a summary: explain clearly that real-time speech recognition, conversational AI responses, multi-language support (English, Hindi, Hinglish), and telephony PBX call transfer routing are fully active and working.
- Answer ANY caller inquiry factually, directly, and helpfully (including general knowledge, science, mathematics, project status, account questions, etc.).
- If asked if you are an AI, bot, or virtual assistant, honestly admit: "Yes, I am an automated AI voice assistant named ${campaign.persona.split(',')[0]}, and I am right here on the line to help you."
- Speak naturally, warmly, and concisely in 1 to 2 clear spoken sentences (under 30 words). Never use emojis, asterisks, hashtags, bullet points, code formatting, or JSON. Reply directly with the spoken words only.`;

  const tLlm0 = Date.now();
  const llmResult = await generate(recentHistory, {
    systemInstruction,
    timeoutMs: CONFIG.TIMEOUTS.LLM_PER_PROVIDER,
    callId: session.callId,
    language: session.language
  });
  const llmLatency = Date.now() - tLlm0;

  // TASK 8 RULE: All LLMs down: scripted reply, then transfer.
  if (llmResult.isLlmOutage) {
    const fallbackExt = CONFIG.EXTENSIONS.find(e => e.id === campaign.defaultTransferExt) || CONFIG.EXTENSIONS[0];
    const reply = langConfig.llmFallback || "I apologize, our automated system is currently experiencing technical difficulties. Let me transfer you directly to a specialist. Please hold.";

    session.recordTurn('assistant', reply, {
      action: 'transfer',
      intent: 'llm_outage_fallback',
      provider: 'local/emergency-scripted-transfer'
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

  // Parse structured output
  let parsed = null;
  let rawReply = '';
  let intent = 'general_query';
  let action = 'speak_and_listen';
  let disposition = 'in_progress';
  let confidence = 0.95;

  const rawContent = (llmResult.content || '').trim();

  try {
    let cleanJson = rawContent;
    if (cleanJson.includes('```json')) {
      cleanJson = cleanJson.split('```json')[1].split('```')[0].trim();
    } else if (cleanJson.includes('```')) {
      cleanJson = cleanJson.split('```')[1].split('```')[0].trim();
    }
    const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    }
  } catch (parseErr) {}

  if (parsed && parsed.reply) {
    rawReply = parsed.reply;
    if (parsed.intent) intent = parsed.intent;
    if (parsed.action) action = parsed.action;
    if (parsed.disposition) disposition = parsed.disposition;
    if (typeof parsed.confidence === 'number') confidence = parsed.confidence;
  } else {
    const replyMatch = rawContent.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (replyMatch) {
      try {
        rawReply = JSON.parse(`"${replyMatch[1]}"`);
      } catch (_) {
        rawReply = replyMatch[1];
      }
    } else {
      // The LLM replied in direct plain text
      rawReply = rawContent
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/```$/g, '')
        .replace(/^\{[\s\S]*?"reply"\s*:\s*"?/i, '')
        .replace(/[}"]\s*,\s*"intent"[\s\S]*$/i, '')
        .replace(/^json\s*\{?/i, '')
        .trim();
    }
  }

  // Final cleanup of spoken text
  let reply = cleanSpokenText(rawReply);
  if (!reply || reply === 'json {' || reply.startsWith('{') || reply.length < 2) {
    reply = session.language.startsWith('hi')
      ? 'मैं आपकी बात समझ नहीं पाया। क्या आप कृपया उसे दोबारा दोहरा सकते हैं?'
      : "I'm right here with you. Could you please repeat that question for me?";
  }

  action = action === 'transfer' ? 'transfer' : (action === 'hangup' ? 'hangup' : 'speak_and_listen');

  session.recordTurn('assistant', reply, {
    intent,
    action,
    confidence,
    provider: llmResult.provider,
    timings: { llm: llmLatency, total: Date.now() - t0 }
  });

  return {
    action,
    intent,
    reply,
    disposition,
    confidence,
    transfer: null,
    timing_ms: {
      llm: llmLatency,
      total_engine: Date.now() - t0
    },
    provider: llmResult.provider
  };
}
