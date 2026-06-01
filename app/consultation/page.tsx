// app/consultation/page.tsx
"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Activity } from "lucide-react";
import { createSession, ConversationState } from "@/lib/agent";
import DiagnosticOutput from "../components/DiagnosticOutput";
import VoiceToggle from "../components/VoiceToggle";


interface Message {
  role: "user" | "assistant";
  content: string;
  isAssessment?: boolean;
}

async function readJsonResponse(res: Response) {
  const text = await res.text();

  try {
    return { data: JSON.parse(text), rawText: text };
  } catch {
    return { data: null, rawText: text };
  }
}

export default function ConsultationPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<ConversationState>(
    createSession(crypto.randomUUID())
  );
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const initialised = useRef(false);
  const STORAGE_KEY = "feveris.consultation.v1";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const init = useCallback(async () => {
    setLoading(true);
    try {
      // Send an empty messages array — Claude will follow the system prompt
      // and produce the greeting on its own. We do NOT send "START_CONSULTATION"
      // into the history because that string would persist across all turns.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          sessionState: session,
          isInit: true,        // flag so the route handles empty history
        }),
      });
      const { data, rawText } = await readJsonResponse(res);
      if (!res.ok) {
        setMessages([
          {
            role: "assistant",
            content:
              data?.error ||
              `Failed to start consultation. ${rawText ? "Received a server error page instead of JSON." : "Please retry."}`,
          },
        ]);
        return;
      }
      // Store ONLY the assistant greeting — no fake user message
      setMessages([{ role: "assistant", content: data?.response ?? "" }]);
      setSession((prev) => data?.sessionState ?? prev);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    // Try to restore session from sessionStorage. If present, use it
    // and skip the initial assistant greeting. Otherwise run init().
    if (initialised.current) return;
    initialised.current = true;

    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.messages) setMessages(parsed.messages);
        if (parsed?.session) setSession(parsed.session);
        if (parsed?.symptoms) setSymptoms(parsed.symptoms);
        return; // skip init() when restoring
      }
    } catch (e) {
      // ignore parse errors and fall back to fresh init
    }

    init();
  }, [init]);

  // Persist session state to sessionStorage on change (per-tab persistence)
  useEffect(() => {
    try {
      const payload = JSON.stringify({ messages, session, symptoms, savedAt: Date.now() });
      sessionStorage.setItem(STORAGE_KEY, payload);
    } catch (e) {
      // ignore storage errors
    }
  }, [messages, session, symptoms]);

  const send = useCallback(async () => {
    if (!input.trim() || loading) return;

    const userMsg: Message = { role: "user", content: input };
    // updated is the new full message list including this user turn
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput("");
    setLoading(true);

    try {
      const history = updated
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          sessionState: session,
        }),
      });

      const { data, rawText } = await readJsonResponse(res);

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              data?.error ||
              `Something went wrong. ${rawText ? "Received a server error page instead of JSON." : "Please try again."}`,
          },
        ]);
        return;
      }

      setMessages(prev => [
        ...prev,
        {
          role: "assistant",
          content: data?.response ?? "",
          isAssessment: data?.isAssessment,
        },
      ]);

      if (data?.entities?.symptoms?.length) {
        setSymptoms(prev => [...new Set([...prev, ...data.entities.symptoms])]);
      }

      setSession((prev) => data?.sessionState ?? prev);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, session]);

  const handleVoiceTranscript = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: "user", content: text }]);
  }, []);

  const handleAssistantVoiceResponse = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.content === text) return prev;
      return [...prev, { role: "assistant", content: text }];
    });
  }, []);

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 font-mono">
      <aside className="w-56 border-r border-gray-800 p-4 flex flex-col gap-4 shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="text-red-500" size={16} />
          <span className="text-sm font-bold tracking-widest">FEVERIS</span>
        </div>
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-widest mb-1.5">Symptoms</p>
          <div className="flex flex-wrap gap-1">
            {symptoms.length === 0
              ? <span className="text-xs text-gray-700">Awaiting input...</span>
              : symptoms.map((s, i) => (
                <span key={i} className="text-xs bg-red-950 text-red-300 border border-red-900 rounded-full px-2 py-0.5">
                  {s}
                </span>
              ))}
          </div>
        </div>
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-widest mb-1.5">Session</p>
          <p className="text-xs text-gray-500">
            Turn {session?.turnCount ?? 0} / 6<br />{session?.agentState ?? "GREETING"}
          </p>
        </div>
        <div className="mt-auto">
          <VoiceToggle
            onTranscript={handleVoiceTranscript}
            onAssistantResponse={handleAssistantVoiceResponse}
          />
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.map((m, i) =>
            m.isAssessment ? (
              <DiagnosticOutput key={i} content={m.content} />
            ) : (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-xl rounded-lg px-4 py-3 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-blue-950 border border-blue-800 text-blue-100"
                    : "bg-gray-900 border border-gray-700 text-gray-100"
                }`}>
                  {m.role === "assistant" && (
                    <p className="text-xs text-red-400 mb-1 font-semibold">FEVERIS</p>
                  )}
                  <p className="whitespace-pre-wrap">{m.content}</p>
                </div>
              </div>
            )
          )}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 flex gap-1">
                {[0, 150, 300].map(d => (
                  <span key={d} className="w-1.5 h-1.5 bg-red-500 rounded-full animate-bounce"
                    style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-gray-800 px-6 py-4">
          <div className="flex gap-3">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
              placeholder="Describe your patient..."
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-red-600 placeholder-gray-700"
            />
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              className="bg-red-700 hover:bg-red-600 disabled:opacity-40 rounded-lg px-4 transition-colors"
            >
              <Send size={16} />
            </button>
          </div>
          <p className="text-xs text-gray-700 mt-2">
            Type <span className="text-gray-500">&quot;assess&quot;</span> to trigger diagnostic output
          </p>
        </div>
      </main>
    </div>
  );
}