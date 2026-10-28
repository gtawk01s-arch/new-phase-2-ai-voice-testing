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

  if (activePlaybackAudio) {
    try {
      activePlaybackAudio.onended = null;
      activePlaybackAudio.onerror = null;
      activePlaybackAudio.onpause = null;
      activePlaybackAudio.pause();
      activePlaybackAudio.currentTime = 0;
      activePlaybackAudio.src = '';
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

    // 1. Prime HTML5 Audio element under user gesture
    try {
      const silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
      silentAudio.volume = 0.001;
      silentAudio.play().then(() => {
        silentAudio.pause();
      }).catch(() => {});
    } catch (e) {}

    // 2. Prime Web Speech API Synthesis under user gesture (clean cancel & resume without empty space token)
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.resume();
      } catch (e) {}
    }
  } catch (e) {}
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
        if (activeUtterance) {
          activeUtterancesSet.delete(activeUtterance);
          activeUtterance = null;
        }
        resolve();
      }
    };

    // Dynamic safety timeout based on word count (so agent never hangs if browser audio event is dropped)
    const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
    const safetyDurationMs = Math.max(3500, Math.min(18000, words * 450 + 2000));
    safetyTimeout = setTimeout(complete, safetyDurationMs);

    // Browser Web Speech API synthesis
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

        // Small 60ms delay ensures Chromium background audio thread has finished cancel() teardown
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

            // Ensure synthesis is not paused before dispatching speak
            if (window.speechSynthesis.paused) {
              window.speechSynthesis.resume();
            }

            isSpeechCurrentlySpeaking = true;
            window.speechSynthesis.speak(utterance);
            window.speechSynthesis.resume();

            // Chromium watchdog: if onstart hasn't fired in 250ms, wake up synthesis with resume()
            const watchdog = setTimeout(() => {
              if (sessionId === currentPlaySessionId && !startFired) {
                try {
                  window.speechSynthesis.resume();
                } catch (e) {}
              }
            }, 250);

            // Chromium keepalive: periodically resume so long sentences are not cut off
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

    // If server provided an audio URL:
    if (audioUrl) {
      // 1. Try Web Audio API decode & playback first (immune to Chromium HTML5 autoplay block)
      let webAudioAttempted = false;
      const ctx = getAudioContext();
      if (ctx && (ctx.state === 'running' || ctx.state === 'suspended')) {
        webAudioAttempted = true;
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        fetch(audioUrl)
          .then((res) => {
            if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
            return res.arrayBuffer();
          })
          .then((buf) => ctx.decodeAudioData(buf))
          .then((decoded) => {
            if (sessionId !== currentPlaySessionId) return;
            const source = ctx.createBufferSource();
            source.buffer = decoded;
            source.connect(ctx.destination);
            isSpeechCurrentlySpeaking = true;
            source.onended = () => {
              if (sessionId === currentPlaySessionId) {
                isSpeechCurrentlySpeaking = false;
                complete();
              }
            };
            source.start(0);
          })
          .catch((decodeErr) => {
            if (sessionId === currentPlaySessionId) {
              console.warn('Web Audio buffer playback note, trying HTML5 Audio:', decodeErr?.message);
              playViaHtml5Audio();
            }
          });
      }

      function playViaHtml5Audio() {
        if (sessionId !== currentPlaySessionId) return;
        try {
          const audio = new Audio(audioUrl);
          activePlaybackAudio = audio;

          audio.onplay = () => {
            if (sessionId === currentPlaySessionId) {
              isSpeechCurrentlySpeaking = true;
            }
          };

          audio.onended = () => {
            if (sessionId === currentPlaySessionId) {
              activePlaybackAudio = null;
              isSpeechCurrentlySpeaking = false;
              complete();
            }
          };

          audio.onerror = () => {
            if (sessionId === currentPlaySessionId) {
              console.warn('Audio URL playback failed, falling back to browser speech synthesis');
              activePlaybackAudio = null;
              isSpeechCurrentlySpeaking = false;
              speakViaBrowserSynthesis();
            }
          };

          const playPromise = audio.play();
          if (playPromise !== undefined) {
            playPromise.catch((err) => {
              if (sessionId === currentPlaySessionId) {
                console.warn('Audio play rejection, falling back to browser speech synthesis:', err?.message);
                activePlaybackAudio = null;
                isSpeechCurrentlySpeaking = false;
                speakViaBrowserSynthesis();
              }
            });
          }
        } catch (e) {
          speakViaBrowserSynthesis();
        }
      }

      if (!webAudioAttempted) {
        playViaHtml5Audio();
      }
    } else {
      speakViaBrowserSynthesis();
    }
  });
}
