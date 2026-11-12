// Web Audio API Utilities for Telephone Sound Effects, Ringback, DTMF & Microphone Monitoring

let audioCtx: AudioContext | null = null;
let ringOsc1: OscillatorNode | null = null;
let ringOsc2: OscillatorNode | null = null;
let ringGain: GainNode | null = null;

export function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Telephone Ringback Tone (US Standard: 440Hz + 480Hz modulated)
export function startRingbackTone(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    stopRingbackTone();

    ringGain = ctx.createGain();
    ringGain.gain.setValueAtTime(0.08, ctx.currentTime);
    ringGain.connect(ctx.destination);

    ringOsc1 = ctx.createOscillator();
    ringOsc2 = ctx.createOscillator();
    ringOsc1.type = 'sine';
    ringOsc2.type = 'sine';
    ringOsc1.frequency.setValueAtTime(440, ctx.currentTime);
    ringOsc2.frequency.setValueAtTime(480, ctx.currentTime);

    ringOsc1.connect(ringGain);
    ringOsc2.connect(ringGain);
    ringOsc1.start();
    ringOsc2.start();
  } catch (e) {
    console.warn('Ringback audio error:', e);
  }
}

export function stopRingbackTone(): void {
  try {
    if (ringOsc1) {
      ringOsc1.stop();
      ringOsc1.disconnect();
      ringOsc1 = null;
    }
    if (ringOsc2) {
      ringOsc2.stop();
      ringOsc2.disconnect();
      ringOsc2 = null;
    }
    if (ringGain) {
      ringGain.disconnect();
      ringGain = null;
    }
  } catch (e) {}
}

// DTMF Keypad Tone Generator
const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477]
};

export function playDtmfTone(key: string): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const freqs = DTMF_FREQS[key];
    if (!freqs) return;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(freqs[0], ctx.currentTime);
    osc2.frequency.setValueAtTime(freqs[1], ctx.currentTime);

    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 0.18);
    osc2.stop(ctx.currentTime + 0.18);
  } catch (e) {
    console.warn('DTMF audio error:', e);
  }
}

// Call Connection & Disconnection Chime
export function playCallChime(isConnect = true): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isConnect ? 587.33 : 329.63, ctx.currentTime);
    if (isConnect) {
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
    }
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch (e) {}
}

let activePlaybackAudio: HTMLAudioElement | null = null;
let sharedAudioElement: HTMLAudioElement | null = null;
let activeBufferSource: AudioBufferSourceNode | null = null;
let currentPlaySessionId = 0;
let activeUtterance: SpeechSynthesisUtterance | null = null;
let utteranceKeepAliveTimer: any = null;
let isSpeechCurrentlySpeaking = false;

export function isAudioPlaying(): boolean {
  if (activePlaybackAudio && !activePlaybackAudio.paused && !activePlaybackAudio.ended) {
    return true;
  }
  return isSpeechCurrentlySpeaking;
}

export function stopSpeechAudio(): void {
  currentPlaySessionId++; // Invalidate any running session
  isSpeechCurrentlySpeaking = false;

  if (utteranceKeepAliveTimer) {
    clearInterval(utteranceKeepAliveTimer);
    utteranceKeepAliveTimer = null;
  }

  if (activeBufferSource) {
    try {
      activeBufferSource.onended = null;
      activeBufferSource.stop();
      activeBufferSource.disconnect();
    } catch (e) {}
    activeBufferSource = null;
  }

  if (activePlaybackAudio) {
    try {
      activePlaybackAudio.onended = null;
      activePlaybackAudio.onerror = null;
      activePlaybackAudio.onpause = null;
      activePlaybackAudio.pause();
      activePlaybackAudio.currentTime = 0;
    } catch (e) {}
    activePlaybackAudio = null;
  }

  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      if (activeUtterance) {
        activeUtterance.onend = null;
        activeUtterance.onerror = null;
        activeUtterance = null;
      }
      window.speechSynthesis.cancel();
    } catch (e) {}
  }
}

