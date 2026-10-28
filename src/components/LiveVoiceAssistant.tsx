import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  startRingbackTone,
  stopRingbackTone,
  playDtmfTone,
  playCallChime,
  playVoiceAudio,
  stopSpeechAudio,
  getAudioContext,
  unlockAudioContext,
  unlockAudioPlayback,
  resumeAudioAndSpeech,
  isAudioPlaying
} from '../utils/audio';
import { MessageItem } from '../types';
import { generateBrowserVoiceResponse } from '../utils/browserVoiceEngine';

interface LiveVoiceAssistantProps {
  onNavigateToDialer?: () => void;
}

export const LiveVoiceAssistant: React.FC<LiveVoiceAssistantProps> = () => {
  // Call Session State
  const [isInCall, setIsInCall] = useState(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'ringing' | 'in-call' | 'ended'>('idle');
  const [callTimerSecs, setCallTimerSecs] = useState(0);
  const [agentWaveState, setAgentWaveState] = useState<'off' | 'agent-speaking' | 'caller-speaking' | 'thinking'>('off');
  const [subtext, setSubtext] = useState('Real-Time Voice Assistant • Speaks Naturally & Answers Anything');
  const [currentCallId, setCurrentCallId] = useState(`call-${Date.now()}`);

  // In-Call Controls
  const [isHandsfree, setIsHandsfree] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isKeypadOpen, setIsKeypadOpen] = useState(false);
  const [dialedDigits, setDialedDigits] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('en-US-JennyNeural');
  const [bargeInNotice, setBargeInNotice] = useState(false);

  // Audio & Microphone Metering
  const [micLevel, setMicLevel] = useState(0);
  const [micStatusMsg, setMicStatusMsg] = useState('Microphone: Ready (Press Start Voice Call or Speak)');
  const [micStatusColor, setMicStatusColor] = useState('text-slate-400');
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [hasMicAccess, setHasMicAccess] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');

  // Messages & Form
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: 'initial',
      type: 'bot',
      text: "Hello! I'm Alex, your AI voice calling agent. Press \"Start Voice Call\" or ask me anything—I can answer any general questions, help with accounts, or connect you to any department.",
      timestamp: Date.now()
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isStandaloneMode, setIsStandaloneMode] = useState(false);

  // Refs for audio handling and timers
  const timerIntervalRef = useRef<any>(null);
  const isAgentSpeakingRef = useRef(false);
  const isInCallRef = useRef(false);
  const isHandsfreeRef = useRef(true);
  const isMutedRef = useRef(false);
  const isSpeakerOnRef = useRef(true);
  const isStandaloneModeRef = useRef(false);
  const currentCallIdRef = useRef(currentCallId);
  const activeMicStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const isCommittingTurnRef = useRef(false);

  // MediaRecorder & VAD refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const vadSilenceTimeoutRef = useRef<any>(null);
  const isVadRecordingRef = useRef(false);
  const speechRecognitionRef = useRef<any>(null);
  const speechSilenceTimeoutRef = useRef<any>(null);
  const currentRecognizedTextRef = useRef<string>('');
  const agentFinishedSpeakingTimeRef = useRef<number>(0);
  const speechFrameCounterRef = useRef<number>(0);

  // Sync refs with state
  useEffect(() => { isInCallRef.current = isInCall; }, [isInCall]);
  useEffect(() => { isHandsfreeRef.current = isHandsfree; }, [isHandsfree]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { isSpeakerOnRef.current = isSpeakerOn; }, [isSpeakerOn]);
  useEffect(() => { isStandaloneModeRef.current = isStandaloneMode; }, [isStandaloneMode]);
  useEffect(() => { currentCallIdRef.current = currentCallId; }, [currentCallId]);

  // Scroll to bottom of conversation
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, agentWaveState]);

  // Format call timer (MM:SS)
  const formatTimer = (totalSecs: number) => {
    const mins = String(Math.floor(totalSecs / 60)).padStart(2, '0');
    const secs = String(totalSecs % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  };

  // Helper to determine supported audio recording MIME type
  const getSupportedMimeType = () => {
    if (typeof MediaRecorder === 'undefined') return '';
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  };

  // Initialize Microphone MediaStream and Web Audio Analyser
  const initMicrophone = async (showErrorBanner = true): Promise<MediaStream | null> => {
    try {
      if (activeMicStreamRef.current && activeMicStreamRef.current.active) {
        setHasMicAccess(true);
        setErrorMessage(null);
        return activeMicStreamRef.current;
      }

      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia not supported in this browser environment');
      }

      unlockAudioContext();

      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } catch (eBasic) {
        // Fallback to simple audio: true
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      activeMicStreamRef.current = stream;
      setHasMicAccess(true);
      setErrorMessage(null);
      setMicStatusMsg('Microphone: Connected & Ready 🟢');
      setMicStatusColor('text-emerald-400');

      // Hook up Web Audio Analyser for volume level meter & VAD
      try {
        const ctx = getAudioContext();
        if (ctx) {
          audioContextRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.4;
          source.connect(analyser);
          analyserRef.current = analyser;

          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          const updateMeter = () => {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(dataArray);

            // Calculate voice band energy (bins 1 to 24, roughly 80Hz - 3400Hz)
            const voiceBins = Math.min(24, dataArray.length);
            let voiceSum = 0;
            for (let i = 1; i < voiceBins; i++) {
              voiceSum += dataArray[i];
            }
            const voiceAvg = voiceSum / Math.max(1, voiceBins - 1);
            // Map voice amplitude to highly sensitive 0-100% visual meter (32 divisor for conversational volume)
            const voicePct = Math.min(100, Math.round((voiceAvg / 32) * 100));
            setMicLevel(voicePct);

            const now = Date.now();
            const isPlaying = isAgentSpeakingRef.current || isAudioPlaying();
            const isInEchoCooldown = (now - agentFinishedSpeakingTimeRef.current) < 400;

            // Acoustic Barge-In interrupt check:
            // Natural conversational threshold (32%) across 2 frames allows caller to easily interrupt Alex
            if (isPlaying && voicePct >= 32 && !isMutedRef.current && !isInEchoCooldown) {
              speechFrameCounterRef.current = (speechFrameCounterRef.current || 0) + 1;
              if (speechFrameCounterRef.current >= 2) {
                handleBargeIn();
              }
            }

            // Hands-Free VAD (Voice Activity Detection):
            // Web SpeechRecognition provides real-time streaming speech-to-text (< 200ms);
            // MediaRecorder VAD concurrently buffers audio as a fail-safe in case browser speech recognition drops words
            if (
              isInCallRef.current &&
              isHandsfreeRef.current &&
              !isMutedRef.current &&
              !isPlaying &&
              !isCommittingTurnRef.current &&
              !isInEchoCooldown
            ) {
              if (voicePct >= 6) {
                // Speech energy detected in human vocal range: require sustained energy (2 frames)
                speechFrameCounterRef.current = (speechFrameCounterRef.current || 0) + 1;
                if (speechFrameCounterRef.current >= 2 && !isVadRecordingRef.current) {
                  startMediaRecording(false);
                }
                // Reset silence countdown while user is speaking
                if (vadSilenceTimeoutRef.current) {
                  clearTimeout(vadSilenceTimeoutRef.current);
                  vadSilenceTimeoutRef.current = null;
                }
              } else {
                speechFrameCounterRef.current = 0;
                if (isVadRecordingRef.current && voicePct < 4) {
                  // Volume dropped: wait for 420ms silence before endpointing speech
                  if (!vadSilenceTimeoutRef.current) {
                    vadSilenceTimeoutRef.current = setTimeout(() => {
                      vadSilenceTimeoutRef.current = null;
                      stopMediaRecordingAndSend();
                    }, 420);
                  }
                }
              }
            }

            animFrameRef.current = requestAnimationFrame(updateMeter);
          };

          if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
          animFrameRef.current = requestAnimationFrame(updateMeter);
        }
      } catch (audioCtxErr) {
        console.warn('Audio analyser setup note:', audioCtxErr);
      }

      return stream;
    } catch (err: any) {
      console.warn('Microphone initialization error:', err);
      setHasMicAccess(false);

      if (showErrorBanner) {
        const isNotAllowed = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
        const isSecurity = err.name === 'SecurityError' || err.message?.includes('permissions policy');

        const msg = isSecurity
          ? 'Microphone is restricted by the preview iframe permissions policy. You can open the app in a direct tab or chat using the text box below.'
          : isNotAllowed
          ? 'Microphone permission was denied by the browser. Please allow microphone access or open in a direct tab.'
          : `Microphone unavailable (${err.name || 'Error'}). You can chat anytime below.`;

        setErrorMessage(msg);
      }

      setMicStatusMsg('Microphone: Access not granted • Text chat available');
      setMicStatusColor('text-amber-400');
      return null;
    }
  };

  // Passive check on mount without showing intrusive error
  useEffect(() => {
    if (typeof navigator !== 'undefined' && (navigator as any).permissions?.query) {
      (navigator as any).permissions
        .query({ name: 'microphone' as PermissionName })
        .then((perm: any) => {
          if (perm.state === 'granted') {
            initMicrophone(false).catch(() => {});
          }
          perm.onchange = () => {
            if (perm.state === 'granted') {
              setErrorMessage(null);
              initMicrophone(false).catch(() => {});
            }
          };
        })
        .catch(() => {});
    }

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (vadSilenceTimeoutRef.current) clearTimeout(vadSilenceTimeoutRef.current);
      stopSpeechAudio();
    };
  }, []);

  // Barge-In interrupt
  const handleBargeIn = () => {
    if (!isAgentSpeakingRef.current) return;
    console.log('🚨 Barge-in: Caller interrupted agent speech');
    isAgentSpeakingRef.current = false;
    stopSpeechAudio();
    setAgentWaveState('caller-speaking');
    setBargeInNotice(true);
    setTimeout(() => setBargeInNotice(false), 2000);

    fetch('/api/webhook/barge-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_id: currentCallIdRef.current })
    }).catch(() => {});
  };

  // Handle speech turn locally in browser (for static hosts like Netlify)
  const handleStandaloneUserTurn = async (userText: string) => {
    if (isAgentSpeakingRef.current || isCommittingTurnRef.current) return;
    const clean = userText.trim();
    if (!clean) return;

    if (speechSilenceTimeoutRef.current) {
      clearTimeout(speechSilenceTimeoutRef.current);
      speechSilenceTimeoutRef.current = null;
    }
    currentRecognizedTextRef.current = '';
    setInterimTranscript('');

    isCommittingTurnRef.current = true;
    setIsSending(true);

    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.abort();
      } catch (e) {}
    }

    if (!isInCallRef.current) {
      setIsInCall(true);
      setCallStatus('in-call');
      setSubtext('Active Call • Browser Voice Engine (Netlify Static Host)');
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = setInterval(() => {
        setCallTimerSecs((prev) => prev + 1);
      }, 1000);
    }

    // Add user message to conversation
    const userMsg: MessageItem = {
      id: `user-${Date.now()}`,
      type: 'user',
      text: clean,
      timestamp: Date.now()
    };
    setMessages((prev) => [...prev, userMsg]);

    setAgentWaveState('thinking');
    setSubtext(`Alex is responding to: "${clean}"`);

    // Generate intelligent conversational answer in browser
    const engineRes = await generateBrowserVoiceResponse(clean);

    const botMsg: MessageItem = {
      id: `bot-${Date.now()}`,
      type: 'bot',
      text: engineRes.response,
      audioUrl: null,
      timestamp: Date.now()
    };

    setMessages((prev) => {
      const next = [...prev, botMsg];
      if (engineRes.action === 'transfer' && engineRes.transfer) {
        next.push({
          id: `transfer-${Date.now()}`,
          type: 'transfer',
          text: `Call transferred to ${engineRes.transfer.name} (Ext ${engineRes.transfer.extension})`,
          transfer: engineRes.transfer,
          timestamp: Date.now()
        });
      }
      return next;
    });

    isCommittingTurnRef.current = false;
    setIsSending(false);

    // Speak response aloud via SpeechSynthesis
    isAgentSpeakingRef.current = true;
    setAgentWaveState('agent-speaking');
    setSubtext(`Alex: "${engineRes.response}"`);
    setMicStatusMsg('🔊 Alex is speaking...');
    setMicStatusColor('text-sky-400');

    await playVoiceAudio(engineRes.response, null, selectedVoice, isSpeakerOnRef.current);

    agentFinishedSpeakingTimeRef.current = Date.now();
    isAgentSpeakingRef.current = false;
    setAgentWaveState('off');
    setSubtext('Active Live Call • Alex is listening...');
    setMicStatusMsg('Microphone: Listening for your voice... 🟢');
    setMicStatusColor('text-emerald-400');

    if (engineRes.action === 'hangup') {
      setTimeout(() => {
        endVoiceCall('Call completed');
      }, 1500);
      return;
    }

    isCommittingTurnRef.current = false;

    // Resume listening after delay to avoid acoustic feedback
    setTimeout(() => {
      if (isInCallRef.current && isStandaloneModeRef.current && !isAgentSpeakingRef.current && !isCommittingTurnRef.current) {
        try {
          speechRecognitionRef.current?.start();
        } catch (e) {}
      }
    }, 450);
  };

  // Start browser Web Speech Recognition for standalone static hosting
  const startBrowserSpeechRecognition = useCallback(() => {
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      console.warn('Browser SpeechRecognition not supported in this browser.');
      setMicStatusMsg('Microphone: Browser speech recognition not supported. You can chat below.');
      setMicStatusColor('text-amber-400');
      return;
    }

    try {
      if (speechRecognitionRef.current) {
        try {
          speechRecognitionRef.current.abort();
        } catch (e) {}
      }

      const isHindi = selectedVoice?.toLowerCase().includes('hi') || selectedVoice?.toLowerCase().includes('swara') || selectedVoice?.toLowerCase().includes('aarav');
      const recognition = new SpeechRec();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = isHindi ? 'hi-IN' : 'en-US';

      recognition.onstart = () => {
        console.log('🎙️ Browser speech recognition active');
        setMicStatusMsg('Microphone: Active & Listening 🟢');
        setMicStatusColor('text-emerald-400');
      };

      recognition.onresult = (event: any) => {
        if (isCommittingTurnRef.current) return;

        let interim = '';
        let final = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const item = event.results[i];
          if (item.isFinal) {
            final += item[0].transcript;
          } else {
            interim += item[0].transcript;
          }
        }

        const candidateText = (final || interim).trim();

        if (candidateText) {
          // If agent is speaking, the caller is interrupting Alex (barge-in!)
          if (isAgentSpeakingRef.current) {
            console.log('🚨 Barge-in: caller voice recognized while agent speaking');
            stopSpeechAudio();
            isAgentSpeakingRef.current = false;
            setBargeInNotice(true);
            setTimeout(() => setBargeInNotice(false), 2000);
          }

          currentRecognizedTextRef.current = candidateText;
          setInterimTranscript(candidateText);
          setAgentWaveState('caller-speaking');
          setSubtext(`Heard: "${candidateText}"`);
          setMicStatusMsg(`🎙️ Hearing you: "${candidateText}"`);
          setMicStatusColor('text-emerald-400');

          // Reset silence timeout whenever user continues speaking
          if (speechSilenceTimeoutRef.current) {
            clearTimeout(speechSilenceTimeoutRef.current);
            speechSilenceTimeoutRef.current = null;
          }

          // When speech recognition yields words, commit after user finishes speaking:
          // 200ms on final transcript, 520ms on natural pause in interim transcript
          const delayMs = final ? 200 : 520;

          speechSilenceTimeoutRef.current = setTimeout(() => {
            const textToSend = currentRecognizedTextRef.current.trim();
            if (textToSend && !isCommittingTurnRef.current) {
              console.log('🚀 Sending voice transcript to AI:', textToSend);
              isCommittingTurnRef.current = true;
              currentRecognizedTextRef.current = '';
              setInterimTranscript('');

              try { recognition.abort(); } catch (e) {}

              // Prevent MediaRecorder from uploading redundant audio blob
              if (vadSilenceTimeoutRef.current) {
                clearTimeout(vadSilenceTimeoutRef.current);
                vadSilenceTimeoutRef.current = null;
              }
              if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                try { mediaRecorderRef.current.stop(); } catch (e) {}
              }

              if (isStandaloneModeRef.current) {
                handleStandaloneUserTurn(textToSend);
              } else {
                commitUserTurn(textToSend);
              }
            }
          }, delayMs);
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'no-speech') {
          // Normal silence, ignore
          return;
        }
        console.warn('Browser speech recognition event:', event.error);
        if (event.error === 'not-allowed') {
          setErrorMessage('Microphone access was denied. Please allow microphone in browser site settings.');
        }
      };

      recognition.onend = () => {
        // If there was uncommitted speech in the buffer when recognition ended, commit it now!
        const pending = currentRecognizedTextRef.current.trim();
        if (pending && !isAgentSpeakingRef.current && !isCommittingTurnRef.current) {
          isCommittingTurnRef.current = true;
          currentRecognizedTextRef.current = '';
          setInterimTranscript('');
          if (speechSilenceTimeoutRef.current) {
            clearTimeout(speechSilenceTimeoutRef.current);
            speechSilenceTimeoutRef.current = null;
          }
          if (isStandaloneModeRef.current) {
            handleStandaloneUserTurn(pending);
          } else {
            commitUserTurn(pending);
          }
        } else if (isInCallRef.current && !isAgentSpeakingRef.current && !isCommittingTurnRef.current) {
          setTimeout(() => {
            if (isInCallRef.current && !isAgentSpeakingRef.current && !isCommittingTurnRef.current) {
              startBrowserSpeechRecognition();
            }
          }, 100);
        }
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
    } catch (err) {
      console.warn('Failed to start SpeechRecognition:', err);
    }
  }, [selectedVoice]);

  // Start MediaRecorder audio capture from active mic stream
  const startMediaRecording = (isManualPtt = false) => {
    const stream = activeMicStreamRef.current;
    if (!stream || !stream.active) {
      console.warn('Cannot record: active mic stream is missing');
      return;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      return;
    }

    try {
      audioChunksRef.current = [];
      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType } : undefined;
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const chunks = audioChunksRef.current;
        const durationMs = Date.now() - recordingStartTimeRef.current;
        isVadRecordingRef.current = false;
        setIsRecordingAudio(false);

        // If SpeechRecognition is already capturing or handling the text, skip duplicate audio blob upload!
        if (currentRecognizedTextRef.current.trim().length > 0 || isCommittingTurnRef.current) {
          return;
        }

        // Discard very short accidental clicks (< 400ms) unless manual PTT
        if (chunks.length > 0 && (durationMs > 450 || isManualPtt)) {
          const recordedBlob = new Blob(chunks, { type: mimeType || 'audio/webm' });
          sendAudioTurn(recordedBlob);
        } else {
          setAgentWaveState('off');
          setMicStatusMsg('Microphone: Listening for your voice... 🟢');
          setMicStatusColor('text-emerald-400');
        }
      };

      recordingStartTimeRef.current = Date.now();
      isVadRecordingRef.current = true;
      setIsRecordingAudio(true);
      setAgentWaveState('caller-speaking');
      setMicStatusMsg(isManualPtt ? '🔴 Recording your speech... Speak now!' : '🎙️ Listening to you speak...');
      setMicStatusColor('text-rose-400');

      recorder.start(100); // 100ms chunk intervals
    } catch (err) {
      console.warn('MediaRecorder start error:', err);
      isVadRecordingRef.current = false;
      setIsRecordingAudio(false);
    }
  };

  // Stop MediaRecorder and transmit audio to backend
  const stopMediaRecordingAndSend = () => {
    if (vadSilenceTimeoutRef.current) {
      clearTimeout(vadSilenceTimeoutRef.current);
      vadSilenceTimeoutRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {}
    }
  };

  // Send recorded audio Blob to backend Gemini ASR and TTS pipeline
  const sendAudioTurn = async (audioBlob: Blob) => {
    if (isAgentSpeakingRef.current || isCommittingTurnRef.current) return;
    isCommittingTurnRef.current = true;
    setIsSending(true);

    if (!isInCallRef.current) {
      setIsInCall(true);
      setCallStatus('in-call');
      setSubtext('Active Live Phone Call • High Fidelity Audio');
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = setInterval(() => {
        setCallTimerSecs((prev) => prev + 1);
      }, 1000);
    }

    setAgentWaveState('thinking');
    setSubtext('Alex is listening & thinking... 💭');
    setMicStatusMsg('⏳ Transcribing audio speech with Gemini ASR...');
    setMicStatusColor('text-amber-400');

    // Failsafe auto-reset timeout so UI NEVER hangs
    const safetyTimeout = setTimeout(() => {
      isCommittingTurnRef.current = false;
      setIsSending(false);
    }, 12000);

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      formData.append('call_id', currentCallIdRef.current);
      formData.append('voice', selectedVoice);

      const response = await fetch('/api/dialer/call/interact', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const data = await response.json();

      // If no response was generated at all, quietly continue listening
      if (!data.response || !data.response.trim()) {
        setAgentWaveState('off');
        setSubtext('Active Live Call • Alex is listening...');
        setMicStatusMsg('Microphone: Listening for your voice... 🟢');
        setMicStatusColor('text-emerald-400');
        return;
      }

      // Show user transcription if captured
      if (data.transcription && data.transcription.trim()) {
        const userMsg: MessageItem = {
          id: `user-${Date.now()}`,
          type: 'user',
          text: data.transcription.trim(),
          timestamp: Date.now()
        };
        setMessages((prev) => [...prev, userMsg]);
        setSubtext(`Heard: "${data.transcription.trim()}"`);
      }

      // Add Alex bot response
      const botMsg: MessageItem = {
        id: `bot-${Date.now()}`,
        type: 'bot',
        text: data.response,
        audioUrl: data.audio_url,
        timestamp: Date.now()
      };

      setMessages((prev) => {
        const next = [...prev, botMsg];
        if (data.action === 'transfer' && data.transfer) {
          next.push({
            id: `transfer-${Date.now()}`,
            type: 'transfer',
            text: `Call transferred to ${data.transfer.name} (Ext ${data.transfer.extension})`,
            transfer: data.transfer,
            timestamp: Date.now()
          });
        }
        return next;
      });

      // Speak response aloud
      isAgentSpeakingRef.current = true;
      setAgentWaveState('agent-speaking');
      setSubtext(`Alex: "${data.response}"`);
      setMicStatusMsg('🔊 Alex is speaking...');
      setMicStatusColor('text-sky-400');

      await playVoiceAudio(data.response, data.audio_url, selectedVoice, isSpeakerOnRef.current);

      agentFinishedSpeakingTimeRef.current = Date.now();
      isAgentSpeakingRef.current = false;
      isCommittingTurnRef.current = false;
      setAgentWaveState('off');
      setSubtext('Active Live Call • Alex is listening...');
      setMicStatusMsg('Microphone: Listening for your voice... 🟢');
      setMicStatusColor('text-emerald-400');
      if (data.action === 'hangup' || data.call_status === 'completed') {
        endVoiceCall('Call completed');
        return;
      }

      // Resume listening for next caller turn
      setTimeout(() => {
        if (isInCallRef.current && !isAgentSpeakingRef.current && !isCommittingTurnRef.current) {
          startBrowserSpeechRecognition();
        }
      }, 250);
    } catch (err: any) {
      console.warn('Audio turn backend unreachable (Netlify static deployment):', err);
      setIsStandaloneMode(true);
      startBrowserSpeechRecognition();
      setSubtext('Active Live Call • Speak anytime (Browser Voice Engine active)');
      setMicStatusMsg('Microphone: Web Speech Recognition Active 🟢');
      setMicStatusColor('text-emerald-400');
    } finally {
      clearTimeout(safetyTimeout);
      isCommittingTurnRef.current = false;
      setIsSending(false);
    }
  };

  // Commit text turn to backend engine (or fallback to browser engine)
  const commitUserTurn = async (userText: string) => {
    const clean = userText.trim();
    if (!clean) return;

    setInterimTranscript('');
    unlockAudioContext();

    if (isAgentSpeakingRef.current) {
      stopSpeechAudio();
      isAgentSpeakingRef.current = false;
    }

    isCommittingTurnRef.current = true;
    setIsSending(true);

    if (!isInCallRef.current) {
      setIsInCall(true);
      setCallStatus('in-call');
      setSubtext('Active Live Call • Alex is responding...');
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = setInterval(() => {
        setCallTimerSecs((prev) => prev + 1);
      }, 1000);
    }

    setAgentWaveState('thinking');
    setSubtext(`Alex is thinking: "${clean}"`);

    // Add user message
    const userMsg: MessageItem = {
      id: `user-${Date.now()}`,
      type: 'user',
      text: clean,
      timestamp: Date.now()
    };
    setMessages((prev) => [...prev, userMsg]);

    const safetyTimeout = setTimeout(() => {
      isCommittingTurnRef.current = false;
      setIsSending(false);
      setAgentWaveState('off');
    }, 12000);

    try {
      const response = await fetch('/api/dialer/call/interact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: clean,
          call_id: currentCallIdRef.current,
          voice: selectedVoice
        })
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const data = await response.json();
      setIsStandaloneMode(false);

      const botMsg: MessageItem = {
        id: `bot-${Date.now()}`,
        type: 'bot',
        text: data.response,
        audioUrl: data.audio_url,
        timestamp: Date.now()
      };

      setMessages((prev) => {
        const next = [...prev, botMsg];
        if (data.action === 'transfer' && data.transfer) {
          next.push({
            id: `transfer-${Date.now()}`,
            type: 'transfer',
            text: `Call transferred to ${data.transfer.name} (Ext ${data.transfer.extension})`,
            transfer: data.transfer,
            timestamp: Date.now()
          });
        }
        return next;
      });

      // Play audio response
      isAgentSpeakingRef.current = true;
      setAgentWaveState('agent-speaking');
      setSubtext(`Alex: "${data.response}"`);

      await playVoiceAudio(data.response, data.audio_url, selectedVoice, isSpeakerOnRef.current);

      agentFinishedSpeakingTimeRef.current = Date.now();
      isAgentSpeakingRef.current = false;
      isCommittingTurnRef.current = false;
      setAgentWaveState('off');
      setSubtext('Active Live Call • Alex is listening...');
      setMicStatusMsg('Microphone: Listening for your voice... 🟢');
      setMicStatusColor('text-emerald-400');

      if (data.action === 'hangup' || data.call_status === 'completed') {
        endVoiceCall('Call completed');
        return;
      }

      // Resume listening for next caller turn
      setTimeout(() => {
        if (isInCallRef.current && !isAgentSpeakingRef.current && !isCommittingTurnRef.current) {
          startBrowserSpeechRecognition();
        }
      }, 250);
    } catch (err: any) {
      console.warn('Backend turn error, answering via browser engine:', err);
      setIsStandaloneMode(true);
      const engineRes = await generateBrowserVoiceResponse(clean);
      const botMsg: MessageItem = {
        id: `bot-${Date.now()}`,
        type: 'bot',
        text: engineRes.response,
        audioUrl: null,
        timestamp: Date.now()
      };
      setMessages((prev) => [...prev, botMsg]);

      isAgentSpeakingRef.current = true;
      setAgentWaveState('agent-speaking');
      setSubtext(`Alex: "${engineRes.response}"`);

      await playVoiceAudio(engineRes.response, null, selectedVoice, isSpeakerOnRef.current);
      agentFinishedSpeakingTimeRef.current = Date.now();
      isAgentSpeakingRef.current = false;
      setAgentWaveState('off');
      setSubtext('Active Live Call • Alex is listening...');

      setTimeout(() => {
        if (isInCallRef.current && !isAgentSpeakingRef.current) {
          try {
            speechRecognitionRef.current?.start();
          } catch (e) {}
        }
      }, 450);
    } finally {
      clearTimeout(safetyTimeout);
      isCommittingTurnRef.current = false;
      setIsSending(false);
    }
  };

  // Toggle Voice Call (Start / Hang up)
  const toggleVoiceCall = async () => {
    if (!isInCall) {
      unlockAudioPlayback();
      await startVoiceCall();
    } else {
      endVoiceCall('Caller hung up');
    }
  };

  const startVoiceCall = async () => {
    // 1. Prime audio context and speech synthesis synchronously under the user click gesture
    unlockAudioPlayback();

    try {
      setErrorMessage(null);

      // 2. Ringing state starts immediately for authentic phone dial experience
      setCallStatus('ringing');
      setSubtext('Calling Alex... (Ringing)');
      startRingbackTone();

      const newCallId = `call-${Date.now()}`;
      setCurrentCallId(newCallId);

      // 3. Concurrently initialize microphone and fetch backend call setup during ring
      const micPromise = initMicrophone(true).catch(() => null);
      const ringDelayPromise = new Promise((resolve) => setTimeout(resolve, 600));

      let data: any = {
        greeting: "Hello! I'm Alex, your AI voice assistant. What can I help you with today?",
        audio_url: null
      };
      let isBackendOnline = false;

      const networkPromise = fetch('/api/dialer/call/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          call_id: newCallId,
          direction: 'inbound',
          voice: selectedVoice
        })
      })
        .then(async (res) => {
          if (res.ok) {
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
              const json = await res.json();
              if (json && json.greeting) {
                data = json;
                isBackendOnline = true;
              }
            }
          }
        })
        .catch((backendErr) => {
          console.info('Backend unavailable. Operating in Browser Voice Mode:', backendErr);
        });

      // Wait for ring delay, network setup, and mic stream in parallel
      const [stream] = await Promise.all([micPromise, networkPromise, ringDelayPromise]);

      setIsStandaloneMode(!isBackendOnline);
      stopRingbackTone();
      playCallChime(true);

      // 4. Connected!
      setIsInCall(true);
      setCallStatus('in-call');
      setSubtext(
        !isBackendOnline
          ? 'Active Call • Browser Voice Engine'
          : stream
          ? 'Active Live Phone Call • High Fidelity Audio'
          : 'Active Live Call • Speak or type below (Alex speaks back aloud)'
      );

      if (stream) {
        setMicStatusMsg(
          !isBackendOnline
            ? 'Microphone: Browser Voice Recognition Active 🟢'
            : 'Microphone: Active & Streaming 🟢'
        );
        setMicStatusColor('text-emerald-400');
      } else {
        setMicStatusMsg('Microphone: Optional • Speak or type below');
        setMicStatusColor('text-sky-400');
      }

      // Start Call Timer
      setCallTimerSecs(0);
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = setInterval(() => {
        setCallTimerSecs((prev) => prev + 1);
      }, 1000);

      const greetingText = data.greeting || "Hello! I'm Alex, your AI voice assistant. What can I help you with today?";
      const greetingMsg: MessageItem = {
        id: `greeting-${Date.now()}`,
        type: 'bot',
        text: greetingText,
        audioUrl: data.audio_url,
        timestamp: Date.now()
      };
      setMessages((prev) => [...prev, greetingMsg]);

      // 5. Start browser speech recognition IMMEDIATELY for seamless hands-free telephone dialogue
      startBrowserSpeechRecognition();

      // 6. Play greeting aloud automatically (Chrome-unlocked)
      isAgentSpeakingRef.current = true;
      setAgentWaveState('agent-speaking');
      setSubtext(`Alex: "${greetingText}"`);
      setMicStatusMsg('🔊 Alex is speaking...');
      setMicStatusColor('text-sky-400');

      playVoiceAudio(greetingText, data.audio_url, selectedVoice, isSpeakerOnRef.current).then(() => {
        if (!isCommittingTurnRef.current) {
          agentFinishedSpeakingTimeRef.current = Date.now();
          isAgentSpeakingRef.current = false;
          setAgentWaveState('off');
          setSubtext('Active Live Call • Alex is listening...');
          setMicStatusMsg('Microphone: Listening for your voice... 🟢');
          setMicStatusColor('text-emerald-400');
        }
      });
    } catch (err: any) {
      console.error('Call connection error:', err);
      stopRingbackTone();
      setErrorMessage('Could not connect call. Please check your connection and try again.');
      endVoiceCall('Connection failed');
    }
  };

  const endVoiceCall = (reason = 'Caller ended the call') => {
    setIsInCall(false);
    setCallStatus('ended');
    stopRingbackTone();
    stopSpeechAudio();
    stopMediaRecordingAndSend();
    playCallChime(false);
    clearInterval(timerIntervalRef.current);

    if (speechSilenceTimeoutRef.current) {
      clearTimeout(speechSilenceTimeoutRef.current);
      speechSilenceTimeoutRef.current = null;
    }
    currentRecognizedTextRef.current = '';

    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.abort();
      } catch (e) {}
      speechRecognitionRef.current = null;
    }

    isAgentSpeakingRef.current = false;
    setAgentWaveState('off');
    setMicLevel(0);
    setMicStatusMsg('Microphone: Standby (Press Start Voice Call)');
    setMicStatusColor('text-slate-400');
    setSubtext('Call disconnected. Press "Start Voice Call" to reconnect.');

    // Notify backend
    fetch('/api/dialer/call/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_id: currentCallIdRef.current, disposition: reason })
    }).catch(() => {});

    // Add summary message
    const summaryMsg: MessageItem = {
      id: `summary-${Date.now()}`,
      type: 'summary',
      text: `Call Summary: ${formatTimer(callTimerSecs)}`,
      summaryData: {
        duration: callTimerSecs,
        callId: currentCallIdRef.current
      },
      timestamp: Date.now()
    };
    setMessages((prev) => [...prev, summaryMsg]);
  };

  // Toggle Hands-Free VAD
  const toggleHandsfree = () => {
    const nextVal = !isHandsfree;
    setIsHandsfree(nextVal);
  };

  // Toggle Mute
  const toggleMute = () => {
    const nextVal = !isMuted;
    setIsMuted(nextVal);
    if (nextVal) {
      stopMediaRecordingAndSend();
      setMicStatusMsg('Microphone Muted 🔇');
      setMicStatusColor('text-rose-400');
    } else {
      setMicStatusMsg('Microphone: Active & Streaming 🟢');
      setMicStatusColor('text-emerald-400');
    }
  };

  // Toggle Speaker
  const toggleSpeaker = () => {
    const nextVal = !isSpeakerOn;
    setIsSpeakerOn(nextVal);
    if (!nextVal) {
      stopSpeechAudio();
    }
  };

  // DTMF keypad actions
  const pressDtmf = (key: string) => {
    playDtmfTone(key);
    setDialedDigits((prev) => prev + key);
  };

  const clearDialpad = () => {
    setDialedDigits('');
  };

  const routeDialedDtmf = async () => {
    if (!dialedDigits) return;
    const digits = dialedDigits;
    clearDialpad();
    setIsKeypadOpen(false);
    await commitUserTurn(`Dialed extension ${digits}`);
  };

  // Tap or Hold to Speak action
  const handleToggleRecord = async () => {
    unlockAudioContext();

    if (!isInCall) {
      await startVoiceCall();
      return;
    }

    // If agent is speaking, immediately interrupt agent so user can talk
    if (isAgentSpeakingRef.current || isAudioPlaying()) {
      stopSpeechAudio();
      isAgentSpeakingRef.current = false;
      setAgentWaveState('off');
    }

    if (!activeMicStreamRef.current || !activeMicStreamRef.current.active) {
      const s = await initMicrophone(true);
      if (!s) return;
    }

    const pending = currentRecognizedTextRef.current.trim();
    if (pending) {
      currentRecognizedTextRef.current = '';
      if (speechSilenceTimeoutRef.current) {
        clearTimeout(speechSilenceTimeoutRef.current);
        speechSilenceTimeoutRef.current = null;
      }
      if (isStandaloneModeRef.current) {
        handleStandaloneUserTurn(pending);
      } else {
        commitUserTurn(pending);
      }
      return;
    }

    if (!isRecordingAudio) {
      // Start recording
      startMediaRecording(true);
    } else {
      // Stop and send audio
      stopMediaRecordingAndSend();
    }
  };

  // Reset conversation
  const resetConversation = async () => {
    stopSpeechAudio();
    stopMediaRecordingAndSend();
    if (isInCall) {
      endVoiceCall('Conversation reset');
    }
    const newId = `call-${Date.now()}`;
    setCurrentCallId(newId);
    await fetch(`/api/reset/${newId}`, { method: 'POST' }).catch(() => {});
    setMessages([
      {
        id: 'initial-reset',
        type: 'bot',
        text: "Hello! I'm Alex, your AI voice calling agent. Press \"Start Voice Call\" or ask me anything—I can answer any general questions, help with accounts, or connect you to any department.",
        timestamp: Date.now()
      }
    ]);
    setErrorMessage(null);
    setInputText('');
  };

  // Handle text input submission
  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = inputText.trim();
    if (!clean || isSending) return;
    setInputText('');
    commitUserTurn(clean);
  };

  // Quick Prompt Chips
  const quickPrompts = [
    { label: '🌏 Capital of Australia', query: 'What is the capital of Australia, and what is interesting about it?' },
    { label: '✈️ How airplanes fly', query: 'Can you explain how airplanes stay up in the sky in simple terms?' },
    { label: '🧮 Tip calculation', query: 'What is a fifteen percent tip on eighty-four dollars?' },
    { label: '💰 Connect to Billing', query: 'Can you connect me to billing and payments department?' },
    { label: '🕒 Business Hours', query: 'What are your business hours this week?' }
  ];

  return (
    <div className="space-y-6">
      {/* Main Phone Call Stage Card */}
      <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-850 to-slate-800 rounded-2xl p-6 sm:p-7 text-white shadow-2xl border border-white/10">
        <div className="absolute -top-12 -right-12 w-44 h-44 bg-blue-500/15 rounded-full blur-2xl pointer-events-none" />

        {/* Top Status Row */}
        <div className="flex justify-between items-center mb-5 flex-wrap gap-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <div
              className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-bold border transition-colors ${
                callStatus === 'in-call'
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                  : callStatus === 'ringing'
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 animate-pulse'
                  : 'bg-white/10 text-slate-300 border-white/15'
              }`}
            >
              <span>
                {callStatus === 'in-call' ? '🟢' : callStatus === 'ringing' ? '🟡' : '⚪'}
              </span>
              <span>
                {callStatus === 'in-call'
                  ? 'In Call with Alex'
                  : callStatus === 'ringing'
                  ? 'Calling Alex...'
                  : callStatus === 'ended'
                  ? 'Call Ended'
                  : 'Ready to Call'}
              </span>
            </div>

            {isStandaloneMode && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/30">
                🌐 Browser Voice Engine
              </span>
            )}
          </div>

          <div className="font-mono font-bold text-base text-slate-400">
            {formatTimer(callTimerSecs)}
          </div>
        </div>

        {isStandaloneMode && (
          <div className="mb-4 px-3.5 py-2 rounded-xl bg-sky-950/40 border border-sky-500/30 text-xs text-sky-200 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm">🌐</span>
              <span>
                <strong>Static Host Active (Netlify):</strong> Alex is running using browser Web Speech & voice synthesis.
              </span>
            </div>
            <span className="text-[11px] text-sky-400/80 hidden sm:inline">Web Speech API</span>
          </div>
        )}

        {/* Agent Avatar Row */}
        <div className="flex flex-col items-center text-center mb-4">
          <div
            className={`relative w-20 h-20 sm:w-22 sm:h-22 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-3xl sm:text-4xl shadow-lg mb-3 transition-all duration-300 ${
              agentWaveState === 'agent-speaking'
                ? 'scale-105 shadow-[0_0_35px_rgba(99,102,241,0.7)] animate-pulse'
                : agentWaveState === 'caller-speaking'
                ? 'scale-105 shadow-[0_0_35px_rgba(16,185,129,0.7)]'
                : ''
            }`}
          >
            <span>🤖</span>
          </div>
          <div className="text-xl font-extrabold text-white flex items-center gap-2">
            Alex <span className="text-sky-400 text-sm font-semibold">✓ AI Phone Agent</span>
          </div>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">{subtext}</p>
        </div>

        {/* Soundwave Visualizer */}
        <div className="flex items-center justify-center gap-1.5 h-10 my-3">
          {[4, 8, 12, 16, 22, 28, 24, 18, 14, 10, 6, 4].map((h, i) => {
            const isActive = agentWaveState !== 'off';
            const barBg =
              agentWaveState === 'agent-speaking'
                ? 'bg-sky-400'
                : agentWaveState === 'caller-speaking'
                ? 'bg-emerald-400'
                : agentWaveState === 'thinking'
                ? 'bg-amber-400'
                : 'bg-blue-400/50';

            return (
              <div
                key={i}
                className={`w-1 rounded-full transition-all duration-150 ${barBg}`}
                style={{
                  height: isActive ? `${Math.max(6, Math.min(32, h * (isActive ? 1.2 : 0.4)))}px` : '6px',
                  opacity: isActive ? 1 : 0.4
                }}
              />
            );
          })}
        </div>

        {/* Real-time Microphone Input Level Meter */}
        <div className="w-full max-w-md mx-auto my-2 bg-slate-900/80 border border-white/10 rounded-xl p-3 flex flex-col gap-1.5">
          <div className="flex justify-between items-center text-xs text-slate-400">
            <span className={`flex items-center gap-1.5 font-semibold ${micStatusColor}`}>
              <span>🎤</span>
              <span>{micStatusMsg}</span>
            </span>
            {!hasMicAccess && (
              <button
                type="button"
                onClick={() => initMicrophone(true)}
                className="text-[11px] bg-blue-600 hover:bg-blue-500 text-white font-bold px-2 py-0.5 rounded cursor-pointer transition-all"
              >
                Enable Mic
              </button>
            )}
            {isInCall && (
              <button
                type="button"
                onClick={() => {
                  unlockAudioPlayback();
                  resumeAudioAndSpeech();
                }}
                className="text-[11px] bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-0.5 rounded cursor-pointer transition-all flex items-center gap-1 border border-white/10"
                title="Tap to verify audio is unmuted in Chrome"
              >
                <span>🔊</span>
                <span>Unmute Audio</span>
              </button>
            )}
            {bargeInNotice && (
              <span className="bg-sky-500/20 border border-sky-400 text-sky-300 text-[10px] px-2 py-0.5 rounded uppercase font-bold animate-pulse">
                Barge-In Ready
              </span>
            )}
          </div>
          <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden relative">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500 rounded-full transition-all duration-75"
              style={{ width: `${micLevel}%` }}
            />
          </div>
        </div>

        {/* Primary In-Call Action Row */}
        <div className="flex items-center justify-center gap-3 sm:gap-4 flex-wrap mt-3">
          {/* Main Call / Hangup Button */}
          <button
            type="button"
            onClick={toggleVoiceCall}
            className={`py-3.5 px-6 sm:px-7 rounded-full text-base font-extrabold cursor-pointer flex items-center gap-2.5 transition-all shadow-lg ${
              isInCall
                ? 'bg-rose-500 hover:bg-rose-600 text-white hover:scale-105 shadow-rose-500/30'
                : 'bg-emerald-500 hover:bg-emerald-600 text-white hover:scale-105 shadow-emerald-500/30'
            }`}
          >
            <span>{isInCall ? '🔴' : '📞'}</span>
            <span>{isInCall ? 'End Call' : 'Start Voice Call'}</span>
          </button>

          {/* Dedicated Tap to Speak Button */}
          <button
            type="button"
            onClick={handleToggleRecord}
            className={`py-3.5 px-5 sm:px-6 rounded-full text-base font-extrabold cursor-pointer flex items-center gap-2.5 transition-all shadow-lg ${
              isRecordingAudio
                ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse shadow-[0_0_25px_rgba(225,29,72,0.8)] ring-4 ring-rose-400/40'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white hover:scale-105 shadow-indigo-600/30'
            }`}
            title={isRecordingAudio ? 'Recording audio... Click to send speech to Alex' : 'Tap to Speak into Microphone'}
          >
            <span>{isRecordingAudio ? '⏹️' : '🎙️'}</span>
            <span>{isRecordingAudio ? 'Stop & Send' : 'Tap to Speak'}</span>
          </button>

          {/* Barge-In Interrupt Button when Alex is speaking */}
          {(agentWaveState === 'agent-speaking' || isAgentSpeakingRef.current) && (
            <button
              type="button"
              onClick={handleBargeIn}
              className="py-3.5 px-5 sm:px-6 rounded-full text-base font-extrabold cursor-pointer flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-950 transition-all shadow-lg animate-pulse"
              title="Interrupt Alex and speak"
            >
              <span>✋</span>
              <span>Interrupt Alex</span>
            </button>
          )}

          {/* Hands-Free Mic Toggle */}
          <button
            type="button"
            onClick={toggleHandsfree}
            title={isHandsfree ? 'Hands-Free VAD Active' : 'Hands-Free Off'}
            className={`w-11 h-11 rounded-full border flex items-center justify-center text-lg cursor-pointer transition-all ${
              isHandsfree
                ? 'bg-blue-600 border-blue-400 text-white'
                : 'bg-white/10 border-white/20 text-slate-300 hover:bg-white/20'
            }`}
          >
            🎙️
          </button>

          {/* Mute Mic */}
          <button
            type="button"
            onClick={toggleMute}
            title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
            className={`w-11 h-11 rounded-full border flex items-center justify-center text-lg cursor-pointer transition-all ${
              isMuted
                ? 'bg-rose-600 border-rose-400 text-white'
                : 'bg-white/10 border-white/20 text-slate-300 hover:bg-white/20'
            }`}
          >
            {isMuted ? '🔇' : '🎤'}
          </button>

          {/* Speaker Toggle */}
          <button
            type="button"
            onClick={toggleSpeaker}
            title={isSpeakerOn ? 'Speaker On (Audio enabled)' : 'Speaker Muted'}
            className={`w-11 h-11 rounded-full border flex items-center justify-center text-lg cursor-pointer transition-all ${
              isSpeakerOn
                ? 'bg-blue-600 border-blue-400 text-white'
                : 'bg-white/10 border-white/20 text-slate-300 hover:bg-white/20'
            }`}
          >
            {isSpeakerOn ? '🔊' : '🔈'}
          </button>

          {/* Keypad Toggle */}
          <button
            type="button"
            onClick={() => setIsKeypadOpen((prev) => !prev)}
            title="Phone Dialpad"
            className={`w-11 h-11 rounded-full border flex items-center justify-center text-lg cursor-pointer transition-all ${
              isKeypadOpen
                ? 'bg-blue-600 border-blue-400 text-white'
                : 'bg-white/10 border-white/20 text-slate-300 hover:bg-white/20'
            }`}
          >
            🔢
          </button>
        </div>

        {/* Dedicated Push-to-Talk / Tap to Speak Button */}
        <div className="flex justify-center mt-3 mb-1">
          <button
            type="button"
            onClick={handleToggleRecord}
            className={`inline-flex items-center gap-2 py-2 px-5 rounded-full text-sm font-bold border transition-all cursor-pointer shadow-md select-none ${
              isRecordingAudio
                ? 'bg-rose-600 border-rose-400 text-white animate-pulse scale-105'
                : 'bg-sky-600 hover:bg-sky-500 border-white/25 text-white'
            }`}
          >
            <span>🎙️</span>
            <span>{isRecordingAudio ? '🔴 Speaking... (Tap when finished)' : 'Tap or Hold to Speak'}</span>
          </button>
        </div>

        {/* Voice Selector Bar */}
        <div className="flex justify-between items-center mt-4 pt-4 border-t border-white/10 text-xs sm:text-sm text-slate-400 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span>Agent Voice:</span>
            <select
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="bg-slate-900/80 text-slate-200 border border-white/20 rounded-lg px-2.5 py-1 text-xs outline-none cursor-pointer"
            >
              <option value="en-US-JennyNeural">Jenny (Warm & Natural)</option>
              <option value="en-US-GuyNeural">Guy (Professional Male)</option>
              <option value="en-US-AriaNeural">Aria (Expressive)</option>
            </select>
          </div>
          {isHandsfree && (
            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold text-xs">
              <span>●</span> Hands-Free Mode Active (Continuous Speech)
            </div>
          )}
        </div>

        {/* DTMF Dialpad Modal */}
        {isKeypadOpen && (
          <div className="mt-4 p-4 bg-slate-950/95 border border-white/15 rounded-2xl max-w-xs mx-auto animate-fadeIn">
            <div className="font-mono text-center text-xl tracking-widest py-2 bg-black/40 rounded-lg mb-3 text-sky-400 min-h-10">
              {dialedDigits || '_'}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { k: '1', sub: '' },
                { k: '2', sub: 'ABC' },
                { k: '3', sub: 'DEF' },
                { k: '4', sub: 'GHI' },
                { k: '5', sub: 'JKL' },
                { k: '6', sub: 'MNO' },
                { k: '7', sub: 'PQRS' },
                { k: '8', sub: 'TUV' },
                { k: '9', sub: 'WXYZ' },
                { k: '*', sub: '' },
                { k: '0', sub: '+' },
                { k: '#', sub: '' }
              ].map((item) => (
                <button
                  key={item.k}
                  type="button"
                  onClick={() => pressDtmf(item.k)}
                  className="bg-white/10 hover:bg-blue-600/50 active:bg-blue-600 border border-white/15 text-white p-2.5 rounded-xl font-bold text-lg flex flex-col items-center transition-all cursor-pointer"
                >
                  <span>{item.k}</span>
                  <span className="text-[9px] font-normal text-slate-400">{item.sub || '\u00A0'}</span>
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={clearDialpad}
                className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold cursor-pointer"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={routeDialedDtmf}
                className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold cursor-pointer"
              >
                Route DTMF
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Microphone Ready Confirmation Banner (Shows when active) */}
      {hasMicAccess && (
        <div className="bg-emerald-950/30 border border-emerald-500/30 text-emerald-300 px-4 py-2.5 rounded-2xl text-xs sm:text-sm flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-semibold text-emerald-200">Microphone Connected:</span>
            <span className="text-slate-300">Alex is actively listening in real time. Speak naturally or tap to talk.</span>
          </div>
          <span className="bg-emerald-500/20 text-emerald-300 font-bold px-2 py-0.5 rounded text-[11px] border border-emerald-500/30">Ready 🟢</span>
        </div>
      )}

      {/* Error & Guidance Banner (Dismissible, only shown when mic is not accessible) */}
      {errorMessage && !hasMicAccess && !activeMicStreamRef.current?.active && (
        <div className="bg-amber-50 border border-amber-300 text-amber-900 px-4 py-3 rounded-2xl text-xs sm:text-sm flex items-start gap-2.5 shadow-xs">
          <span className="text-base">⚠️</span>
          <div className="flex-1 leading-relaxed">
            <span className="font-bold">Microphone Status: </span>
            {errorMessage}
            <div className="mt-1 text-slate-600 text-xs">
              💡 <strong>Tip:</strong> If embedded in an iframe preview, web browsers require opening the app in a direct browser tab to enable microphone input. You can also chat anytime using the text box below.
            </div>
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              <a
                href={typeof window !== 'undefined' ? window.location.href : '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-3 py-1.5 rounded-lg text-xs cursor-pointer shadow-xs inline-flex items-center gap-1.5 no-underline"
              >
                <span>↗️</span> Open in Direct Tab
              </a>
              <button
                type="button"
                onClick={() => initMicrophone(true)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-3 py-1.5 rounded-lg text-xs cursor-pointer shadow-xs flex items-center gap-1.5"
              >
                <span>🔄</span> Retry Mic Access
              </button>
              <button
                type="button"
                onClick={() => setErrorMessage(null)}
                className="bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 font-semibold px-3 py-1.5 rounded-lg text-xs cursor-pointer"
              >
                Continue via Chat
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-amber-600 hover:text-amber-900 font-bold ml-1 cursor-pointer text-base leading-none p-1"
            title="Dismiss notification"
          >
            ✕
          </button>
        </div>
      )}

      {/* Text Input & Quick Prompts Section */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 sm:p-5">
        <form onSubmit={handleTextSubmit} className="flex gap-2 mb-3">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type a question or message to Alex..."
            className="flex-1 bg-white border border-slate-300 rounded-xl px-4 py-2.5 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          {/* Quick Voice Speak Button next to Chat */}
          <button
            type="button"
            onClick={handleToggleRecord}
            className={`font-bold px-3.5 sm:px-4 py-2.5 rounded-xl text-sm transition-all cursor-pointer flex items-center gap-1.5 shadow-xs ${
              isRecordingAudio
                ? 'bg-rose-600 hover:bg-rose-700 text-white animate-pulse ring-2 ring-rose-400'
                : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200'
            }`}
            title={isRecordingAudio ? 'Recording... Tap to send voice' : 'Tap to speak voice'}
          >
            <span>{isRecordingAudio ? '🔴' : '🎙️'}</span>
            <span className="hidden sm:inline">{isRecordingAudio ? 'Send' : 'Speak'}</span>
          </button>
          <button
            type="submit"
            disabled={isSending || !inputText.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-bold px-4 sm:px-5 py-2.5 rounded-xl text-sm transition-all cursor-pointer shadow-sm flex items-center gap-1.5"
          >
            {isSending ? (
              <>
                <span className="inline-block animate-spin">⏳</span>
                <span>Sending...</span>
              </>
            ) : (
              <>
                <span>Send</span>
                <span>💬</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={resetConversation}
            className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold px-3 py-2.5 rounded-xl text-sm transition-all cursor-pointer"
            title="Reset conversation"
          >
            🔄 Reset
          </button>
        </form>

        {/* Quick Prompts Chips */}
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-bold text-slate-500 uppercase tracking-wider">Try Asking:</span>
          {quickPrompts.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => commitUserTurn(p.query)}
              className="bg-white hover:bg-blue-50 border border-slate-200 hover:border-blue-300 text-slate-700 hover:text-blue-700 px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer shadow-2xs"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Live Call Conversation Transcript */}
      <div className="space-y-3">
        <div className="flex justify-between items-center px-1">
          <span className="font-extrabold text-sm sm:text-base text-slate-800 flex items-center gap-1.5">
            <span>📜</span> Live Call Transcript
          </span>
          <span className="text-xs text-slate-500">Updated in real time • Click audio to replay voice</span>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 max-h-[460px] overflow-y-auto space-y-4 shadow-xs">
          {messages.map((m) => {
            if (m.type === 'user') {
              return (
                <div key={m.id} className="flex flex-col items-end">
                  <span className="text-[11px] font-bold text-blue-600 mb-1">👤 Caller</span>
                  <div className="bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-br-xs text-sm max-w-[85%] leading-relaxed shadow-xs">
                    {m.text}
                  </div>
                </div>
              );
            }

            if (m.type === 'bot') {
              return (
                <div key={m.id} className="flex flex-col items-start">
                  <span className="text-[11px] font-bold text-emerald-600 mb-1">🤖 Alex (AI Agent)</span>
                  <div className="bg-slate-50 border border-slate-200 text-slate-800 px-4 py-2.5 rounded-2xl rounded-bl-xs text-sm max-w-[85%] leading-relaxed shadow-2xs">
                    <p>{m.text}</p>
                    {m.audioUrl && (
                      <div className="mt-2.5 pt-2 border-t border-slate-200 flex flex-col gap-1.5">
                        <audio
                          controls
                          src={m.audioUrl}
                          className="w-full h-8 outline-none"
                          preload="metadata"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            unlockAudioContext();
                            playVoiceAudio(m.text, m.audioUrl, selectedVoice, true);
                          }}
                          className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold self-start flex items-center gap-1 cursor-pointer"
                        >
                          <span>🔊</span> Replay Voice
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            if (m.type === 'transfer' && m.transfer) {
              return (
                <div key={m.id} className="w-full my-2">
                  <div className="bg-blue-50 border-2 border-dashed border-blue-400 rounded-xl p-4 flex items-center gap-3.5 text-blue-900">
                    <span className="text-3xl">🔀</span>
                    <div className="flex-1">
                      <div className="font-extrabold text-sm sm:text-base text-blue-800">
                        Call Transferred to {m.transfer.name} (Ext {m.transfer.extension})
                      </div>
                      <div className="font-mono text-xs text-slate-600 mt-0.5">
                        Routing SIP: <strong>{m.transfer.sip_uri}</strong> | Dept: {m.transfer.department}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            if (m.type === 'summary' && m.summaryData) {
              const mins = String(Math.floor(m.summaryData.duration / 60)).padStart(2, '0');
              const secs = String(m.summaryData.duration % 60).padStart(2, '0');
              return (
                <div key={m.id} className="w-full my-2">
                  <div className="bg-slate-100 border border-slate-300 rounded-xl p-3.5 flex items-center gap-3 text-slate-700">
                    <span className="text-2xl">📴</span>
                    <div className="flex-1">
                      <div className="font-extrabold text-sm text-slate-800">
                        Call Summary: {mins}:{secs}
                      </div>
                      <div className="font-mono text-xs text-slate-500 mt-0.5">
                        Duration: {m.summaryData.duration} seconds • Session ID: {m.summaryData.callId}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }

            return null;
          })}

          {/* Live User Speech Interim Bubble */}
          {interimTranscript && (
            <div className="flex flex-col items-end animate-pulse">
              <span className="text-[11px] font-bold text-sky-600 mb-1 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-sky-500 animate-ping" />
                <span>🎙️ Hearing you live...</span>
              </span>
              <div className="bg-sky-500/15 border border-sky-400 text-sky-950 px-4 py-2.5 rounded-2xl rounded-br-xs text-sm max-w-[85%] leading-relaxed italic shadow-xs">
                "{interimTranscript}..."
              </div>
            </div>
          )}

          {/* Agent Generating Voice Answer Indicator */}
          {agentWaveState === 'thinking' && !interimTranscript && (
            <div className="flex flex-col items-start animate-pulse">
              <span className="text-[11px] font-bold text-emerald-600 mb-1 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                <span>🤖 Alex is responding...</span>
              </span>
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2 rounded-2xl text-xs flex items-center gap-2 shadow-2xs">
                <span className="inline-block animate-spin text-sm">⚡</span>
                <span>Generating voice answer...</span>
              </div>
            </div>
          )}

          <div ref={conversationEndRef} />
        </div>
      </div>
    </div>
  );
};
