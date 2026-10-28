# 🤖 AI Call Assistant & Telephony Dialer Integration

An intelligent, real-time AI Voice Agent and Telephony Integration Server designed for direct integration with your own dialer software (Vicidial, Asterisk, FreePBX, Twilio, Plivo, Telnyx, or custom VoIP/SIP dialers).

---

## 🌟 Key Features

1. **AI Agent Inbound & Outbound Calling**:
   - Automated greeting generation tailored for inbound support or outbound campaigns (e.g. Appointment Reminders, Payment Follow-ups, Customer Surveys).
   - Real-time conversation with context memory and conversational reasoning.

2. **Agent Extension Directory & Call Transfer**:
   - Built-in PBX Extension Directory (`101: General Support`, `102: Billing`, `103: Technical Escalations`, `104: Sales`, `200: Supervisor`).
   - **Speech-Intent Transfer**: When a caller asks for billing, technical help, or a human agent, the AI automatically triggers a warm transfer to the target SIP extension or phone number with audio transfer announcements.
   - Manual transfer endpoint for operators or automated dialers.

3. **Multi-Platform Dialer & PBX Compatibility**:
   - **REST API**: Standard JSON and multipart audio endpoints for custom dialers (Node.js, Python, Go, PHP).
   - **TwiML XML Webhooks**: Direct compatibility with Twilio, Plivo, Telnyx, and Asterisk/FreePBX voice trunks.
   - **Dual-Engine Speech Recognition**: Real-time client Web Speech API + server-side transcription fallback.

4. **Natural Neural Voice (TTS)**:
   - Low-latency Microsoft Edge Neural Voice streaming (`en-US-JennyNeural`).

---

## 🛠️ Tech Stack

- **Frontend**: Modern React 19 SPA with Vite, TypeScript, and Tailwind CSS.
- **AI Conversational Brain**: `@google/genai` (Gemini multi-model cascade) + Groq SDK fallback.
- **Speech-to-Text (ASR)**: Native Browser `SpeechRecognition` + Gemini multimodal audio decoder.
- **Voice Synthesis (TTS)**: `edge-tts-universal` (High-definition neural audio) with client Web Speech fallback.
- **Backend & Webhooks**: Express 5 on Node.js 22 with standardized `/api/webhook` contract and PBX dialer endpoints.
- **Interactive Dashboards**: Live Voice Assistant with real-time mic volume metering, DTMF dialpad, PBX extension routing board, and webhook inspector.

---

## 📞 Agent Extension Directory

The system comes pre-configured with the following PBX departments and SIP extensions:

| Ext ID | Department | Routing SIP URI | Trigger Keywords |
|---|---|---|---|
| **101** | General Customer Support | `sip:101@pbx.local` | support, general, help, agent, representative, person |
| **102** | Billing & Payments | `sip:102@pbx.local` | bill, billing, payment, pay, invoice, due, balance |
| **103** | Technical Support Escalations | `sip:103@pbx.local` | technical, tech, broken, error, bug, hardware, troubleshoot |
| **104** | Sales & New Accounts | `sip:104@pbx.local` | sales, buy, purchase, new account, pricing, quote, order |
| **200** | Human Supervisor / Tier 2 | `sip:200@pbx.local` | supervisor, manager, escalate, tier 2, complaint |

You can dynamically manage extensions via `GET /api/dialer/extensions` and `POST /api/dialer/extensions`.

---

## 🔌 Dialer Software Integration Guide

### 1. Initiate a Call (Inbound or Outbound AI Agent)

When your dialer places an outbound call or receives an inbound call, trigger this endpoint to initialize the AI session and receive the greeting audio.

**Endpoint**: `POST /api/dialer/call/start`

**Request Body (JSON)**:
```json
{
  "call_id": "dialer-call-001",
  "direction": "outbound",
  "caller_id": "+15551234567",
  "customer_name": "Sarah Connor",
  "campaign": "Account Payment Reminder",
  "custom_greeting": "Hello Sarah, this is an automated follow-up regarding your account payment."
}
```

**Response**:
```json
{
  "status": "success",
  "call_id": "dialer-call-001",
  "direction": "outbound",
  "call_status": "connected",
  "greeting": "Hello Sarah, this is an automated follow-up regarding your account payment.",
  "audio_url": "/api/audio/reply-1791533179823-wmjp6k.mp3",
  "available_extensions": [ ... ]
}
```

---

### 2. Process Caller Interaction & Extension Routing

Stream the caller's spoken audio file (WebM, WAV, OGG) OR pass recognized text to receive the AI response and transfer instructions.

**Endpoint**: `POST /api/dialer/call/interact`

**Request Body (JSON or Multipart)**:
```json
{
  "call_id": "dialer-call-001",
  "text": "I have an issue with my bill, please transfer me to extension 102"
}
```

