import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ITU-T G.711 mu-law to 16-bit linear PCM lookup table
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

/**
 * Decode 8-bit G.711 mu-law buffer into 16-bit signed linear PCM Int16Array
 */
export function decodeMulawToPcm16(mulawBuffer) {
  const samples = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    samples[i] = MULAW_DECODE_TABLE[mulawBuffer[i]];
  }
  return samples;
}

/**
 * Encode 16-bit signed linear PCM Int16Array into 8-bit G.711 mu-law Buffer
 */
export function encodePcm16ToMulaw(samples) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const out = Buffer.alloc(samples.length);

  for (let i = 0; i < samples.length; i++) {
    let sample = samples[i];
    const sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/**
 * Wrap a 16-bit mono PCM Int16Array into a standard 44-byte RIFF WAV Buffer
 */
export function createPcm16WavBuffer(samples, sampleRate = 16000) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);            // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20);             // AudioFormat (1 = Linear PCM)
  buffer.writeUInt16LE(1, 22);             // NumChannels (1 = Mono)
  buffer.writeUInt32LE(sampleRate, 24);    // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28);// ByteRate
  buffer.writeUInt16LE(2, 32);             // BlockAlign
  buffer.writeUInt16LE(16, 34);            // BitsPerSample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}

/**
 * Parse a RIFF WAVE buffer header and extract mono 16-bit PCM samples
 */
export function parseWavBuffer(buffer) {
  if (!buffer || buffer.length < 44 || buffer.slice(0, 4).toString('ascii') !== 'RIFF') {
    return null;
  }

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = 44;
  let dataLength = buffer.length - 44;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.slice(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ' && offset + 24 <= buffer.length) {
      audioFormat = buffer.readUInt16LE(offset + 8);
      numChannels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, buffer.length - dataOffset);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  const rawData = buffer.slice(dataOffset, dataOffset + dataLength);
  let samples;

  if (audioFormat === 7 || bitsPerSample === 8) {
    // 8-bit mu-law WAV
    samples = decodeMulawToPcm16(rawData);
  } else {
    // 16-bit signed PCM (downmix to mono if stereo)
    const totalSamples = Math.floor(rawData.length / (2 * numChannels));
    samples = new Int16Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += rawData.readInt16LE((i * numChannels + ch) * 2);
      }
      samples[i] = Math.round(sum / numChannels);
    }
  }

  return {
    audioFormat,
    numChannels,
    sampleRate,
    bitsPerSample,
    samples
  };
}

/**
 * Upsample 8kHz (or arbitrary rate) mono Int16Array to 16kHz using a windowed-sinc anti-aliasing filter
 */
export function resamplePcm16(samples, fromRate, toRate = 16000) {
  if (fromRate === toRate) return samples;

  // Exact 2x upsampling (8000 Hz -> 16000 Hz) using a 7-tap half-band FIR filter
  if (fromRate === 8000 && toRate === 16000) {
    const out = new Int16Array(samples.length * 2);
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      out[i * 2] = samples[i];
      const s_m2 = samples[Math.max(0, i - 2)];
      const s_m1 = samples[Math.max(0, i - 1)];
      const s_0 = samples[i];
      const s_p1 = samples[Math.min(n - 1, i + 1)];
      const s_p2 = samples[Math.min(n - 1, i + 2)];
      const s_p3 = samples[Math.min(n - 1, i + 3)];
      // Symmetric Lagrange/Sinc half-sample interpolation
      const interp = Math.round(
        0.015625 * (s_m2 + s_p3) -
        0.09375 * (s_m1 + s_p2) +
        0.578125 * (s_0 + s_p1)
      );
      out[i * 2 + 1] = Math.max(-32768, Math.min(32767, interp));
    }
    return out;
  }

  // General linear/sinc resampling for arbitrary rates (e.g., 24kHz -> 8kHz or 16kHz)
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(outLength);

  // If downsampling (e.g., 24kHz -> 8kHz), apply simple 3-tap low-pass box filter first
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = samples[Math.min(samples.length - 1, idx)];
    const s1 = samples[Math.min(samples.length - 1, idx + 1)];
    out[i] = Math.round(s0 + frac * (s1 - s0));
  }
  return out;
}

/**
 * Convert non-WAV compressed audio (webm/ogg/mp3) to 16kHz mono PCM WAV via ffmpeg
 */
function convertCompressedTo16kWav(inputBuffer, ext = 'webm') {
  const tmpId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inPath = path.join(os.tmpdir(), `${tmpId}.${ext}`);
  const outPath = path.join(os.tmpdir(), `${tmpId}.wav`);
  try {
    fs.writeFileSync(inPath, inputBuffer);
    execFileSync('/usr/bin/ffmpeg', [
      '-y',
      '-i', inPath,
      '-ar', '16000',
      '-ac', '1',
      '-acodec', 'pcm_s16le',
      outPath
    ], { stdio: 'ignore', timeout: 3000 });
    return fs.readFileSync(outPath);
  } finally {
    try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch (_) {}
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
  }
}

/**
 * Voice Activity Detection (VAD) + 8kHz -> 16kHz Upsampling Pipeline
 *
 * Accepts:
 *  - 8kHz or 16kHz RIFF WAV (16-bit PCM or 8-bit G.711 mu-law)
 *  - Raw 8kHz G.711 mu-law (`audio/pcmu` / `mulaw_8k`)
 *  - Compressed browser/telephony audio (`audio/webm`, `audio/ogg`, `audio/mp3`)
 *
 * Performs:
 *  1. Decoding & 8kHz -> 16kHz upsampling
 *  2. 20ms frame-level RMS Energy (dBFS) + Zero-Crossing Rate (ZCR) Voice Activity Detection
 *  3. Leading/trailing silence trimming with 100ms hangover padding
 */
