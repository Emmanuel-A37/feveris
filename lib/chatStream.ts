// lib/chatStream.ts
// Client-side helper for consuming the /api/chat NDJSON stream (stream: true
// in the request body — see app/api/chat/route.ts). Shared by the text UI
// (app/consultation/page.tsx) and voice UI (app/components/VoiceToggle.tsx)
// so both parse the exact same wire protocol the same way.

import type { ConversationState } from "@/lib/agent";

/** Shape of one line in the /api/chat NDJSON stream. */
export interface ChatStreamEvent {
  type: "delta" | "regenerating" | "done" | "error";
  text?: string;
  message?: string;
  response?: string;
  sessionState?: ConversationState;
  entities?: { symptoms?: string[] } | null;
  isAssessment?: boolean;
}

/**
 * Reads a /api/chat streaming response line by line, calling onDelta for
 * each text chunk and onRegenerating when the server discards a
 * spontaneous, ungrounded assessment and starts regenerating a
 * retrieval-grounded one (see FEVERIS_IMPLEMENTATION_NOTES.md Phase 2/3 for
 * why that happens). Resolves with the final "done"/"error" event once the
 * stream ends, or null if the response had no body to read.
 */
export async function consumeChatStream(
  res: Response,
  onDelta: (text: string) => void,
  onRegenerating: () => void
): Promise<ChatStreamEvent | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalEvent: ChatStreamEvent | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;

      let evt: ChatStreamEvent;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // ignore a malformed line rather than crashing the UI
      }

      if (evt.type === "delta" && evt.text) onDelta(evt.text);
      else if (evt.type === "regenerating") onRegenerating();
      else if (evt.type === "done" || evt.type === "error") finalEvent = evt;
    }
  }

  return finalEvent;
}
