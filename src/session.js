import { CONFIG, getLanguage, getCampaign } from './config.js';

// In-memory sessions store with TTL and memory leak protection
const sessions = new Map();

// Idempotency cache for dialer webhook retries: key -> { result, timestamp }
const idempotencyStore = new Map();

// Global latency measurements collection for p50 / p95 calculation
const latencyRecords = [];

// Completed calls audit trail (capped at 1000 for analyst inspection)
const callAuditLog = [];

export class CallSession {
  constructor(callId, options = {}) {
    this.callId = callId;
    this.direction = options.direction || 'inbound';
    this.callerId = options.callerId || 'Anonymous';
    this.calledNumber = options.calledNumber || '';
    this.campaignId = options.campaignId || 'support';
    this.customerName = options.customerName || '';

    const campaign = getCampaign(this.campaignId);
    this.language = options.language || campaign.language || 'en';
    this.outputAudioFormat = options.outputAudioFormat || 'mp3';
    this.status = 'connected'; // 'connected' | 'transferred' | 'completed' | 'failed'
    this.disposition = 'in_progress';
    this.transferredTo = null;
    this.startTime = Date.now();
    this.lastActiveTime = Date.now();
    this.endTime = null;
    this.turns = 0;
    this.asrFailures = 0; // Tracks consecutive inaudible turns ("Could you repeat that?")
    this.failedUnderstandings = 0;
    this.history = []; // Array of TurnRecord objects
    this.turnLatencies = []; // Array of { asr, llm, tts, total }
    this.maxCallLengthSecs = campaign.maxCallLengthSecs || 300;
  }

  touch() {
    this.lastActiveTime = Date.now();
  }

