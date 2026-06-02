"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Mic, Square } from "lucide-react";
// 1. We now only import DeepgramClient for SDK v5
import { DeepgramClient } from "@deepgram/sdk";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface VoiceToggleProps {
  onTranscript?: (text: string) => void;
  onAssistantResponse?: (text: string) => void;
  /** Full conversation history — needed for context-aware FEVERIS responses */
  messages?: Message[];
  /** Current agent session state — forwarded to /api/chat */
  sessionState?: unknown;
}

export default function VoiceToggle({
  onTranscript,
  onAssistantResponse,
  messages = [],
  sessionState,
}: VoiceToggleProps) {
  const [active, setActive] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [status, setStatus] = useState<"idle" | "listening" | "processing" | "error">("idle");

  const messagesRef = useRef<Message[]>(messages);
  const sessionRef = useRef<unknown>(sessionState);
  
  // 2. Typed as any to bypass complex v5 generic typing for the connection socket
  const dgConnectionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const processingRef = useRef(false);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { sessionRef.current = sessionState; }, [sessionState]);

  useEffect(() => {
    return () => { cleanup(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup() {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    // 3. Properly close the v5 socket connection
    dgConnectionRef.current?.socket?.close();
    audioRef.current?.pause();
    mediaRecorderRef.current = null;
    streamRef.current = null;
    dgConnectionRef.current = null;
  }

  const speak = useCallback(async (text: string) => {
    onAssistantResponse?.(text);
    setSpeaking(true);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) { setSpeaking(false); return; }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setSpeaking(false); URL.revokeObjectURL(url); };
      audio.onerror = () => setSpeaking(false);
      await audio.play();
    } catch (err) {
      console.error("[TTS error]", err);
      setSpeaking(false);
    }
  }, [onAssistantResponse]);

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
        }),
      });

      const json = await res.json().catch(() => ({}));
      const reply: string = json.response ?? json.message ?? "";
      if (reply.trim()) await speak(reply);
    } catch (err) {
      console.error("[Voice chat error]", err);
    } finally {
      processingRef.current = false;
      setStatus("listening");
    }
  }, [onTranscript, speak]);

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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 4. Use DeepgramClient instead of createClient
      const deepgram = new DeepgramClient({ apiKey });
      
      // 5. Connect using the v5 structure
    // Connect using the v5 structure, casting to any to bypass the broken TS interface
      const connection = await deepgram.listen.v1.connect({
        model: "nova-2-medical",
        language: "en",
        smart_format: true,       // Back to boolean
        interim_results: true,    // Back to boolean
        utterance_end_ms: 1500,   // Back to number
        keywords: [
          "malaria:2", "dengue:2", "typhoid:2", "febrile:2",
          "rigors:2", "sepsis:2", "pyrexia:2", "splenomegaly:2",
          "meningitis:2", "falciparum:2"
        ],
      } as any); 
      
      dgConnectionRef.current = connection;

      // 6. Replace Enums with standard string events
      connection.on("message", (data: any) => {
        // v5 wraps the payload inside a type identifier
        if (data.type === "Results") {
          const alt = data?.channel?.alternatives?.[0];
          const text: string = alt?.transcript ?? "";
          if (!text) return;

          if (data.is_final) {
            handleFinalTranscript(text);
          } else {
            setInterimText(text);
          }
        }
      });

      connection.on("error", (err: any) => {
        console.error("[Deepgram error]", err);
        setStatus("error");
      });

      // 7. Fire the connection event explicitly
      connection.connect();

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        // 8. Stream using connection.socket.send
        if (e.data.size > 0 && connection.socket && connection.socket.readyState === 1) {
          connection.socket.send(e.data);
        }
      };

      // Only start recording once the WebSocket is fully open
      connection.on("open", () => {
        recorder.start(250);
        setActive(true);
        setStatus("listening");
      });

    } catch (err) {
      console.error("[Voice start error]", err);
      setStatus("error");
      onAssistantResponse?.(
        "Microphone access was denied. Please allow microphone permissions and try again."
      );
    }
  }, [handleFinalTranscript, onAssistantResponse]);

  const stop = useCallback(() => {
    cleanup();
    setActive(false);
    setSpeaking(false);
    setInterimText("");
    setStatus("idle");
  }, []);

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
                speaking
                  ? "bg-blue-500 animate-pulse"
                  : status === "processing"
                  ? "bg-yellow-500 animate-pulse"
                  : "bg-red-500 animate-pulse"
              }`}
            />
            {speaking
              ? "FEVERIS speaking..."
              : status === "processing"
              ? "Processing..."
              : "Listening..."}
          </div>
          {interimText && (
            <p className="text-xs text-gray-600 italic truncate">{interimText}</p>
          )}
        </div>
      )}
    </div>
  );
}