**Response (When Transfer is Triggered)**:
```json
{
  "call_id": "dialer-call-001",
  "action": "transfer",
  "call_status": "transferred",
  "transcription": "I have an issue with my bill, please transfer me to extension 102",
  "response": "Certainly. I am transferring your call to Billing & Payments on extension 102. Please hold while I connect you.",
  "audio_url": "/api/audio/reply-transfer-102.mp3",
  "transfer": {
    "extension": "102",
    "name": "Billing & Payments",
    "department": "Billing & Accounting",
    "sip_uri": "sip:102@pbx.local",
    "phone_number": "+18005550102",
    "warm_transfer_notes": "Caller inquiry: \"I have an issue with my bill...\" Route: Billing & Payments (102)."
  }
}
```

> **Dialer Action**: When `action === "transfer"`, your dialer software plays `audio_url` to the caller, then bridges/transfers the call to `transfer.sip_uri` or `transfer.phone_number`.

**Response (When Continuing Conversation)**:
```json
{
  "call_id": "dialer-call-001",
  "action": "continue",
  "call_status": "in-progress",
  "response": "Your current account balance is $45.20 due on the 15th.",
  "audio_url": "/api/audio/reply-001.mp3"
}
```

---

### 3. Direct Manual Transfer Endpoint

To transfer a call directly to a specific extension programmatically:

**Endpoint**: `POST /api/dialer/call/transfer`

```bash
curl -X POST http://localhost:3000/api/dialer/call/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "call_id": "dialer-call-001",
    "extension_id": "103",
    "reason": "Escalated for technical diagnostics"
  }'
```

---

### 4. Telephony Carrier / Twilio / Asterisk Voice Webhook (TwiML XML)

If your dialer or PBX connects through Twilio, Plivo, Telnyx, or an Asterisk FreePBX gateway, point your Phone Number Voice URL to:

```
http://your-server-host:3000/api/dialer/telephony/twiml
```

The server automatically emits standard TwiML XML:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>http://your-server-host:3000/api/audio/greeting.mp3</Play>
  <Gather input="speech dtmf" action="http://your-server-host:3000/api/dialer/telephony/gather?call_id=..." method="POST" speechTimeout="auto" timeout="5" />
</Response>
```

When the caller asks for an extension, it returns:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>http://your-server-host:3000/api/audio/transfer-announcement.mp3</Play>
  <Dial callerId="+18005550100">
    <Sip>sip:102@pbx.local</Sip>
  </Dial>
</Response>
```

---

## 💻 Code Integration Examples

### Python Dialer Script

```python
import requests

BASE_URL = "http://localhost:3000"

# 1. Start Outbound Call Campaign
start_payload = {
    "direction": "outbound",
    "customer_name": "David Miller",
    "campaign": "Service Appointment Confirmation"
}
session = requests.post(f"{BASE_URL}/api/dialer/call/start", json=start_payload).json()
call_id = session["call_id"]
print("Greeting Audio:", f"{BASE_URL}{session['audio_url']}")

# 2. Transmit User Utterance to AI
interact_payload = {
    "call_id": call_id,
    "text": "Yes I would like to speak to a live representative about this"
}
reply = requests.post(f"{BASE_URL}/api/dialer/call/interact", json=interact_payload).json()

if reply["action"] == "transfer":
    ext = reply["transfer"]
    print(f"Transferring to {ext['name']} (Ext {ext['extension']}) via {ext['sip_uri']}")
```

### Node.js / TypeScript Integration

```typescript
const BASE_URL = 'http://localhost:3000';

async function handleDialerCall() {
  // 1. Start Call Session
  const startRes = await fetch(`${BASE_URL}/api/dialer/call/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      direction: 'inbound',
      caller_id: '+15553334444'
    })
  });
  const { call_id, greeting, audio_url } = await startRes.json();

  // 2. Interact
  const interactRes = await fetch(`${BASE_URL}/api/dialer/call/interact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      call_id,
      text: 'Can I pay my bill over the phone?'
    })
  });
  const data = await interactRes.json();
  console.log('AI Response:', data.response);
}
```

---

## 🚀 Running Locally

```bash
# Install dependencies
npm install

# Start the application
npm run dev
```

Open `http://localhost:3000` in your browser to access the interactive web interface, dialer simulator, and live PBX dashboard.

---

## 🌐 Deployment Options

### Option 1: Netlify (Frontend Static Host)
- Build command: `npm run build`
- Publish directory: `dist`
- The project includes `netlify.toml` with SPA redirects and microphone permissions configured.
- When deployed statically on Netlify, the app **automatically activates the Browser Voice Engine**:
  - Voice output uses the browser's high-fidelity `window.speechSynthesis`.
  - Microphone transcription uses the browser's native `webkitSpeechRecognition` (Chrome, Edge, Safari, iOS, Android).
  - Conversation logic runs client-side with full PBX transfer & intent recognition.

### Option 2: Render / Railway / Fly.io / Cloud Run (Full-Stack Node.js Server)
If you want the full cloud backend running with server-side Groq Whisper, Gemini 3.8 Flash, and Edge TTS audio:
- **Build command**: `npm run build`
- **Start command**: `npm start` (runs `tsx server.ts`)
- **Environment variables**: Add `GEMINI_API_KEY` and `GROQ_API_KEY` in the hosting platform's environment settings.