// Permanent reference set to prevent Chromium V8 garbage-collecting active SpeechSynthesisUtterance objects mid-speech
const activeUtterancesSet = new Set<SpeechSynthesisUtterance>();

// Cache voices eagerly
let cachedVoices: SpeechSynthesisVoice[] = [];
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  try {
    cachedVoices = window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => {
      try {
        cachedVoices = window.speechSynthesis.getVoices();
      } catch (e) {}
    };
  } catch (e) {}
}

export function unlockAudioPlayback(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    // 1. Prime persistent HTML5 Audio element under user gesture
    if (typeof window !== 'undefined') {
      try {
        if (!sharedAudioElement) {
          sharedAudioElement = new Audio();
          sharedAudioElement.preload = 'auto';
        }
        // Only play silent WAV if nothing is currently playing on sharedAudioElement
        if (sharedAudioElement.paused || sharedAudioElement.ended) {
          sharedAudioElement.src =
            'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
          sharedAudioElement.volume = 0.01;
          sharedAudioElement
            .play()
            .then(() => {
              if (sharedAudioElement && sharedAudioElement.src.startsWith('data:audio/wav')) {
                sharedAudioElement.pause();
                sharedAudioElement.volume = 1.0;
              }
            })
            .catch(() => {});
        }
      } catch (e) {}
    }

    // 2. Prime Web Speech API Synthesis under user gesture
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.resume();
      } catch (e) {}
    }
  } catch (e) {}
}

// Automatically unlock audio on first user interaction anywhere in the document
if (typeof window !== 'undefined') {
  const autoUnlock = () => {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      if (!sharedAudioElement) {
        unlockAudioPlayback();
      }
    } catch (e) {}
  };
  window.addEventListener('pointerdown', autoUnlock, { passive: true });
  window.addEventListener('keydown', autoUnlock, { passive: true });
}

export const unlockAudioContext = unlockAudioPlayback;

export function resumeAudioAndSpeech(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.resume();
    }
  } catch (e) {}
}

