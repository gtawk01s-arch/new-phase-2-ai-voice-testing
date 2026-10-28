# Telephony Webhook Contract Specification (v1.0.0)

## Overview
This document defines the strict bidirectional webhook protocol between the Telephony Dialer / PBX Trunk (e.g. FreePBX, Asterisk, Twilio, SIP Gateway) and the AI Voice Agent conversational engine.

---

## 1. Lifecycle Events
The telephony gateway sends events to the webhook endpoint (`POST /api/webhook/call` and `POST /api/webhook/turn`):

| Event Name | Trigger | Primary Payload Fields |
|---|---|---|
| `call_answered` | Inbound or outbound call picks up | `call_id`, `caller_id`, `direction`, `campaign_id` |
| `audio_transcribed` | Telephony ASR or gateway transcribed audio | `call_id`, `text`, `confidence`, `turn_index` |
| `audio_chunk` | Raw caller audio chunk (file, base64, or binary) | `call_id`, `audio_base64`, `format`, `sample_rate` |
| `barge_in` | Caller interrupted during agent speech | `call_id`, `timestamp` |
| `dtmf_received` | Keypad digits dialed | `call_id`, `digits` |
| `call_ended` | Caller or agent hung up | `call_id`, `reason`, `duration_seconds` |
| `error` | Media stream or network failure | `call_id`, `error_code`, `message` |

---

## 2. Agent Action Responses
The AI conversational engine responds synchronously with an action command:

| Action | Meaning | Required Fields |
|---|---|---|
| `speak_and_listen` | Agent speaks text/audio and waits for caller speech | `reply`, `audio_url`, `audio_base64`, `action="speak_and_listen"` |
| `transfer` | Bridge or transfer call to PBX extension or PSTN number | `action="transfer"`, `transfer: { extension, name, sip_uri, phone_number, reason }` |
| `hangup` | Conclude the phone call | `action="hangup"`, `reply`, `disposition` |
| `callback` | Schedule an automated callback | `action="callback"`, `callback_time`, `disposition` |

---

## 3. Audio Formats

### Inbound Audio Formats (Caller -> AI Engine)
Supported via `POST /api/webhook/turn`:
1. **Multipart File Upload**: Field `audio` (audio/webm, audio/wav, audio/ogg, audio/mp3).
2. **Base64 Encoded JSON**: Field `audio_base64`, with `format: "wav" | "webm" | "mulaw"` and `sample_rate: 8000 | 16000`.
3. **Direct Transcribed Text**: Field `text` (when gateway handles edge ASR).

### Outbound Audio Formats (AI Engine -> Caller)
Configured via request header `Accept-Audio` or field `output_audio_format`:
- `mp3`: Standard web/mobile telephony format (44.1kHz or 24kHz).
- `wav`: 16kHz 16-bit Linear PCM (standard for WebRTC & SIP RTP).
- `mulaw_8k`: G.711 u-law 8kHz 8-bit (standard PSTN / TDM telephony payload).

---

## 4. Exact JSON Schemas

### Request: `POST /api/webhook/call` (Call Answered)
```json
{
  "event": "call_answered",
  "call_id": "call-1729000000-abcde",
  "direction": "inbound",
  "caller_id": "+15551234567",
  "called_number": "+18005550100",
  "campaign_id": "customer_support",
  "language": "en",
  "output_audio_format": "mp3"
}
```

### Response: `200 OK` (Call Answered Response)
```json
{
  "call_id": "call-1729000000-abcde",
  "action": "speak_and_listen",
  "intent": "greeting",
  "reply": "Thank you for calling Customer Support. I am Alex, your automated AI phone agent. How can I help you today?",
  "audio_url": "/api/audio/cached-greeting-support.mp3",
  "audio_format": "mp3",
  "disposition": "in_progress",
  "confidence": 1.0,
  "timing_ms": {
    "llm_first_token": 0,
    "tts_generation": 2,
    "total": 3
  }
}
```

### Request: `POST /api/webhook/turn` (Caller Turn)
```json
{
  "event": "audio_transcribed",
  "call_id": "call-1729000000-abcde",
  "text": "What is your refund policy?",
  "audio_base64": null,
  "output_audio_format": "mp3"
}
```

### Response: `200 OK` (Caller Turn Response)
```json
{
  "call_id": "call-1729000000-abcde",
  "action": "speak_and_listen",
  "intent": "policy_inquiry",
  "reply": "You can return items within 30 days of purchase for a full refund with your receipt, or store credit if you have proof of purchase.",
  "audio_url": "/api/audio/reply-1729000005.mp3",
  "audio_format": "mp3",
  "disposition": "in_progress",
  "confidence": 0.98,
  "timing_ms": {
    "asr": 0,
    "llm": 420,
    "tts": 210,
    "total": 630
  }
}
```

### Response: `200 OK` (Transfer Action)
```json
{
  "call_id": "call-1729000000-abcde",
  "action": "transfer",
  "intent": "request_agent",
  "reply": "Certainly! I am transferring your call to Billing and Accounting on extension 102. Please hold while I connect you.",
  "audio_url": "/api/audio/cached-transfer-102.mp3",
  "disposition": "transferred",
  "transfer": {
    "extension": "102",
    "name": "Billing & Payments",
    "department": "Billing & Accounting",
    "sip_uri": "sip:102@pbx.local",
    "phone_number": "+18005550102",
    "reason": "Caller requested billing department"
  },
  "timing_ms": {
    "total": 350
  }
}
```

### Request: `POST /api/webhook/hangup` (Call Ended)
```json
{
  "event": "call_ended",
  "call_id": "call-1729000000-abcde",
  "reason": "normal_clearing",
  "duration_seconds": 84
}
```

### Response: `200 OK` (Call Ended Summary)
```json
{
  "status": "closed",
  "call_id": "call-1729000000-abcde",
  "summary": {
    "duration_seconds": 84,
    "turn_count": 5,
    "disposition": "resolved",
    "metrics": {
      "p50_latency_ms": 610,
      "p95_latency_ms": 840
    }
  }
}
```
