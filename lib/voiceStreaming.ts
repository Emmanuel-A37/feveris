// lib/voiceStreaming.ts
// Pure, browser-independent helpers used by app/components/VoiceToggle.tsx
// for its Deepgram reconnect backoff and sentence-chunked TTS queueing.
// Extracted specifically so they're unit-testable in plain Node — a real
// browser/microphone/network test was explicitly out of reach in this
// environment (no browser automation, no mic access), so this is what
// actual automated coverage of that logic looks like instead. See
// FEVERIS_IMPLEMENTATION_NOTES.md's Phase 1.5 note for the full context.

export const RECONNECT_CONFIG = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 16000,
};

/** Exponential backoff delay (ms) for a given reconnect attempt (1-indexed), capped at maxDelayMs. */
export function getReconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_CONFIG.baseDelayMs * 2 ** (attempt - 1), RECONNECT_CONFIG.maxDelayMs);
}

/** True once the attempt count has exhausted the configured retry budget. */
export function hasExhaustedReconnectAttempts(attempt: number): boolean {
  return attempt >= RECONNECT_CONFIG.maxAttempts;
}

// Matches ".", "!", or "?" followed by an ACTUAL whitespace/newline
// character — deliberately does NOT also match end-of-buffer ($). An
// earlier version included `|$`, reasoning "or end of the text so far" —
// live unit testing (evaluation/verifyVoiceStreamingLogic.ts) caught that
// this fires the moment a streamed delta chunk happens to end right on a
// period, even when it's a decimal/abbreviation boundary with more text
// still arriving next (e.g. "39." in one chunk, "5°C" in the next) — the
// buffer-so-far's "end" isn't the same as "the model is actually done".
// Dropping the end-of-buffer branch means a genuinely final sentence with
// no trailing delta after it is simply left unqueued here; the caller
// (VoiceToggle.tsx) already flushes whatever's left in the buffer once the
// stream's "done" event confirms there's truly nothing more coming, so
// nothing is lost — it's just correctly deferred instead of guessed early.
// Occasionally over-splits on abbreviations like "Dr." — acceptable for
// TTS pacing purposes.
export const SENTENCE_BOUNDARY_RE = /[.!?](?:\s|\n)/;

/**
 * Given the full accumulated text buffer so far and how much of it has
 * already been queued for speech (spokenUpTo, a character index), returns
 * any newly-completed sentences found past that point and the updated
 * "spoken up to" index. Pure — no speaking, no side effects.
 */
export function extractCompletedSentences(
  buffer: string,
  spokenUpTo: number
): { sentences: string[]; newSpokenUpTo: number } {
  const sentences: string[] = [];
  let cursor = spokenUpTo;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_BOUNDARY_RE.exec(buffer.slice(cursor)))) {
    const boundary = cursor + match.index + match[0].length;
    sentences.push(buffer.slice(cursor, boundary));
    cursor = boundary;
  }
  return { sentences, newSpokenUpTo: cursor };
}
