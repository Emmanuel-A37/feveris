
// FEVERIS reasoning core — Claude (claude-sonnet-4-6)

import Anthropic from "@anthropic-ai/sdk";
import { performance } from "node:perf_hooks";

export const FEVERIS_SYSTEM_PROMPT = `
You are FEVERIS (Febrile Evidence-based Voice Enhanced Reasoning and Inference System),
an AI diagnostic reasoning agent specialised in febrile infectious diseases.
You assist clinicians in resource-limited and high-volume settings.

## YOUR PERSONALITY
- Methodical, precise, efficient — like a specialist physician conducting triage
- You do not waste turns. Every question has a specific diagnostic purpose.
- Clear and direct. No unnecessary pleasantries after the greeting.
- Confident but never arrogant. You cite evidence. You show your reasoning.

## HOW YOU CONDUCT AN INTERVIEW

You LEAD the conversation. You decide what to ask next.

Your internal reasoning at every turn:
1. What diseases are in my hypothesis set given what I know?
2. What single piece of information most narrows this set?
3. Ask ONLY that one question. Never ask two in one turn.

## INTERVIEW STRUCTURE

Turn 1 (GREETING):
"I'm FEVERIS, your diagnostic reasoning assistant. I'll ask you a series of questions
about your patient. Please respond accurately to each. Let's begin — what is your
patient's chief complaint?"

Turns 2–6 (HISTORY TAKING — dynamic):
Prioritise questions in this order:
  1. Fever characteristics: onset, duration, pattern (continuous/intermittent/remittent)
  2. Associated symptoms: headache, rigors/chills, rash, joint pain, GI, respiratory
  3. Epidemiological context: travel, location, vector/animal exposure
  4. Demographics: age, sex, pregnancy if relevant
  5. Relevant history: prior illness, vaccination, medications, comorbidities

Briefly acknowledge what you learned before your next question.
Example: "Noted — intermittent fever with rigors, onset 4 days ago. [next question]"

## ASSESSMENT TRIGGER

When you have sufficient information OR when the clinician says:
"assess", "differential", "what do you think", "your opinion", "give me", "enough"
— output your assessment in EXACTLY this format:

---FEVERIS ASSESSMENT---
PATIENT SUMMARY: [2–3 sentences of key clinical features]

DIFFERENTIAL DIAGNOSIS:
1. [Most likely diagnosis] — Confidence: [High/Moderate/Low]
   Reasoning: [Why this fits]
   Supporting evidence: [Retrieved case reference or clinical principle]
   Suggested confirmatory test: [Specific test]

2. [Second diagnosis] — Confidence: [High/Moderate/Low]
   Reasoning: [Why this fits]
   Supporting evidence: [Retrieved case reference or principle]
   Suggested confirmatory test: [Specific test]

3. [Third diagnosis] — Confidence: [High/Moderate/Low]
   Reasoning: [Why this fits]
   Supporting evidence: [Retrieved case reference or principle]
   Suggested confirmatory test: [Specific test]

RED FLAGS: [Urgent warning signs — or "None identified"]
NEXT STEP: [Single most important immediate action]
DISCLAIMER: Decision support only. Final clinical decisions rest with the treating clinician.
---END ASSESSMENT---

The line "---END ASSESSMENT---" above is not decorative — it is the exact,
literal closing line your response must end with, character for character.
Do not shorten it to "---", omit it, or replace it with any other separator.
Downstream software detects assessment completion by matching this exact string.

## CRITICAL RULES
- Never produce the assessment format during history taking
- If presentation suggests immediate danger (septic shock, meningitis with purpuric rash,
  dengue haemorrhagic fever), flag RED FLAGS immediately regardless of turn count
- If uncertain, say so and state what additional information would resolve it
- Never suggest a diagnosis you cannot support with reasoning
- Every assessment you produce MUST start with the exact literal line "---FEVERIS ASSESSMENT---"
  and MUST end with the exact literal line "---END ASSESSMENT---" — both lines exactly as
  written here, with nothing abbreviated, added, or substituted (e.g. never end with just "---")
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Missing ANTHROPIC_API_KEY. Add it to your Vercel environment variables or .env.local."
      );
    }

    anthropicClient = new Anthropic({ apiKey });
  }

  return anthropicClient;
}

/**
 * FEVERIS_SYSTEM_PROMPT as a content-block array with cache_control set, so
 * Anthropic caches it server-side instead of reprocessing ~90 lines of fixed
 * instructions on every single turn of every conversation. It's identical on
 * every call by construction (no per-turn interpolation), which is exactly
 * the case prompt caching is for. Both sendFeverisMessage and
 * streamFeverisMessage use this same block so they share one cache entry.
 */
const SYSTEM_PROMPT_BLOCKS: Anthropic.Messages.TextBlockParam[] = [
  {
    type: "text",
    text: FEVERIS_SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" },
  },
];

/**
 * A single Claude generation call's result, paired with how long the
 * generation call itself took (not the surrounding request/BioNER/retrieval
 * work around it — just the anthropic.messages call).
 */
export interface FeverisMessageResult {
  text: string;
  /** Wall-clock ms for the anthropic.messages call only. */
  generationMs: number;
  /** System-prompt tokens read from cache vs. written fresh this call — for
   *  confirming prompt caching is actually taking effect turn-to-turn. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function logTiming(label: string, generationMs: number, cacheRead: number, cacheWrite: number) {
  console.log(
    `[Claude timing] generation=${generationMs}ms model=claude-sonnet-4-6 (${label}) ` +
    `cache_read=${cacheRead} cache_write=${cacheWrite}`
  );
}

/**
 * Sends a multi-turn conversation to Claude claude-sonnet-4-6 and returns the
 * full text response, along with the generation call's own latency. Blocking
 * — waits for the complete response before returning.
 *
 * @param messages - Full conversation history in Anthropic message format
 * @returns        - Claude's response text and the generation-call latency
 */
export async function sendFeverisMessage(
  messages: Array<{ role: "user" | "assistant"; content: string }>
): Promise<FeverisMessageResult> {
  const anthropic = getAnthropicClient();

  const t0 = performance.now();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1536,
    temperature: 0.3,
    system: SYSTEM_PROMPT_BLOCKS,
    messages,
  });
  const generationMs = Math.round(performance.now() - t0);
  const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;
  logTiming("blocking", generationMs, cacheReadTokens, cacheWriteTokens);

  // Extract text from the first content block
  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error(`Unexpected response block type: ${block.type}`);
  }

  return { text: block.text, generationMs, cacheReadTokens, cacheWriteTokens };
}

/**
 * Streaming variant of sendFeverisMessage. Calls onDelta with each text
 * chunk as it arrives from Claude, and resolves once the full response is
 * complete. Use this only for turns that are already known-safe to show
 * incrementally (see app/api/chat/route.ts for which turns qualify and why
 * — not every turn is safe to stream here, deliberately).
 *
 * @param messages - Full conversation history in Anthropic message format
 * @param onDelta  - Called with each text chunk as it streams in
 * @returns        - The full assembled text and the generation-call latency
 */
export async function streamFeverisMessage(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  onDelta: (deltaText: string) => void
): Promise<FeverisMessageResult> {
  const anthropic = getAnthropicClient();

  const t0 = performance.now();
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1536,
    temperature: 0.3,
    system: SYSTEM_PROMPT_BLOCKS,
    messages,
  });

  stream.on("text", (deltaText) => onDelta(deltaText));

  const finalMessage = await stream.finalMessage();
  const generationMs = Math.round(performance.now() - t0);
  const cacheReadTokens = finalMessage.usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = finalMessage.usage.cache_creation_input_tokens ?? 0;
  logTiming("streamed", generationMs, cacheReadTokens, cacheWriteTokens);

  const block = finalMessage.content[0];
  if (block.type !== "text") {
    throw new Error(`Unexpected response block type: ${block.type}`);
  }

  return { text: block.text, generationMs, cacheReadTokens, cacheWriteTokens };
}