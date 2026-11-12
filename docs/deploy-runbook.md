# Sovereign GPU Voice Engine — Production Deploy & Disaster Recovery Runbook

This runbook enables any authorized engineer to provision, deploy, verify, back up, and recover the **100% Self-Hosted Sovereign GPU Voice & Telephony Stack** (`vLLM` 7B AWQ + `faster-whisper` / `AI4Bharat IndicConformer` 8kHz + `Indic Parler-TTS` / `Piper` + Asterisk `AudioSocket` into VICIdial) without third-party API dependencies.

---

## 0. Mandatory Pre-Deploy Governance Checklist (Guideline 7 & 14)

Before granting repository, Vault, or GPU cluster access to any engineer, contractor, or QA analyst:
1. **IP-Assignment & Confidentiality Agreement**: Verify signed IP-assignment agreement is archived in `s3://sovereign-voice-vault-mumbai/legal/ip-assignments/<employee_id>.pdf`.
2. **Commercial License Ledger Check**: Confirm all model weights and datasets in `/src/config.js` (`CONFIG.LICENSE_LEDGER`) carry **MIT**, **Apache-2.0**, **CC-BY-4.0**, or verified 1st-party client DPA consent with `commercialUseAllowed: true` and `resaleAllowed: true`.
3. **External API Sunset Enforcement**:
   - External APIs (`Gemini`, `Groq`, `OpenRouter`) are temporary bridge providers with a hard removal date of **`2026-12-31`**.
   - On sovereign production nodes, set `DISABLE_EXTERNAL_APIS=true` so zero traffic leaves our VPC.

---

## 1. Hardware & Cluster Topology (400,000 Calls/Day Capacity)

- **Daily Volume**: `400,000 calls/day` (`880,000 minutes/day` at `2.2 min` avg duration; peak `~850 concurrent calls`).
- **GPU Nodes (Mumbai DC `ap-south-1`, Bare-Metal / Dedicated VPC)**:
  - **Node Group A (ASR — 2x NVIDIA L40S 48GB)**: Runs `faster-whisper` (`whisper-large-v3-turbo-indic-8k-ft`, INT8/FP16) & `AI4Bharat IndicConformer` on port `8001`.
  - **Node Group B (Primary LLM — 4x NVIDIA L40S 48GB / A100 80GB)**: Runs **vLLM** serving `Qwen/Qwen2.5-7B-Instruct-AWQ-4bit-CampaignFT` with `--enable-prefix-caching --max-model-len 4096 --gpu-memory-utilization 0.92` on port `8000`.
  - **Node Group C (In-House Backup LLM — 1x NVIDIA L40S 48GB)**: Runs **vLLM** serving `Qwen/Qwen2.5-3B-Instruct-AWQ-InHouse` on port `8002` (Guideline 12 hot standby).
  - **Node Group D (Open Indic TTS — 2x NVIDIA L40S 48GB)**: Runs `Indic Parler-TTS` + `Piper ONNX` (2 voices per language: 1 Female, 1 Male, native 8kHz PCM output) on port `8003`.
- **Storage & State**:
  - **Object Storage**: Self-hosted **MinIO / Ceph S3** (`s3://sovereign-voice-vault-mumbai/`) with daily encrypted offsite snapshots (`RPO = 1 hour`, `RTO = 15 minutes`).
  - **Session Store**: Self-hosted **Redis 7 Cluster** with per-tenant key prefixes (`bfin:`, `swas:`, `qmart:`).

---

## 2. Step-by-Step Deployment Procedure

### Step 2.1: Fetch Secrets from HashiCorp Vault (Guideline 14)

Never store plaintext secrets in Git. Authenticate via Vault AppRole and render `/etc/sovereign-voice/.env`:

```bash
export VAULT_ADDR="https://vault.internal.voice-infra.in:8200"
vault login -method=approle role_id="$APPROLE_ID" secret_id="$SECRET_ID"

vault kv get -format=json kv-v2/telephony/production/gateway | jq -r '.data.data | to_entries|map("\(.key)=\(.value)")|.[]' > /etc/sovereign-voice/.env
chmod 600 /etc/sovereign-voice/.env
```

Required production environment variables in `/etc/sovereign-voice/.env`:
```ini
NODE_ENV=production
PORT=3000
AUDIOSOCKET_PORT=9092
DISABLE_EXTERNAL_APIS=true
ENFORCE_WEBHOOK_AUTH=true
WEBHOOK_SECRET=<vault-rotated-256bit-hmac-secret>
WEBHOOK_ALLOWED_IPS=127.0.0.1,10.20.1.15,10.20.2.40,10.20.3.80
SELF_HOSTED_ASR_URL=http://10.20.10.11:8001/v1/audio/transcriptions
SELF_HOSTED_VLLM_URL=http://10.20.10.21:8000/v1/chat/completions
SELF_HOSTED_SMALL_LLM_URL=http://10.20.10.22:8002/v1/chat/completions
SELF_HOSTED_TTS_URL=http://10.20.10.31:8003/v1/audio/speech
```

