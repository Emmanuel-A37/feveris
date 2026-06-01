"use client";

import { useState, useCallback, useRef } from "react";
import { Mic, Phone, PhoneOff } from "lucide-react";
import { vapi, FEVERIS_ASSISTANT_CONFIG, getVoiceWebhookUrl } from "@/lib/vapi";

interface VoiceToggleProps {
  onTranscript?: (text: string) => void;
  onAssistantResponse?: (text: string) => void;
}

export default function VoiceToggle({
  onTranscript,
  onAssistantResponse,
}: VoiceToggleProps) {
  const [active, setActive] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">(
    "idle"
  );
  const listenersAttached = useRef(false);

  const isLocalWebhookUrl = (url: string) =>
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:(\d+))?\//i.test(url) ||
    /^\/api\/voice$/i.test(url);

  const start = useCallback(async () => {
    if (!process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY) {
      setStatus("error");
      onAssistantResponse?.(
        "Voice is not configured: NEXT_PUBLIC_VAPI_PUBLIC_KEY is missing."
      );
      return;
    }

    const webhookUrl = getVoiceWebhookUrl();
    if (isLocalWebhookUrl(webhookUrl)) {
      setStatus("error");
      onAssistantResponse?.(
        "Voice mode needs a public webhook URL. Set NEXT_PUBLIC_APP_URL to a reachable URL, such as an ngrok tunnel, before starting voice calls."
      );
      return;
    }

    setStatus("connecting");

    if (!listenersAttached.current) {
      vapi.on("call-start", () => {
        setActive(true);
        setStatus("connected");
      });

      vapi.on("call-end", () => {
        setActive(false);
        setSpeaking(false);
        setStatus("idle");
      });

      vapi.on("speech-start", () => setSpeaking(true));
      vapi.on("speech-end", () => setSpeaking(false));

      vapi.on("message", (msg: {
        type: string;
        role?: string;
        transcript?: string;
        transcriptType?: string;
      }) => {
        if (
          msg.type === "transcript" &&
          msg.role === "user" &&
          msg.transcriptType === "final" &&
          msg.transcript
        ) {
          onTranscript?.(msg.transcript);
        }

        if (
          msg.type === "transcript" &&
          msg.role === "assistant" &&
          msg.transcript
        ) {
          onAssistantResponse?.(msg.transcript);
        }
      });

      vapi.on("error", (err: unknown) => {
        console.error("[VAPI error]", err);
        setStatus("error");
        setActive(false);
        setSpeaking(false);
      });

      listenersAttached.current = true;
    }

    try {
      await vapi.start({
        ...FEVERIS_ASSISTANT_CONFIG,
        model: {
          ...FEVERIS_ASSISTANT_CONFIG.model,
          url: webhookUrl,
        },
      });
    } catch (err) {
      console.error("[VAPI start error]", err);
      setStatus("error");
      onAssistantResponse?.(
        "Voice mode failed to start. If you are developing locally, make sure NEXT_PUBLIC_APP_URL points to a public URL instead of localhost."
      );
    }
  }, [onTranscript, onAssistantResponse]);

  const stop = useCallback(() => {
    vapi.stop();
    setActive(false);
    setSpeaking(false);
    setStatus("idle");
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={active ? stop : start}
        disabled={status === "connecting"}
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
          <>
            <PhoneOff size={13} /> End Voice
          </>
        ) : status === "connecting" ? (
          <>
            <Phone size={13} /> Connecting...
          </>
        ) : status === "error" ? (
          <>
            <Mic size={13} /> Retry Voice
          </>
        ) : (
          <>
            <Mic size={13} /> Voice Mode
          </>
        )}
      </button>

      {active && (
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <span
            className={`w-1.5 h-1.5 rounded-full transition-colors ${
              speaking ? "bg-red-500 animate-pulse" : "bg-gray-600"
            }`}
          />
          {speaking ? "FEVERIS speaking..." : "Listening..."}
        </div>
      )}

      {process.env.NODE_ENV === "development" && !active && (
        <p className="text-xs text-gray-700 leading-tight">
          Voice needs a public webhook URL. <span className="text-gray-500">Set NEXT_PUBLIC_APP_URL or run ngrok for local dev.</span>
        </p>
      )}
    </div>
  );
}
