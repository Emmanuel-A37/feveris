
// FEVERIS reasoning core — Claude claude-sonnet-4-6 (primary)
// claude 2.0 Flash kept as commented fallback

import Anthropic from "@anthropic-ai/sdk";
// import { GoogleGenerativeAI } from "@google/generative-ai";

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

## CRITICAL RULES
- Never produce the assessment format during history taking
- If presentation suggests immediate danger (septic shock, meningitis with purpuric rash,
  dengue haemorrhagic fever), flag RED FLAGS immediately regardless of turn count
- If uncertain, say so and state what additional information would resolve it
- Never suggest a diagnosis you cannot support with reasoning
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
 * Sends a multi-turn conversation to Claude claude-sonnet-4-6 and returns the
 * text response. Replaces the claude startChat() pattern.
 *
 * @param messages - Full conversation history in Anthropic message format
 * @returns        - Claude's response text
 */
export async function sendFeverisMessage(
  messages: Array<{ role: "user" | "assistant"; content: string }>
): Promise<string> {
  const anthropic = getAnthropicClient();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    temperature: 0.3,
    system: FEVERIS_SYSTEM_PROMPT,
    messages,
  });

  // Extract text from the first content block
  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error(`Unexpected response block type: ${block.type}`);
  }

  return block.text;
}

// ─────────────────────────────────────────────────────────────────────────────
// claude FALLBACK (commented out — swap back in if needed)
// ─────────────────────────────────────────────────────────────────────────────

// const genAI = new GoogleGenerativeAI(process.env.claude_API_KEY!);

// export function getFeverisModel() {
//   return genAI.getGenerativeModel({
//     model: "claude-2.0-flash",
//     systemInstruction: FEVERIS_SYSTEM_PROMPT,
//     generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
//   });
// }