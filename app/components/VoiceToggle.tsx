"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Mic, Square } from "lucide-react";
// 1. We now only import DeepgramClient for SDK v5
import { DeepgramClient } from "@deepgram/sdk";
import { consumeChatStream } from "@/lib/chatStream";
import {
  RECONNECT_CONFIG,
  getReconnectDelayMs,
  hasExhaustedReconnectAttempts,
  extractCompletedSentences,
} from "@/lib/voiceStreaming";

interface Message {
  role: "user" | "assistant";
  content: string;
}

// Trigger words that immediately submit the current turn without waiting for
// the 3.5s silence timeout. Say any of these at the end of your turn. Module
// scope (not per-render) so it's a stable reference for dependency arrays.
const TRIGGER_WORDS = ["send", "done", "over", "finish", "submit"];

interface VoiceToggleProps {
  onTranscript?: (text: string) => void;
  onAssistantResponse?: (text: string, isAssessment?: boolean) => void;
  onSessionStateChange?: (state: any) => void;
  onSymptomsExtracted?: (symptoms: string[]) => void;
  /** Full conversation history — needed for context-aware FEVERIS responses */
  messages?: Message[];
  /** Current agent session state — forwarded to /api/chat */
  sessionState?: unknown;
}

export default function VoiceToggle({
  onTranscript,
  onAssistantResponse,
  onSessionStateChange,
  onSymptomsExtracted,
  messages = [],
  sessionState,
}: VoiceToggleProps) {
  const [active, setActive] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [status, setStatus] = useState<"idle" | "listening" | "processing" | "reconnecting" | "error">("idle");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const messagesRef = useRef<Message[]>(messages);
  const sessionRef = useRef<unknown>(sessionState);

  // 2. Typed as any to bypass complex v5 generic typing for the connection socket
  const dgConnectionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const processingRef = useRef(false);
  const apiKeyRef = useRef<string | null>(null);

  // Reconnect bookkeeping for the Deepgram WebSocket — see connectDeepgram/
  // scheduleReconnect below. intentionalStopRef distinguishes "the clinician
  // clicked End Voice" from "the connection dropped on its own", since only
  // the latter should trigger a reconnect attempt.
  const intentionalStopRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest scheduleReconnect, so connectDeepgram's "close" handler can call
  // it without a circular useCallback dependency (scheduleReconnect itself
  // depends on connectDeepgram, so connectDeepgram can't list scheduleReconnect
  // in its own deps array — that would reference it before it's declared).
  const scheduleReconnectRef = useRef<() => void>(() => {});

  function clearReconnectTimer() {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }

  const cleanup = useCallback(() => {
    intentionalStopRef.current = true;
    clearReconnectTimer();
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    // 3. Properly close the v5 socket connection
    dgConnectionRef.current?.socket?.close();
    audioRef.current?.pause();
    mediaRecorderRef.current = null;
    streamRef.current = null;
    dgConnectionRef.current = null;
    processingRef.current = false;
    reconnectAttemptsRef.current = 0;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { sessionRef.current = sessionState; }, [sessionState]);

  useEffect(() => {
    return () => { cleanup(); };
  }, [cleanup]);

  const fallbackSpeak = useCallback((text: string) => {
    return new Promise<void>((resolve) => {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        
        // Find a natural English voice if possible
        const voices = window.speechSynthesis.getVoices();
        const voice = voices.find(v => v.lang.startsWith("en-") && v.name.includes("Google")) ||
                      voices.find(v => v.lang.startsWith("en-")) ||
                      voices[0];
        if (voice) {
          utterance.voice = voice;
        }

        utterance.onend = () => {
          setSpeaking(false);
          resolve();
        };
        utterance.onerror = (e) => {
          console.error("[Web Speech API error]", e);
          setSpeaking(false);
          resolve();
        };

        window.speechSynthesis.speak(utterance);
      } else {
        console.error("Web Speech API not supported.");
        setSpeaking(false);
        resolve();
      }
    });
  }, []);

  const speak = useCallback((text: string) => {
    return new Promise<void>(async (resolve) => {
      setSpeaking(true);
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          console.warn("[TTS] ElevenLabs failed. Falling back to Web Speech API.");
          await fallbackSpeak(text);
          resolve();
          return;
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        if (audioRef.current) {
          audioRef.current.pause();
          URL.revokeObjectURL(audioRef.current.src);
        }
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => { setSpeaking(false); URL.revokeObjectURL(url); resolve(); };
        audio.onerror = async () => {
          console.warn("[TTS] Audio playback failed. Falling back to Web Speech API.");
          await fallbackSpeak(text);
          resolve();
        };
        await audio.play();
      } catch (err) {
        console.error("[TTS error]", err);
        await fallbackSpeak(text);
        resolve();
      }
    });
  }, [fallbackSpeak]);

  const handleFinalTranscript = useCallback(async (transcript: string) => {
    if (!transcript.trim() || processingRef.current) return;
    processingRef.current = true;
    setStatus("processing");
    setInterimText("");
    onTranscript?.(transcript);

    const history: Message[] = [
      ...messagesRef.current,
      { role: "user", content: transcript },
    ];

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          sessionState: sessionRef.current,
          stream: true,
        }),
      });

      // Speak each sentence as soon as it completes, rather than waiting for
      // the full response. This matters most for the assessment turn, which
      // is the one turn type the server actually streams token-by-token
      // (see app/api/chat/route.ts) — an ordinary history-taking turn still
      // arrives as one buffered chunk server-side, so sentence-splitting it
      // client-side doesn't change time-to-first-audio, only how many
      // separate /api/tts calls it becomes. Sentences are queued and spoken
      // one at a time (never overlapping) so audio doesn't garble.
      let buffer = "";
      let spokenUpTo = 0;
      const speakQueue: string[] = [];
      let draining = false;

      const drainQueue = async () => {
        if (draining) return;
        draining = true;
        while (speakQueue.length > 0) {
          const sentence = speakQueue.shift()!.trim();
          if (sentence) await speak(sentence);
        }
        draining = false;
      };

      const finalEvent = await consumeChatStream(
        res,
        (deltaText) => {
          buffer += deltaText;
          const { sentences, newSpokenUpTo } = extractCompletedSentences(buffer, spokenUpTo);
          spokenUpTo = newSpokenUpTo;
          for (const sentence of sentences) {
            speakQueue.push(sentence);
            drainQueue();
          }
        },
        () => {
          // Spontaneous assessment discarded server-side and being
          // regenerated — nothing should have been queued yet in practice
          // (ordinary turns don't stream deltas until "done"), but reset
          // defensively in case that ever changes.
          buffer = "";
          spokenUpTo = 0;
          speakQueue.length = 0;
        }
      );

      if (!finalEvent || finalEvent.type === "error") {
        console.error("[Voice chat error]", finalEvent?.message || "no response");
        return;
      }

      if (finalEvent.sessionState) {
        onSessionStateChange?.(finalEvent.sessionState);
      }
      if (finalEvent.entities?.symptoms?.length) {
        onSymptomsExtracted?.(finalEvent.entities.symptoms);
      }

      const reply = finalEvent.response ?? buffer;
      if (reply.trim()) {
        onAssistantResponse?.(reply, finalEvent.isAssessment);
        // Speak whatever trailing text never hit a sentence boundary
        // (short replies with no terminal punctuation, or the tail end of
        // the last sentence) after everything already queued has played.
        const trailing = reply.slice(spokenUpTo).trim();
        if (trailing) speakQueue.push(trailing);
        await drainQueue();
      }
    } catch (err) {
      console.error("[Voice chat error]", err);
    } finally {
      processingRef.current = false;
      setStatus("listening");
    }
  }, [onTranscript, speak, onSessionStateChange, onSymptomsExtracted]);

  /**
   * Opens (or re-opens) the Deepgram WebSocket and wires up its handlers.
   * On a fresh start (isReconnect: false) this also creates the
   * MediaRecorder and starts capturing mic audio. On a reconnect, the
   * MediaRecorder keeps running the whole time — it just sends nothing
   * while dgConnectionRef.current has no open socket — so reconnecting only
   * needs to replace the WebSocket connection, not the mic capture.
   *
   * Crucially, the MediaRecorder's ondataavailable handler reads the
   * connection off dgConnectionRef.current (not a captured local variable),
   * so once this function swaps in a new connection after a drop, audio
   * automatically starts flowing to it — no need to touch the recorder.
   */
  const connectDeepgram = useCallback(async (isReconnect: boolean) => {
    const apiKey = apiKeyRef.current;
    const stream = streamRef.current;
    if (!apiKey || !stream) return;

    const deepgram = new DeepgramClient({ apiKey });

    const connection = await deepgram.listen.v1.connect({
      model: "nova-2-medical",
      language: "en",
      smart_format: true,
      interim_results: true,
      // Increased from 2000ms → 3500ms so longer clinical descriptions
      // don't get cut off mid-sentence during natural pauses.
      utterance_end_ms: 3500,
      keywords: [
        "malaria:2", "dengue:2", "typhoid:2", "febrile:2",
        "rigors:2", "sepsis:2", "pyrexia:2", "splenomegaly:2",
        "meningitis:2", "falciparum:2"
      ],
    } as any);

    dgConnectionRef.current = connection;

    connection.on("message", (data: any) => {
      if (data.type === "Results") {
        const alt = data?.channel?.alternatives?.[0];
        const text: string = alt?.transcript ?? "";
        if (!text) return;

        if (data.is_final) {
          // Strip any trailing trigger word before sending
          const stripped = TRIGGER_WORDS.reduce(
            (t, kw) => t.replace(new RegExp(`\\s*\\b${kw}\\b\\s*$`, "i"), ""),
            text
          ).trim();
          if (stripped) handleFinalTranscript(stripped);
        } else {
          // Keyword-triggered instant submit on interim transcript
          const lower = text.toLowerCase().trimEnd();
          const matched = TRIGGER_WORDS.find(kw => lower.endsWith(kw));
          if (matched) {
            const stripped = text
              .replace(new RegExp(`\\s*\\b${matched}\\b\\s*$`, "i"), "")
              .trim();
            if (stripped) {
              setInterimText("");
              handleFinalTranscript(stripped);
            }
          } else {
            setInterimText(text);
          }
        }
      }
    });

    // Deepgram always fires "close" after "error" (or on any disconnect,
    // errored or not) — so reconnect decisions live in the close handler,
    // not here. This handler just logs.
    connection.on("error", (err: any) => {
      console.error("[Deepgram error]", err);
    });

    connection.on("close", () => {
      if (intentionalStopRef.current) return; // clinician clicked End Voice
      console.warn("[Deepgram] connection closed unexpectedly");
      scheduleReconnectRef.current();
    });

    connection.connect();

    connection.on("open", () => {
      reconnectAttemptsRef.current = 0;
      setReconnectAttempt(0);
      clearReconnectTimer();
      setActive(true);
      setStatus("listening");

      if (!isReconnect) {
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";

        const recorder = new MediaRecorder(stream, { mimeType });
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          const conn = dgConnectionRef.current;
          if (e.data.size > 0 && conn?.socket && conn.socket.readyState === 1) {
            conn.socket.send(e.data);
          }
        };

        recorder.start(250);
      }
    });
  }, [handleFinalTranscript]);

  /**
   * Reconnect with exponential backoff (1s, 2s, 4s, 8s, 16s, capped) after
   * an unexpected drop. Gives up after MAX_RECONNECT_ATTEMPTS and surfaces
   * an error asking the clinician to retry manually — voice mode never just
   * silently stops listening without telling anyone.
   */
  const scheduleReconnect = useCallback(() => {
    if (intentionalStopRef.current) return;

    if (hasExhaustedReconnectAttempts(reconnectAttemptsRef.current)) {
      setStatus("error");
      onAssistantResponse?.(
        "Voice connection was lost and could not be restored after several attempts. Please retry voice mode."
      );
      return;
    }

    reconnectAttemptsRef.current += 1;
    const attempt = reconnectAttemptsRef.current;
    setReconnectAttempt(attempt);
    const delay = getReconnectDelayMs(attempt);

    console.warn(`[Voice] Deepgram connection lost — reconnecting in ${delay}ms (attempt ${attempt}/${RECONNECT_CONFIG.maxAttempts})`);
    setStatus("reconnecting");

    reconnectTimeoutRef.current = setTimeout(() => {
      connectDeepgram(true).catch((err) => {
        console.error("[Voice reconnect error]", err);
        scheduleReconnectRef.current();
      });
    }, delay);
  }, [connectDeepgram, onAssistantResponse]);

  // Keep the ref in sync so connectDeepgram's "close" handler always calls
  // the current scheduleReconnect (which itself depends on connectDeepgram),
  // without a circular useCallback dependency between the two.
  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  const start = useCallback(async () => {
    const apiKey = process.env.NEXT_PUBLIC_DEEPGRAM_API_KEY;
    if (!apiKey) {
      setStatus("error");
      onAssistantResponse?.("Voice is not configured: NEXT_PUBLIC_DEEPGRAM_API_KEY is missing.");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      onAssistantResponse?.("Your browser does not support microphone access.");
      return;
    }

    intentionalStopRef.current = false;
    reconnectAttemptsRef.current = 0;
    setReconnectAttempt(0);
    apiKeyRef.current = apiKey;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      await connectDeepgram(false);
    } catch (err) {
      console.error("[Voice start error]", err);
      setStatus("error");
      onAssistantResponse?.(
        "Microphone access was denied. Please allow microphone permissions and try again."
      );
    }
  }, [connectDeepgram, onAssistantResponse]);

  const stop = useCallback(() => {
    cleanup();
    setActive(false);
    setSpeaking(false);
    setInterimText("");
    setReconnectAttempt(0);
    setStatus("idle");
  }, [cleanup]);

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={active ? stop : start}
        disabled={status === "processing"}
        className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg transition-all disabled:opacity-50 ${
          active
            ? "bg-red-700 hover:bg-red-600 text-white"
            : status === "error"
            ? "bg-yellow-900 hover:bg-yellow-800 text-yellow-200"
            : "bg-gray-800 hover:bg-gray-700 text-gray-300"
        }`}
        type="button"
      >
        {active ? (
          <><Square size={13} /> End Voice</>
        ) : status === "error" ? (
          <><Mic size={13} /> Retry Voice</>
        ) : (
          <><Mic size={13} /> Voice Mode</>
        )}
      </button>

      {active && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                status === "reconnecting"
                  ? "bg-orange-500 animate-pulse"
                  : speaking
                  ? "bg-blue-500 animate-pulse"
                  : status === "processing"
                  ? "bg-yellow-500 animate-pulse"
                  : "bg-red-500 animate-pulse"
              }`}
            />
            {status === "reconnecting"
              ? `Reconnecting... (attempt ${reconnectAttempt}/${RECONNECT_CONFIG.maxAttempts})`
              : speaking
              ? "FEVERIS speaking..."
              : status === "processing"
              ? "Processing..."
              : 'Listening... (say "send" or "done" to submit)'}
          </div>
          {interimText && (
            <p className="text-xs text-gray-600 italic truncate">{interimText}</p>
          )}
        </div>
      )}
    </div>
  );
}