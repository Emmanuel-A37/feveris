// lib/agent.ts
// Agent state machine logic for FEVERIS

export type AgentState = "GREETING" | "HISTORY_TAKING" | "ASSESSING" | "COMPLETE";

export interface ConversationState {
  sessionId: string;
  agentState: AgentState;
  turnCount: number;
  activeHypotheses: string[];
  accumulatedSymptoms: string[];
  accumulatedDiseases: string[];
  accumulatedTemporalInfo: Array<{ type: string; value: string }>;
  demographics: { age?: string; sex?: string };
  createdAt: string;
  lastActivityAt: string;
}

export function createSession(sessionId: string): ConversationState {
  const now = new Date().toISOString();
  return {
    sessionId,
    agentState: "GREETING",
    turnCount: 0,
    activeHypotheses: [...FEBRILE_DISEASE_PRIORS],
    accumulatedSymptoms: [],
    accumulatedDiseases: [],
    accumulatedTemporalInfo: [],
    demographics: {},
    createdAt: now,
    lastActivityAt: now,
  };
}

/** Case-insensitive dedupe, preserving first occurrence's casing. */
function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    const lower = item.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

export function shouldTriggerAssessment(state: ConversationState, msg: string): boolean {
  const triggers = [
    "assess", "differential", "what do you think", "your opinion",
    "give me", "diagnosis", "enough information", "ready", "go ahead"
  ];
  const lower = msg.toLowerCase();
  const explicit = triggers.some((t) => lower.includes(t));
  const auto = state.agentState === "HISTORY_TAKING" && state.turnCount >= 6;
  return explicit || auto;
}

/**
 * The literal, structural marker the system prompt instructs Claude to
 * emit for a genuine assessment (see lib/claude.ts's CRITICAL RULES).
 *
 * An earlier version of this check required the marker at position 0
 * (text.startsWith) on the theory that a real assessment always opens with
 * it per the prompt template. Live testing disproved that: Claude
 * routinely prepends a short lead-in sentence before the marker (e.g.
 * "**Critical finding.** ... I have enough to assess.\n\n---FEVERIS
 * ASSESSMENT---..."), which made the startsWith check miss real,
 * complete, correctly-formatted assessments — reopening exactly the
 * ungrounded-spontaneous-assessment bug this check exists to catch.
 *
 * The actual brittleness (per the original diagnosis) was never the
 * marker check itself — "---FEVERIS ASSESSMENT---" is distinctive enough
 * that a plain history-taking turn essentially never contains it by
 * coincidence, so checking for it anywhere in the text is safe. The
 * brittle part was the OLD third condition, an OR-fallback that treated
 * any response merely discussing "differential diagnosis" AND "next step"
 * as an assessment even with no marker at all. That fallback is removed
 * here rather than tightened.
 */
const ASSESSMENT_MARKER = "---feveris assessment---";

export function isAssessmentResponse(text: string): boolean {
  return text.toLowerCase().includes(ASSESSMENT_MARKER);
}

export function isRestartRequest(msg: string): boolean {
  return /\b(restart|start over|new case|new patient|reset)\b/i.test(msg);
}

export function advanceState(
  state: ConversationState,
  isAssessment: boolean,
  turnSymptoms?: string[]
): ConversationState {
  let nextState: AgentState = state.agentState;
  if (isAssessment) {
    nextState = state.agentState === "ASSESSING" ? "COMPLETE" : "ASSESSING";
  }
  else if (state.agentState === "GREETING") nextState = "HISTORY_TAKING";

  const accumulatedSymptoms =
    turnSymptoms && turnSymptoms.length > 0
      ? dedupe([...state.accumulatedSymptoms, ...turnSymptoms])
      : state.accumulatedSymptoms;

  return {
    ...state,
    agentState: nextState,
    turnCount: state.turnCount + 1,
    accumulatedSymptoms,
    lastActivityAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RED FLAG DETECTION — deterministic backstop, independent of whether the
// LLM's free text happens to mention a red flag. Trimmed/adapted from the
// version in the deleted root agent.ts (recoverable via
// `git show 8735922:agent.ts`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clinical features that should trigger an immediate red-flag warning
 * regardless of what the LLM's own response says.
 */
export const RED_FLAG_SYMPTOMS: readonly string[] = [
  "purpuric rash",
  "petechiae",
  "altered consciousness",
  "seizure",
  "severe hypotension",
  "shock",
  "bleeding",
  "haemorrhage",
  "stiff neck",
  "photophobia",
  "severe thrombocytopenia",
] as const;

/**
 * Checks accumulated symptoms against RED_FLAG_SYMPTOMS and returns the
 * flags that matched (empty array if none). Unlike the original deleted
 * version, this checks word-by-word rather than requiring the whole flag
 * phrase to appear verbatim in one extracted symptom string — BioNER
 * usually returns single fragmented words (e.g. "rash" on one turn,
 * "purpuric" was never even extracted as a separate word in our own
 * evaluation runs), so a straight substring check on the original
 * multi-word phrases essentially never fires in practice. This version
 * matches if every word of a flag phrase appears somewhere across the
 * accumulated symptoms — deliberately biased toward over-flagging rather
 * than under-flagging, since this is a safety backstop, not the final
 * word (the LLM's own RED FLAGS field in the assessment format still
 * applies its own judgment on top of this).
 */
export function checkRedFlags(accumulatedSymptoms: string[]): string[] {
  if (accumulatedSymptoms.length === 0) return [];
  const joined = accumulatedSymptoms.join(" ").toLowerCase();
  return RED_FLAG_SYMPTOMS.filter((flag) => {
    const words = flag.toLowerCase().split(/\s+/);
    return words.every((w) => joined.includes(w));
  });
}

export const FEBRILE_DISEASE_PRIORS: readonly string[] = [
  "Malaria (P. falciparum)", "Malaria (P. vivax)", "Visceral Leishmaniasis",
  "African Trypanosomiasis", "Dengue Fever", "Chikungunya", "Yellow Fever",
  "Zika", "Typhoid Fever", "Bacterial Sepsis", "Leptospirosis", "Brucellosis",
  "Rickettsia", "Bacterial Meningitis", "Influenza", "Viral Haemorrhagic Fever",
  "COVID-19", "Tuberculosis (miliary/disseminated)", "Infective Endocarditis"
];
