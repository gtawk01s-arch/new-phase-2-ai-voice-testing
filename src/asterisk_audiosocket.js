import net from 'net';
import { CONFIG } from './config.js';
import { getOrCreateSession } from './session.js';
import { createPcm16WavBuffer, parseWavBuffer, resamplePcm16 } from './audio_processing.js';
import { transcribeAudio } from './asr.js';
import { processTurn } from './engine.js';
import { synthesizeSpeech } from './tts.js';

/**
 * Asterisk AudioSocket TCP Server (Protocol Specification — Guideline 10)
 *
 * Frame Header (3 bytes):
 *   - Byte 0: Message Type
 *       0x00 = Terminate / Hangup
 *       0x01 = Channel UUID (16-byte binary UUID)
 *       0x03 = DTMF digit (1-byte ASCII digit: '0'-'9', '*', '#')
 *       0x10 = 8kHz 16-bit Signed Linear PCM Audio (320 bytes = 20ms frame)
 *       0xFF = Error
 *   - Bytes 1..2: Payload Length (UInt16BE)
 *   - Bytes 3..(3+Length): Payload
 *
 * Capabilities:
 *   1. Full-duplex 8kHz PCM16 streaming into VICIdial / Asterisk 18+
 *   2. Real-time Barge-In: Immediately aborts outbound 0x10 frame streaming when caller speech is detected
 *   3. DTMF 0x03 Frame Handling: Supports IVR keypress routing (1->101, 2->102, 3->103, 4->104, 0->200, 9->DNC)
 *   4. Stage Latency Budget Logging: Logs VAD, ASR, LLM, TTS, and Total TTFA on every turn
 */