### Step 2.2: Launch Self-Hosted GPU Inference Containers

```bash
# 1. Primary 7B LLM on vLLM (Port 8000)
docker run -d --gpus '"device=0,1"' --restart always -p 8000:8000 \
  -v /mnt/nvme/models:/models \
  vllm/vllm-openai:latest \
  --model /models/llm/qwen2.5-7b-instruct-awq-campaign-v4 \
  --quantization awq --dtype half --enable-prefix-caching --max-model-len 4096

# 2. In-House 3B Backup LLM on Secondary GPU (Port 8002 — Guideline 12)
docker run -d --gpus '"device=2"' --restart always -p 8002:8000 \
  -v /mnt/nvme/models:/models \
  vllm/vllm-openai:latest \
  --model /models/llm/qwen2.5-3b-instruct-awq-backup \
  --quantization awq --dtype half --enable-prefix-caching --max-model-len 2048

# 3. 8kHz Fine-Tuned Whisper / IndicConformer ASR Server (Port 8001)
docker run -d --gpus '"device=3"' --restart always -p 8001:8001 \
  -v /mnt/nvme/models:/models \
  sovereign-voice/asr-whisper-8k:latest \
  --model /models/asr/whisper-v3-turbo-8k-hi-v2 --compute-type int8_float16

# 4. Open Indic TTS Server (Indic Parler-TTS + Piper, 2 Voices/Lang, Port 8003)
docker run -d --gpus '"device=3"' --restart always -p 8003:8003 \
  -v /mnt/nvme/models:/models \
  sovereign-voice/indic-tts-8k:latest \
  --voices hi-indic-aditi-f,hi-indic-aarav-m,en-indic-neerja-f,en-indic-prabhat-m
```

### Step 2.3: Deploy Voice Gateway & AudioSocket Server

```bash
git clone git@git.internal.voice-infra.in:telephony-ai/sovereign-voice-engine.git /opt/sovereign-voice
cd /opt/sovereign-voice
npm ci
npm run build
pm2 start ecosystem.config.cjs --env production
pm2 save
```

---

## 3. VICIdial & Asterisk 18+ AudioSocket Wiring (Guideline 10)

Add the following dialplan in `/etc/asterisk/extensions.conf` on the VICIdial telephony server:

```ini
[vicidial-ai-audiosocket]
exten => _X.,1,NoOp(Sovereign AI Voice Call from ${CALLERID(num)} for Campaign ${CAMPAIGN_ID})
 same => n,Answer()
 same => n,Set(CHANNEL(audioreadformat)=slin16)
 same => n,Set(CHANNEL(audiowriteformat)=slin16)
 same => n,Set(CALL_UUID=${SHELL(uuidgen | tr -d '\n')})
 ; Connect full-duplex 8kHz PCM16 AudioSocket with Barge-In & 0x03 DTMF
 same => n,AudioSocket(${CALL_UUID},10.20.10.5:9092)
 same => n,GotoIf($["${AI_TRANSFER_EXT}" != ""]?vicidial-transfer,${AI_TRANSFER_EXT},1)
 same => n,Hangup()

[vicidial-transfer]
exten => _1XX,1,NoOp(Warm/Blind SIP Transfer to Human Agent Ext ${EXTEN})
 same => n,Dial(SIP/${EXTEN}@sip.telephony.internal,30,tTr)
 same => n,Hangup()
```

---

## 4. Verification, Golden Set Gate Check & Rollback

```bash
# 1. Verify Health & Sovereign Mode
curl -s http://127.0.0.1:3000/api/health | jq .
curl -s http://127.0.0.1:3000/api/sovereign/overview | jq .sovereign_gpu

# 2. Run 5/5 Provider Failover & Auth Verification
node scripts/test_fallbacks.js

# 3. Score against 8kHz Phone Audio Suite (WER & Per-Stage Latency Budget Check)
curl -s -X POST http://127.0.0.1:3000/api/qa/run-audio-suite | jq '{passed, total, p50Latency, p95Latency, legMedians, werEnglish, werHindi}'
```

**Rollback Rule**: If `werHindi` regresses by `> 0.5%` on the 500+ Golden Test Set or `STAGE_LATENCY_BUG` exceeds `2%` of turns (`TTFA > 900ms`), immediately revert the model symlink in `/mnt/nvme/models` to the previous Sunday tag and restart `vLLM`.