export function playVoiceAudio(
  text: string,
  audioUrl?: string | null,
  voiceName?: string,
  isSpeakerOn = true
): Promise<void> {
  return new Promise((resolve) => {
    // If muted / speaker off, resolve immediately
    if (!isSpeakerOn) {
      resolve();
      return;
    }

    // Stop any existing playback and initiate a unique session ID
    stopSpeechAudio();
    const sessionId = currentPlaySessionId;

    let hasCompleted = false;
    let safetyTimeout: any = null;

    const complete = () => {
      if (sessionId !== currentPlaySessionId) return;
      if (!hasCompleted) {
        hasCompleted = true;
        isSpeechCurrentlySpeaking = false;
        if (safetyTimeout) clearTimeout(safetyTimeout);
        if (utteranceKeepAliveTimer) {
          clearInterval(utteranceKeepAliveTimer);
          utteranceKeepAliveTimer = null;
        }
        activePlaybackAudio = null;
        activeBufferSource = null;
        if (activeUtterance) {
          activeUtterancesSet.delete(activeUtterance);
          activeUtterance = null;
        }
        resolve();
      }
    };

    // Dynamic safety timeout based on word count (so agent never hangs if browser audio event is dropped)
    const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
    const safetyDurationMs = Math.max(4000, Math.min(20000, words * 450 + 2500));
    safetyTimeout = setTimeout(complete, safetyDurationMs);

    // Browser Web Speech API synthesis fallback
    const speakViaBrowserSynthesis = () => {
      if (sessionId !== currentPlaySessionId) return;

      if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) {
        complete();
        return;
      }

      try {
        const clean = text
          .replace(/[*_#`~[\]]/g, '')
          .replace(/https?:\/\/\S+/g, '')
          .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}]/gu, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!clean) {
          complete();
          return;
        }

        // Small 50ms delay ensures Chromium background audio thread has finished cancel() teardown
        setTimeout(() => {
          if (sessionId !== currentPlaySessionId) return;

          try {
            const utterance = new SpeechSynthesisUtterance(clean);
            activeUtterance = utterance;
            activeUtterancesSet.add(utterance);
            utterance.rate = 1.0;
            utterance.pitch = 1.0;

            const isHindi = /[\u0900-\u097F]/.test(clean) || voiceName?.toLowerCase().includes('hi') || voiceName?.toLowerCase().includes('swara') || voiceName?.toLowerCase().includes('aarav');
            utterance.lang = isHindi ? 'hi-IN' : 'en-US';

            const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();
            if (voices && voices.length > 0) {
              cachedVoices = voices;
              if (isHindi) {
                const hiVoice = voices.find((v) => v.lang.startsWith('hi') || /hindi/i.test(v.name));
                if (hiVoice) utterance.voice = hiVoice;
              } else {
                const isGuy = voiceName?.toLowerCase().includes('guy') || voiceName?.toLowerCase().includes('male');
                let matchedVoice = null;
                if (isGuy) {
                  matchedVoice = voices.find(
                    (v) => /natural|neural|online/i.test(v.name) && /guy|david|mark|george|male/i.test(v.name)
                  ) || voices.find((v) => /guy|david|mark|james/i.test(v.name));
                } else {
                  matchedVoice = voices.find(
                    (v) => /natural|neural|online/i.test(v.name) && /jenny|aria|samantha|female/i.test(v.name)
                  ) || voices.find(
                    (v) => /google us english|jenny|samantha|victoria|zira/i.test(v.name)
                  );
                }
                if (matchedVoice) {
                  utterance.voice = matchedVoice;
                }
              }
            }

            let startFired = false;
            utterance.onstart = () => {
              startFired = true;
              if (sessionId === currentPlaySessionId) {
                isSpeechCurrentlySpeaking = true;
              }
            };

            utterance.onend = () => {
              activeUtterancesSet.delete(utterance);
              if (sessionId === currentPlaySessionId) {
                isSpeechCurrentlySpeaking = false;
                complete();
              }
            };

            utterance.onerror = (e) => {
              activeUtterancesSet.delete(utterance);
              if (sessionId === currentPlaySessionId) {
                if (e.error !== 'interrupted' && e.error !== 'canceled') {
                  console.warn('Speech synthesis ended with event:', e.error);
                }
                isSpeechCurrentlySpeaking = false;
                complete();
              }
            };

            if (window.speechSynthesis.paused) {
              window.speechSynthesis.resume();
            }

            isSpeechCurrentlySpeaking = true;
            window.speechSynthesis.speak(utterance);
            window.speechSynthesis.resume();

            const watchdog = setTimeout(() => {
              if (sessionId === currentPlaySessionId && !startFired) {
                try {
                  window.speechSynthesis.resume();
                } catch (e) {}
              }
            }, 250);

            utteranceKeepAliveTimer = setInterval(() => {
              if (sessionId !== currentPlaySessionId) {
                clearInterval(utteranceKeepAliveTimer);
                clearTimeout(watchdog);
                return;
              }
              try {
                if (window.speechSynthesis.paused || window.speechSynthesis.pending || !startFired) {
                  window.speechSynthesis.resume();
                }
              } catch (e) {}
            }, 800);
          } catch (speakErr) {
            console.warn('Speech synthesis dispatch error:', speakErr);
            isSpeechCurrentlySpeaking = false;
            complete();
          }
        }, 50);
      } catch (err) {
        console.warn('SpeechSynthesis error:', err);
        isSpeechCurrentlySpeaking = false;
        complete();
      }
    };

    // Helper to play via HTMLAudioElement (using unlocked sharedAudioElement if available)
    const playViaHtmlAudio = (srcUrl: string) => {
      if (sessionId !== currentPlaySessionId) return;
      try {
        const audio = sharedAudioElement || new Audio();
        sharedAudioElement = audio;
        activePlaybackAudio = audio;
        audio.volume = 1.0;
        audio.muted = false;
        audio.src = srcUrl;

        audio.onended = () => {
          if (sessionId === currentPlaySessionId) {
            isSpeechCurrentlySpeaking = false;
            complete();
          }
        };
        audio.onerror = () => {
          if (sessionId === currentPlaySessionId) {
            speakViaBrowserSynthesis();
          }
        };

        isSpeechCurrentlySpeaking = true;
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch(() => {
            if (sessionId === currentPlaySessionId) {
              speakViaBrowserSynthesis();
            }
          });
        }
      } catch (e) {
        speakViaBrowserSynthesis();
      }
    };

    // If server provided an audio URL (and it is not a sine-tone fallback file):
    if (audioUrl && !audioUrl.includes('fallback-')) {
      const fetchWithTimeout = Promise.race([
        fetch(audioUrl).then(async (res) => {
          if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
          const contentType = res.headers.get('content-type') || 'audio/mpeg';
          const buf = await res.arrayBuffer();
          if (!buf || buf.byteLength < 256) throw new Error('Empty audio buffer');
          return { buf, contentType };
        }),
        new Promise<{ buf: ArrayBuffer; contentType: string }>((_, reject) =>
          setTimeout(() => reject(new Error('Audio fetch timeout')), 2500)
        )
      ]);

      fetchWithTimeout
        .then(async ({ buf, contentType }) => {
          if (sessionId !== currentPlaySessionId) return;

          const ctx = getAudioContext();
          if (ctx && ctx.state === 'suspended') {
            try {
              await Promise.race([
                ctx.resume(),
                new Promise((_, r) => setTimeout(r, 150))
              ]);
            } catch (e) {}
          }

          // Only use Web Audio API if AudioContext is actively running!
          if (ctx && ctx.state === 'running') {
            try {
              const decoded = await ctx.decodeAudioData(buf.slice(0));
              if (sessionId !== currentPlaySessionId) return;
              const source = ctx.createBufferSource();
              source.buffer = decoded;
              source.connect(ctx.destination);
              activeBufferSource = source;
              isSpeechCurrentlySpeaking = true;
              source.onended = () => {
                if (sessionId === currentPlaySessionId) {
                  isSpeechCurrentlySpeaking = false;
                  complete();
                }
              };
              source.start(0);
              return;
            } catch (decodeErr) {
              // Fall through to HTMLAudioElement blob playback
            }
          }

          // Play via unlocked HTMLAudioElement using a Blob URL
          const blob = new Blob([buf], { type: contentType });
          const blobUrl = URL.createObjectURL(blob);
          playViaHtmlAudio(blobUrl);
        })
        .catch(() => {
          if (sessionId === currentPlaySessionId) {
            speakViaBrowserSynthesis();
          }
        });
    } else {
      speakViaBrowserSynthesis();
    }
  });
}