export function createAudioSocketServer(port = CONFIG.AUDIOSOCKET_PORT) {
  const server = net.createServer((socket) => {
    let callId = `ast-${Date.now()}`;
    let session = null;
    let rxBuffer = Buffer.alloc(0);

    // Speech accumulation & Barge-In state (8kHz 16-bit mono = 160 samples / 320 bytes per 20ms frame)
    let speechPcmChunks = [];
    let isSpeaking = false;
    let consecutiveSpeechFrames = 0;
    let silenceFramesCount = 0;
    let isProcessingTurn = false;
    let isPlayingOutbound = false;
    let abortOutboundPlayback = false;

    const sendAudioFrame8k = async (wavBuffer) => {
      const parsed = parseWavBuffer(wavBuffer);
      if (!parsed) return;
      const pcm8k = parsed.sampleRate === 8000
        ? parsed.samples
        : resamplePcm16(parsed.samples, parsed.sampleRate, 8000);

      const rawBytes = Buffer.alloc(pcm8k.length * 2);
      for (let i = 0; i < pcm8k.length; i++) {
        rawBytes.writeInt16LE(pcm8k[i], i * 2);
      }

      isPlayingOutbound = true;
      abortOutboundPlayback = false;

      try {
        // Stream back in 320-byte (20ms at 8kHz) AudioSocket 0x10 frames
        const FRAME_BYTES = 320;
        for (let offset = 0; offset < rawBytes.length; offset += FRAME_BYTES) {
          if (socket.destroyed || abortOutboundPlayback) {
            if (abortOutboundPlayback) {
              console.log(`[AudioSocket][${callId}] Barge-in triggered: halted outbound audio stream at byte ${offset}/${rawBytes.length}`);
            }
            break;
          }
          const slice = rawBytes.subarray(offset, Math.min(offset + FRAME_BYTES, rawBytes.length));
          const header = Buffer.alloc(3);
          header.writeUInt8(0x10, 0);
          header.writeUInt16BE(slice.length, 1);
          socket.write(Buffer.concat([header, slice]));
          await new Promise(r => setTimeout(r, 18));
        }
      } finally {
        isPlayingOutbound = false;
      }
    };

    const handleDtmfDigit = async (digit) => {
      if (!session) {
        session = getOrCreateSession(callId, { direction: 'inbound', campaignId: 'support_hi', language: 'hi' });
      }
      // Barge-in on keypress
      if (isPlayingOutbound) {
        abortOutboundPlayback = true;
        session.bargeInCount = (session.bargeInCount || 0) + 1;
      }
      session.dtmfDigits = session.dtmfDigits || [];
      session.dtmfDigits.push(digit);
      console.log(`[AudioSocket][${callId}] Received DTMF digit (0x03): '${digit}'`);

      const dtmfUtteranceMap = {
        '1': 'Transfer me to general support extension 101',
        '2': 'Transfer me to billing department extension 102',
        '3': 'Transfer me to technical support extension 103',
        '4': 'Transfer me to sales extension 104',
        '0': 'Transfer me to supervisor extension 200',
        '9': 'Please add my number to the do not call list'
      };

      const syntheticInput = dtmfUtteranceMap[digit] || `DTMF keypress ${digit}`;
      const tTurn = Date.now();
      const engineRes = await processTurn(session, syntheticInput);
      const tts0 = Date.now();
      const ttsRes = await synthesizeSpeech(engineRes.reply, {
        language: session.language,
        sampleRate: 8000,
        format: 'wav',
        nonBlocking: false,
        callId
      });
      const ttsMs = ttsRes.latency_ms || (Date.now() - tts0);
      const llmMs = engineRes.timing_ms?.llm || 0;
      session.recordLatency({ vad: 0, asr: 0, llm: llmMs, tts: ttsMs, total: Date.now() - tTurn });

      if (ttsRes.audio_buffer) {
        await sendAudioFrame8k(ttsRes.audio_buffer);
      }
      if (engineRes.action === 'hangup' || engineRes.action === 'transfer') {
        const hangupFrame = Buffer.from([0x00, 0x00, 0x00]);
        if (!socket.destroyed) socket.end(hangupFrame);
      }
    };

    const handleCompleteUtterance = async (pcmChunks) => {
      if (isProcessingTurn || pcmChunks.length === 0) return;
      isProcessingTurn = true;
      try {
        const combinedBytes = Buffer.concat(pcmChunks);
        const sampleCount = Math.floor(combinedBytes.length / 2);
        const samples8k = new Int16Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          samples8k[i] = combinedBytes.readInt16LE(i * 2);
        }

        // Wrap as 8kHz WAV; transcribeAudio automatically runs VAD + 8kHz->16kHz Sinc Upsampler
        const wav8k = createPcm16WavBuffer(samples8k, 8000);
        const asrRes = await transcribeAudio(wav8k, {
          callId,
          language: session?.language || 'hi',
          mimeType: 'audio/wav'
        });

        if (asrRes.text) {
          const tTurn = Date.now();
          const engineRes = await processTurn(session, asrRes.text);
          const tts0 = Date.now();
          const ttsRes = await synthesizeSpeech(engineRes.reply, {
            language: session.language,
            sampleRate: 8000,
            format: 'wav',
            nonBlocking: false,
            callId
          });
          const vadMs = asrRes.vad_ms || 0;
          const asrMs = asrRes.latency_ms || 0;
          const llmMs = engineRes.timing_ms?.llm || 0;
          const ttsMs = ttsRes.latency_ms || (Date.now() - tts0);
          const totalMs = asrMs + (Date.now() - tTurn);
          session.recordLatency({ vad: vadMs, asr: asrMs, llm: llmMs, tts: ttsMs, total: totalMs });

          if (ttsRes.audio_buffer) {
            await sendAudioFrame8k(ttsRes.audio_buffer);
          }
          if (engineRes.action === 'hangup' || engineRes.action === 'transfer') {
            const hangupFrame = Buffer.from([0x00, 0x00, 0x00]);
            if (!socket.destroyed) socket.end(hangupFrame);
          }
        }
      } catch (err) {
        console.error(`[AudioSocket][${callId}] Utterance processing error:`, err.message);
      } finally {
        isProcessingTurn = false;
      }
    };

    socket.on('data', (chunk) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);

      while (rxBuffer.length >= 3) {
        const msgType = rxBuffer.readUInt8(0);
        const payloadLen = rxBuffer.readUInt16BE(1);
        if (rxBuffer.length < 3 + payloadLen) break;

        const payload = rxBuffer.subarray(3, 3 + payloadLen);
        rxBuffer = rxBuffer.subarray(3 + payloadLen);

        if (msgType === 0x01) {
          // UUID packet
          const hex = payload.toString('hex');
          callId = `ast-${hex.slice(0, 8)}-${hex.slice(8, 12)}`;
          session = getOrCreateSession(callId, {
            direction: 'inbound',
            campaignId: 'support_hi',
            clientId: 'bharatfin_hi',
            language: 'hi',
            outputAudioFormat: 'wav'
          });
          console.log(`[AudioSocket] Connected Asterisk channel UUID: ${callId}`);
        } else if (msgType === 0x03) {
          // DTMF digit packet (1-byte ASCII digit)
          const digit = payload.toString('ascii').trim().slice(0, 1);
          if (digit) {
            handleDtmfDigit(digit).catch(err =>
              console.warn(`[AudioSocket][${callId}] DTMF error:`, err.message)
            );
          }
        } else if (msgType === 0x10) {
          // 20ms 8kHz 16-bit PCM frame (320 bytes)
          if (!session) {
            session = getOrCreateSession(callId, {
              direction: 'inbound',
              campaignId: 'support_hi',
              clientId: 'bharatfin_hi',
              language: 'hi'
            });
          }
          // Compute frame RMS energy to detect speech vs silence & barge-in
          let sumSq = 0;
          const nSamples = Math.floor(payload.length / 2);
          for (let i = 0; i < nSamples; i++) {
            const s = payload.readInt16LE(i * 2);
            sumSq += s * s;
          }
          const rms = nSamples > 0 ? Math.sqrt(sumSq / nSamples) : 0;
          const rmsDb = rms > 1 ? 20 * Math.log10(rms / 32768) : -96;

          if (rmsDb > -40) {
            consecutiveSpeechFrames++;
            // Real-time Barge-In: 2 consecutive active speech frames (40ms) interrupts agent playback immediately
            if (isPlayingOutbound && consecutiveSpeechFrames >= 2) {
              abortOutboundPlayback = true;
              session.bargeInCount = (session.bargeInCount || 0) + 1;
            }
            isSpeaking = true;
            silenceFramesCount = 0;
            speechPcmChunks.push(Buffer.from(payload));
          } else {
            consecutiveSpeechFrames = 0;
            if (isSpeaking) {
              silenceFramesCount++;
              speechPcmChunks.push(Buffer.from(payload));
              // 25 consecutive 20ms silence frames (500ms pause) -> end of caller utterance
              if (silenceFramesCount >= 25) {
                const captured = speechPcmChunks;
                speechPcmChunks = [];
                isSpeaking = false;
                silenceFramesCount = 0;
                handleCompleteUtterance(captured);
              }
            }
          }
        } else if (msgType === 0x00) {
          // Hangup
          abortOutboundPlayback = true;
          if (session) session.end('asterisk_hangup');
          socket.end();
        }
      }
    });

    socket.on('error', (err) => {
      console.warn(`[AudioSocket][${callId}] Socket error:`, err.message);
    });

    socket.on('close', () => {
      abortOutboundPlayback = true;
      if (session && (session.status === 'active' || session.status === 'connected')) {
        session.end('socket_closed');
      }
    });
  });

  server.on('error', (err) => {
    console.warn(`[AudioSocket] Server note:`, err.message);
  });

  return server;
}