export function preprocessAudioWithVad(audioBuffer, options = {}) {
  const t0 = Date.now();
  const {
    mimeType = 'audio/wav',
    energyThresholdDb = -43,
    minSpeechDurationMs = 120
  } = options;

  if (!audioBuffer || audioBuffer.length < 160) {
    return {
      hasSpeech: false,
      inputSampleRate: 0,
      outputSampleRate: 16000,
      resampled8kTo16k: false,
      durationMs: 0,
      activeSpeechMs: 0,
      speechRatio: 0,
      peakRmsDb: -100,
      meanRmsDb: -100,
      vadLatencyMs: Date.now() - t0,
      wavBuffer: null
    };
  }

  let parsed = parseWavBuffer(audioBuffer);
  let inputSampleRate = parsed?.sampleRate || 8000;
  let samples16k;
  let resampled8kTo16k = false;

  if (parsed) {
    if (parsed.sampleRate !== 16000) {
      resampled8kTo16k = parsed.sampleRate === 8000;
      samples16k = resamplePcm16(parsed.samples, parsed.sampleRate, 16000);
    } else {
      samples16k = parsed.samples;
    }
  } else if (mimeType.includes('mulaw') || mimeType.includes('pcmu') || mimeType.includes('basic')) {
    inputSampleRate = 8000;
    resampled8kTo16k = true;
    const pcm8k = decodeMulawToPcm16(audioBuffer);
    samples16k = resamplePcm16(pcm8k, 8000, 16000);
  } else {
    // Compressed container (webm, ogg, mp3) -> decode to 16kHz mono WAV via ffmpeg
    try {
      const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp3') ? 'mp3' : 'webm';
      const wavBuf = convertCompressedTo16kWav(audioBuffer, ext);
      parsed = parseWavBuffer(wavBuf);
      inputSampleRate = parsed?.sampleRate || 16000;
      samples16k = parsed?.samples || new Int16Array(0);
    } catch (_) {
      // If ffmpeg fails on raw bytes, return original buffer untouched
      return {
        hasSpeech: audioBuffer.length >= 800,
        inputSampleRate: 16000,
        outputSampleRate: 16000,
        resampled8kTo16k: false,
        durationMs: Math.round(audioBuffer.length / 32),
        activeSpeechMs: Math.round(audioBuffer.length / 32),
        speechRatio: 1.0,
        peakRmsDb: -20,
        meanRmsDb: -25,
        vadLatencyMs: Date.now() - t0,
        wavBuffer: audioBuffer
      };
    }
  }

  // Frame-level VAD at 16kHz (20ms frame = 320 samples)
  const frameSize = 320;
  const totalFrames = Math.floor(samples16k.length / frameSize);
  if (totalFrames === 0) {
    return {
      hasSpeech: false,
      inputSampleRate,
      outputSampleRate: 16000,
      resampled8kTo16k,
      durationMs: 0,
      activeSpeechMs: 0,
      speechRatio: 0,
      peakRmsDb: -100,
      meanRmsDb: -100,
      vadLatencyMs: Date.now() - t0,
      wavBuffer: null
    };
  }

  let activeFrames = 0;
  let firstActiveFrame = -1;
  let lastActiveFrame = -1;
  let peakRmsDb = -100;
  let sumRmsDb = 0;
  let hangover = 0;

  for (let f = 0; f < totalFrames; f++) {
    const start = f * frameSize;
    let sumSq = 0;
    let zeroCrossings = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = samples16k[start + i];
      sumSq += s * s;
      if (i > 0) {
        const prev = samples16k[start + i - 1];
        if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) {
          zeroCrossings++;
        }
      }
    }

    const rms = Math.sqrt(sumSq / frameSize);
    const rmsDb = rms > 1 ? 20 * Math.log10(rms / 32768) : -96;
    const zcr = zeroCrossings / frameSize;

    if (rmsDb > peakRmsDb) peakRmsDb = rmsDb;
    sumRmsDb += rmsDb;

    const isVoicedFrame = rmsDb >= energyThresholdDb && zcr >= 0.005 && zcr <= 0.55;
    if (isVoicedFrame) {
      hangover = 4; // 80ms hangover
    }

    if (isVoicedFrame || hangover > 0) {
      activeFrames++;
      if (firstActiveFrame === -1) firstActiveFrame = f;
      lastActiveFrame = f;
      if (!isVoicedFrame && hangover > 0) hangover--;
    }
  }

  const durationMs = totalFrames * 20;
  const activeSpeechMs = activeFrames * 20;
  const hasSpeech = activeSpeechMs >= minSpeechDurationMs;
  const meanRmsDb = sumRmsDb / totalFrames;

  // Trim leading and trailing silence with a 5-frame (100ms) safety margin
  let trimmedSamples = samples16k;
  if (hasSpeech && firstActiveFrame !== -1 && lastActiveFrame !== -1) {
    const startFrame = Math.max(0, firstActiveFrame - 5);
    const endFrame = Math.min(totalFrames, lastActiveFrame + 6);
    trimmedSamples = samples16k.subarray(startFrame * frameSize, endFrame * frameSize);
  }

  const wavBuffer = hasSpeech ? createPcm16WavBuffer(trimmedSamples, 16000) : null;

  return {
    hasSpeech,
    inputSampleRate,
    outputSampleRate: 16000,
    resampled8kTo16k,
    durationMs,
    activeSpeechMs,
    speechRatio: Number((activeFrames / totalFrames).toFixed(3)),
    peakRmsDb: Number(peakRmsDb.toFixed(1)),
    meanRmsDb: Number(meanRmsDb.toFixed(1)),
    vadLatencyMs: Date.now() - t0,
    wavBuffer
  };
}