/**
 * Convert a recorded MediaRecorder Blob (e.g. audio/webm;codecs=opus) into a clean 16kHz 16-bit mono PCM WAV Blob
 * and compute RMS vocal energy so silent clips can be filtered out on the client.
 */
export async function blobToWav16k(
  blob: Blob
): Promise<{ wavBlob: Blob; rms: number; durationSec: number }> {
  try {
    const ctx = getAudioContext();
    if (!ctx) {
      return { wavBlob: blob, rms: 0.05, durationSec: 1.0 };
    }
    const arrayBuf = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
    const durationSec = audioBuffer.duration;
    const targetRate = 16000;
    const numSamples = Math.max(1, Math.floor(durationSec * targetRate));
    const channelData = audioBuffer.getChannelData(0);
    const ratio = channelData.length / numSamples;

    const wavBuffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(wavBuffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    let sumSq = 0;
    for (let i = 0; i < numSamples; i++) {
      const srcIdx = Math.min(channelData.length - 1, Math.floor(i * ratio));
      const sample = Math.max(-1, Math.min(1, channelData[srcIdx] || 0));
      sumSq += sample * sample;
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(44 + i * 2, int16, true);
    }

    const rms = Math.sqrt(sumSq / numSamples);
    const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
    return { wavBlob, rms, durationSec };
  } catch (err) {
    return { wavBlob: blob, rms: 0.05, durationSec: 1.0 };
  }
}