  recordTurn(role, content, metadata = {}) {
    this.touch();
    const turnRecord = {
      turnId: `turn-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      role,
      text: content,
      audioUrl: metadata.audioUrl || null,
      timestamp: Date.now(),
      timings: metadata.timings || { asr: 0, llm: 0, tts: 0, total: 0 },
      provider: metadata.provider || (role === 'user' ? 'caller' : 'system'),
      intent: metadata.intent || (role === 'user' ? 'input' : 'response'),
      action: metadata.action || 'continue',
      confidence: typeof metadata.confidence === 'number' ? metadata.confidence : 0.95,
      flagged: false,
      flagReason: '',
      correctedText: ''
    };

    this.history.push(turnRecord);
    if (role === 'assistant') {
      this.turns++;
    }
    return turnRecord;
  }

  getRecentHistory(maxTurns = 8) {
    return this.history.slice(-maxTurns).map(t => ({
      role: t.role,
      content: t.correctedText || t.text
    }));
  }

  recordLatency(timings) {
    this.touch();
    this.turnLatencies.push(timings);
    if (timings.total) {
      latencyRecords.push(timings.total);
      if (latencyRecords.length > 500) {
        latencyRecords.shift();
      }
    }
  }

  end(reason = 'normal_clearing') {
    this.endTime = Date.now();
    this.status = this.status === 'transferred' ? 'transferred' : 'completed';
    this.endReason = reason;
    this.disposition = reason;

    // Save to call audit log for analyst review
    const auditRecord = {
      callId: this.callId,
      direction: this.direction,
      callerId: this.callerId,
      customerName: this.customerName || this.callerId,
      status: this.status,
      disposition: this.disposition,
      campaign: this.campaignId,
      language: this.language,
      turns: this.turns,
      startTime: this.startTime,
      endTime: this.endTime,
      duration_seconds: Math.round((this.endTime - this.startTime) / 1000),
      transferredTo: this.transferredTo,
      history: [...this.history],
      flagged: this.history.some(h => h.flagged)
    };

    const existingIdx = callAuditLog.findIndex(c => c.callId === this.callId);
    if (existingIdx >= 0) {
      callAuditLog[existingIdx] = auditRecord;
    } else {
      callAuditLog.unshift(auditRecord);
      if (callAuditLog.length > 1000) {
        callAuditLog.pop();
      }
    }
  }

  isExpired() {
    const now = Date.now();
    const age = now - this.startTime;
    const idleTime = now - this.lastActiveTime;
    return (
      age > CONFIG.SESSION_TTL.MAX_AGE_MS ||
      idleTime > CONFIG.SESSION_TTL.IDLE_TIMEOUT_MS ||
      (this.endTime && now - this.endTime > 300000) // Ended > 5m ago
    );
  }

  getMetrics() {
    const totalMs = this.turnLatencies.map(t => t.total || 0).sort((a, b) => a - b);
    const p50 = totalMs.length > 0 ? totalMs[Math.floor(totalMs.length * 0.5)] : 0;
    const p95 = totalMs.length > 0 ? totalMs[Math.floor(totalMs.length * 0.95)] : 0;

    return {
      duration_seconds: Math.round(((this.endTime || Date.now()) - this.startTime) / 1000),
      turn_count: this.turns,
      disposition: this.disposition,
      p50_latency_ms: p50,
      p95_latency_ms: p95,
      language: this.language,
      campaign: this.campaignId
    };
  }
}

// Memory Leak Prevention: Periodic TTL sweep timer (runs every 30 seconds)
setInterval(() => {
  const now = Date.now();
  // 1. Sweep expired sessions
  for (const [id, session] of sessions.entries()) {
    if (session.isExpired()) {
      if (!session.endTime) {
        session.end('session_timeout_ttl');
      }
      sessions.delete(id);
    }
  }

  // 2. Capacity protection: if above MAX_CAPACITY, evict oldest
  if (sessions.size > CONFIG.SESSION_TTL.MAX_CAPACITY) {
    const entries = Array.from(sessions.entries()).sort(
      (a, b) => a[1].lastActiveTime - b[1].lastActiveTime
    );
    const toRemove = entries.slice(0, sessions.size - CONFIG.SESSION_TTL.MAX_CAPACITY);
    for (const [id, s] of toRemove) {
      if (!s.endTime) s.end('capacity_evicted');
      sessions.delete(id);
    }
  }

  // 3. Sweep idempotency cache
  for (const [key, item] of idempotencyStore.entries()) {
    if (now - item.timestamp > CONFIG.SESSION_TTL.IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(key);
    }
  }
}, CONFIG.SESSION_TTL.SWEEP_INTERVAL_MS);

export function getOrCreateSession(callId, options = {}) {
  let session = sessions.get(callId);
  if (!session) {
    session = new CallSession(callId, options);
    sessions.set(callId, session);
  } else {
    session.touch();
    if (options.campaignId && !session.campaignId) session.campaignId = options.campaignId;
    if (options.language && !session.language) session.language = options.language;
    if (options.customerName && !session.customerName) session.customerName = options.customerName;
  }
  return session;
}

export function getSession(callId) {
  const s = sessions.get(callId);
  if (s) s.touch();
  return s;
}

export function deleteSession(callId) {
  const s = sessions.get(callId);
  if (s && !s.endTime) s.end('manual_reset');
  return sessions.delete(callId);
}

export function getAllSessions() {
  return Array.from(sessions.values());
}

export function getAuditCalls() {
  // Merge active and concluded calls
  const activeRecords = Array.from(sessions.values()).map(s => {
    const metrics = s.getMetrics();
    return {
      callId: s.callId,
      direction: s.direction,
      callerId: s.callerId,
      customerName: s.customerName || s.callerId,
      status: s.status,
      disposition: s.disposition,
      campaign: s.campaignId,
      language: s.language,
      turns: s.turns,
      startTime: s.startTime,
      endTime: s.endTime,
      duration_seconds: metrics.duration_seconds,
      transferredTo: s.transferredTo,
      history: [...s.history],
      flagged: s.history.some(h => h.flagged)
    };
  });

  const allMap = new Map();
  for (const c of callAuditLog) allMap.set(c.callId, c);
  for (const a of activeRecords) allMap.set(a.callId, a);

  return Array.from(allMap.values()).sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

// QA Analyst: Flag or unflag a turn
export function flagTurn(callId, turnId, flagReason = 'Quality issue flagged by analyst') {
  const s = sessions.get(callId);
  if (s) {
    const turn = s.history.find(t => t.turnId === turnId);
    if (turn) {
      turn.flagged = true;
      turn.flagReason = flagReason;
    }
  }

  const audit = callAuditLog.find(c => c.callId === callId);
  if (audit) {
    audit.flagged = true;
    const turn = audit.history.find(t => t.turnId === turnId);
    if (turn) {
      turn.flagged = true;
      turn.flagReason = flagReason;
    }
  }
}

// QA Analyst: Correct a transcript for model retraining / fine-tuning
export function correctTranscript(callId, turnId, correctedText) {
  const s = sessions.get(callId);
  if (s) {
    const turn = s.history.find(t => t.turnId === turnId);
    if (turn) {
      turn.correctedText = correctedText;
    }
  }

  const audit = callAuditLog.find(c => c.callId === callId);
  if (audit) {
    const turn = audit.history.find(t => t.turnId === turnId);
    if (turn) {
      turn.correctedText = correctedText;
    }
  }
}

// Export fine-tuning dataset in OpenAI / JSONL format from human corrections & golden turns
export function exportFineTuningDataset() {
  const calls = getAuditCalls();
  const dataset = [];

  for (const call of calls) {
    if (!call.history || call.history.length < 2) continue;
    const campaign = getCampaign(call.campaign);
    const messages = [
      {
        role: 'system',
        content: `You are ${campaign.persona} on a live telephone call for ${campaign.name}. Language: ${call.language || 'en'}.`
      }
    ];

    for (const turn of call.history) {
      if (turn.role === 'user') {
        messages.push({ role: 'user', content: turn.correctedText || turn.text });
      } else if (turn.role === 'assistant') {
        messages.push({ role: 'assistant', content: turn.correctedText || turn.text });
      }
    }

    if (messages.length >= 3) {
      dataset.push({ messages });
    }
  }

  return dataset;
}

// Idempotency: cache and retrieve responses for dialer retries
export function getIdempotentResponse(idempotencyKey) {
  if (!idempotencyKey) return null;
  const cached = idempotencyStore.get(idempotencyKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CONFIG.SESSION_TTL.IDEMPOTENCY_TTL_MS) {
    idempotencyStore.delete(idempotencyKey);
    return null;
  }
  return cached.result;
}

export function setIdempotentResponse(idempotencyKey, result) {
  if (!idempotencyKey) return;
  idempotencyStore.set(idempotencyKey, {
    result,
    timestamp: Date.now()
  });
}

export function getGlobalLatencyMetrics() {
  if (latencyRecords.length === 0) {
    return { p50: 0, p95: 0, sample_count: 0 };
  }
  const sorted = [...latencyRecords].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
    sample_count: sorted.length
  };
}
