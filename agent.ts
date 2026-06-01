/**
 * FEVERIS — lib/agent.ts
 * ======================
 * Central agent state machine for the FEVERIS diagnostic reasoning system.
 *
 * This file is the single source of truth for:
 *   - All shared TypeScript types used across the project
 *   - The ConversationState shape passed between frontend and /api/chat
 *   - Agent state transition logic
 *   - Assessment trigger detection
 *   - The diagnostic hypothesis set (disease priors)
 *
 * Imported by:
 *   - app/api/chat/route.ts         (state transitions + trigger detection)
 *   - app/consultation/page.tsx     (ConversationState type + createSession)
 *   - components/VoiceToggle.tsx    (no direct import — uses page state)
 *   - evaluation/runEval.ts         (createSession for test harness)
 */

// ─────────────────────────────────────────────────────────────────────────────
// AGENT STATES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four states FEVERIS moves through in a consultation.
 *
 * GREETING      → Turn 0. Agent introduces itself, asks chief complaint.
 * HISTORY_TAKING → Turns 1–5. Agent dynamically narrows hypothesis set.
 * ASSESSING     → Assessment has been triggered and is being generated.
 * COMPLETE      → Assessment delivered. Session is read-only.
 */
export type AgentState =
  | "GREETING"
  | "HISTORY_TAKING"
  | "ASSESSING"
  | "COMPLETE";

// ─────────────────────────────────────────────────────────────────────────────
// CORE TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The serialisable state object passed back and forth between the
 * Next.js frontend (app/consultation/page.tsx) and the API route
 * (app/api/chat/route.ts) on every single request.
 *
 * IMPORTANT: This must remain JSON-serialisable at all times.
 * Do not add class instances, functions, or Symbols to this type.
 */
export interface ConversationState {
  /** Unique ID generated per consultation via crypto.randomUUID() */
  sessionId: string;

  /** Current state in the diagnostic interview state machine */
  agentState: AgentState;

  /**
   * Number of clinician (user) turns completed so far.
   * Starts at 0. Auto-triggers assessment at >= 6.
   * Incremented by advanceState() after each successful API response.
   */
  turnCount: number;

  /**
   * Running list of disease hypotheses still in consideration.
   * Starts as the full FEBRILE_DISEASE_PRIORS list.
   * Narrows as the agent extracts discriminating information.
   * Used by /api/chat to inform claude's question selection.
   */
  activeHypotheses: string[];

  /**
   * Accumulated entity tags extracted by BioNER across all turns.
   * Appended to on each turn — never reset mid-session.
   * Used to build the RAG query summary at assessment time.
   */
  accumulatedSymptoms: string[];
  accumulatedDiseases: string[];
  accumulatedTemporalInfo: Array<{ type: string; value: string }>;
  demographics: { age?: string; sex?: string };

  /**
   * ISO timestamp of session creation. Used for session expiry
   * and evaluation latency calculations.
   */
  createdAt: string;

  /**
   * ISO timestamp of last activity. Useful for detecting stale sessions
   * in a production multi-user deployment.
   */
  lastActivityAt: string;
}

/**
 * A single message in the claude multi-turn conversation format.
 * This is the shape expected by getFeverisModel().startChat({ history }).
 *
 * Used in:
 *   - app/consultation/page.tsx (message array state)
 *   - app/api/chat/route.ts (passed to claude SDK)
 */
export interface claudeMessage {
  role: "user" | "model";
  parts: [{ text: string }];
}

/**
 * A message as stored in the frontend UI state.
 * Extends claudeMessage's content with display metadata.
 */
export interface UIMessage {
  role: "user" | "assistant";
  content: string;
  /** True when this message contains a ---FEVERIS ASSESSMENT--- block */
  isAssessment: boolean;
  /** ISO timestamp for display and evaluation logging */
  timestamp: string;
}

/**
 * A case retrieved from ChromaDB by lib/chroma.ts.
 * Passed from /api/chat to the frontend alongside assessment responses.
 */
export interface RetrievedCase {
  rank: number;
  document: string;
  diagnosis: string;
  presenting_complaint: string;
  source: string;
  /** Cosine similarity score: 0–1. Higher is more relevant. */
  similarity: number;
  caseId: string;
}

/**
 * The full response shape returned by /api/chat/route.ts.
 * The frontend destructures this on every fetch response.
 */
export interface ChatAPIResponse {
  /** The agent's text response for this turn */
  response: string;
  /** Updated state to replace frontend's current sessionState */
  sessionState: ConversationState;
  /** BioNER entities extracted from this turn's clinician input */
  entities: {
    symptoms: string[];
    diseases_mentioned: string[];
    medications: string[];
    demographics: { age?: string; sex?: string };
    temporal_info: Array<{ type: string; value: string }>;
    severity_markers: string[];
    query_summary: string;
  } | null;
  /** Retrieved cases — only populated on assessment turns */
  retrievedCases: RetrievedCase[] | null;
  /** True when this response contains a ---FEVERIS ASSESSMENT--- block */
  isAssessment: boolean;
  /** Error message — only present when the API route catches an exception */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTIC HYPOTHESIS SET
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full set of febrile infectious diseases FEVERIS reasons over.
 * This is the "all hypotheses active" starting state for every consultation.
 *
 * Ordered roughly by global burden in low-resource tropical settings,
 * which is the primary deployment context from the project proposal.
 *
 * This list is intentionally kept to diseases with:
 *   (a) meaningful representation in the PMC-Patients febrile corpus
 *   (b) distinct enough symptom profiles to allow differential reasoning
 *   (c) clear confirmatory tests a clinician can order
 */
export const FEBRILE_DISEASE_PRIORS: readonly string[] = [
  // Parasitic
  "Malaria (P. falciparum)",
  "Malaria (P. vivax)",
  "Visceral Leishmaniasis",
  "African Trypanosomiasis",

  // Arboviral
  "Dengue Fever",
  "Chikungunya",
  "Yellow Fever",
  "Zika",

  // Bacterial
  "Typhoid Fever",
  "Bacterial Sepsis",
  "Leptospirosis",
  "Brucellosis",
  "Rickettsia",
  "Bacterial Meningitis",

  // Viral
  "Influenza",
  "Viral Haemorrhagic Fever",
  "COVID-19",

  // Other
  "Tuberculosis (miliary/disseminated)",
  "Infective Endocarditis",
] as const;

/**
 * Diseases that should trigger an immediate RED FLAGS alert
 * regardless of turn count if the presentation is consistent.
 * FEVERIS checks for these at every turn via checkRedFlags().
 */
export const RED_FLAG_DISEASES: readonly string[] = [
  "Bacterial Sepsis",
  "Bacterial Meningitis",
  "Viral Haemorrhagic Fever",
  "Dengue Fever", // specifically haemorrhagic presentation
] as const;

/**
 * Clinical features that, if present in accumulatedSymptoms,
 * should trigger a red flag check regardless of disease hypothesis.
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

// ─────────────────────────────────────────────────────────────────────────────
// SESSION FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a fresh ConversationState for a new consultation session.
 *
 * Call this in:
 *   - app/consultation/page.tsx useState initialiser
 *   - evaluation/runEval.ts for each test case
 *
 * @param sessionId - Pass crypto.randomUUID() from the caller.
 *                    Do not generate UUIDs inside this function —
 *                    crypto.randomUUID() behaves differently in
 *                    Node.js vs browser vs Edge runtime.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// ASSESSMENT TRIGGER DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phrases from the clinician that explicitly request an assessment.
 * Checked case-insensitively against the full user message.
 */
const EXPLICIT_TRIGGER_PHRASES: readonly string[] = [
  "assess",
  "assessment",
  "differential",
  "what do you think",
  "your opinion",
  "give me",
  "what is it",
  "what's your",
  "conclude",
  "diagnosis",
  "enough information",
  "enough info",
  "ready",
  "go ahead",
] as const;

/**
 * Determines whether the current turn should trigger RAG retrieval
 * and assessment generation.
 *
 * Two trigger paths:
 *   1. EXPLICIT — clinician uses a trigger phrase in their message
 *   2. AUTO     — turnCount has reached MAX_HISTORY_TURNS
 *
 * @param state       - Current ConversationState
 * @param userMessage - The clinician's raw input text for this turn
 * @returns boolean
 */
export function shouldTriggerAssessment(
  state: ConversationState,
  userMessage: string
): boolean {
  // Never trigger if already assessed or in greeting
  if (state.agentState === "ASSESSING" || state.agentState === "COMPLETE") {
    return false;
  }

  const lower = userMessage.toLowerCase().trim();

  const explicitTrigger = EXPLICIT_TRIGGER_PHRASES.some((phrase) =>
    lower.includes(phrase)
  );

  const autoTrigger =
    state.agentState === "HISTORY_TAKING" &&
    state.turnCount >= MAX_HISTORY_TURNS;

  return explicitTrigger || autoTrigger;
}

/**
 * Maximum number of history-taking turns before auto-triggering assessment.
 * Matches the interview structure in the FEVERIS system prompt.
 * Change this here and it propagates everywhere automatically.
 */
export const MAX_HISTORY_TURNS = 6;

// ─────────────────────────────────────────────────────────────────────────────
// STATE TRANSITIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options passed to advanceState to update accumulated entity data.
 * All fields are optional — only pass what was extracted this turn.
 */
export interface TurnEntities {
  symptoms?: string[];
  diseases?: string[];
  temporalInfo?: Array<{ type: string; value: string }>;
  demographics?: { age?: string; sex?: string };
}

/**
 * Produces the next ConversationState after a completed turn.
 * Pure function — never mutates the input state.
 *
 * Call this in app/api/chat/route.ts after a successful claude response,
 * and return the result to the frontend as `sessionState` in ChatAPIResponse.
 *
 * @param state        - The current ConversationState before this turn
 * @param isAssessment - Whether this turn triggered assessment generation
 * @param entities     - BioNER entities extracted from this turn (optional)
 * @returns            - The next ConversationState
 */
export function advanceState(
  state: ConversationState,
  isAssessment: boolean,
  entities?: TurnEntities
): ConversationState {
  const now = new Date().toISOString();

  // Determine next agent state
  let nextAgentState: AgentState;
  if (isAssessment) {
    nextAgentState = "ASSESSING";
  } else if (state.agentState === "GREETING") {
    nextAgentState = "HISTORY_TAKING";
  } else {
    nextAgentState = state.agentState;
  }

  // Accumulate entities — deduplicated, case-normalised
  const nextSymptoms = entities?.symptoms
    ? dedupe([...state.accumulatedSymptoms, ...entities.symptoms])
    : state.accumulatedSymptoms;

  const nextDiseases = entities?.diseases
    ? dedupe([...state.accumulatedDiseases, ...entities.diseases])
    : state.accumulatedDiseases;

  const nextTemporalInfo = entities?.temporalInfo
    ? [...state.accumulatedTemporalInfo, ...entities.temporalInfo]
    : state.accumulatedTemporalInfo;

  const nextDemographics = entities?.demographics
    ? { ...state.demographics, ...entities.demographics }
    : state.demographics;

  // Narrow active hypotheses if new disease mentions are specific
  const nextHypotheses = entities?.symptoms
    ? narrowHypotheses(state.activeHypotheses, entities.symptoms)
    : state.activeHypotheses;

  return {
    ...state,
    agentState: nextAgentState,
    turnCount: state.turnCount + 1,
    activeHypotheses: nextHypotheses,
    accumulatedSymptoms: nextSymptoms,
    accumulatedDiseases: nextDiseases,
    accumulatedTemporalInfo: nextTemporalInfo,
    demographics: nextDemographics,
    lastActivityAt: now,
  };
}

/**
 * Marks a session as COMPLETE after an assessment has been delivered.
 * Call this in app/api/chat/route.ts after the assessment response is sent.
 *
 * @param state - The current ConversationState (should be ASSESSING)
 * @returns     - State with agentState set to COMPLETE
 */
export function completeSession(state: ConversationState): ConversationState {
  return {
    ...state,
    agentState: "COMPLETE",
    lastActivityAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RED FLAG DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks accumulated symptoms for red flag clinical features.
 * Call this in app/api/chat/route.ts on every turn — not just assessment.
 *
 * If true, the API route should prepend a RED FLAG warning to the
 * agent's response regardless of interview state.
 *
 * @param state - Current ConversationState
 * @returns     - True if red flag symptoms are present
 */
export function checkRedFlags(state: ConversationState): boolean {
  const lower = state.accumulatedSymptoms.map((s) => s.toLowerCase());
  return RED_FLAG_SYMPTOMS.some((flag) =>
    lower.some((symptom) => symptom.includes(flag.toLowerCase()))
  );
}

/**
 * Produces a formatted red flag warning string to prepend to the agent response.
 * Only call this when checkRedFlags() returns true.
 */
export function formatRedFlagWarning(state: ConversationState): string {
  const flaggedSymptoms = state.accumulatedSymptoms.filter((s) =>
    RED_FLAG_SYMPTOMS.some((flag) =>
      s.toLowerCase().includes(flag.toLowerCase())
    )
  );

  return [
    "⚠️  RED FLAG DETECTED",
    `Concerning features: ${flaggedSymptoms.join(", ")}`,
    "Consider immediate escalation before completing the interview.",
    "─".repeat(40),
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG QUERY BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a natural language query string from accumulated session state
 * for use as the ChromaDB semantic search query at assessment time.
 *
 * This is the text that gets embedded and compared against the
 * PMC-Patients case corpus in lib/chroma.ts.
 *
 * Call this in app/api/chat/route.ts when shouldTriggerAssessment() is true,
 * before calling retrieveSimilarCases().
 *
 * @param state - Current ConversationState (should have several turns of data)
 * @returns     - Natural language patient profile for embedding
 */
export function buildRAGQuery(state: ConversationState): string {
  const parts: string[] = [];

  if (state.demographics.age) parts.push(`Age: ${state.demographics.age}`);
  if (state.demographics.sex) parts.push(`Sex: ${state.demographics.sex}`);

  if (state.accumulatedSymptoms.length > 0) {
    parts.push(`Symptoms: ${[...new Set(state.accumulatedSymptoms)].join(", ")}`);
  }

  const durations = state.accumulatedTemporalInfo
    .filter((t) => t.type === "Duration")
    .map((t) => t.value);
  if (durations.length > 0) {
    parts.push(`Duration: ${durations.join(", ")}`);
  }

  const dates = state.accumulatedTemporalInfo
    .filter((t) => t.type === "Date")
    .map((t) => t.value);
  if (dates.length > 0) {
    parts.push(`Timeline: ${dates.join(", ")}`);
  }

  if (state.accumulatedDiseases.length > 0) {
    parts.push(`Conditions mentioned: ${[...new Set(state.accumulatedDiseases)].join(", ")}`);
  }

  if (state.activeHypotheses.length < FEBRILE_DISEASE_PRIORS.length) {
    parts.push(`Working hypothesis: ${state.activeHypotheses.slice(0, 3).join(", ")}`);
  }

  // Fallback: if we somehow have no structured data, return a generic query
  // that will at least retrieve some febrile disease cases
  return parts.length > 0
    ? parts.join(". ")
    : "febrile infectious disease with fever and systemic symptoms";
}

/**
 * Builds a context block to inject into the claude prompt at assessment time.
 * Takes retrieved cases and formats them for the LLM to cite.
 *
 * Call this in app/api/chat/route.ts to augment the clinician's
 * assessment-trigger message before sending to claude.
 *
 * @param cases         - Retrieved cases from lib/chroma.ts
 * @param ragQuery      - The query used to retrieve them (for transparency)
 * @param clinicianText - The clinician's original message triggering assessment
 * @returns             - Augmented message string to send to claude
 */
export function buildAssessmentPrompt(
  cases: RetrievedCase[],
  ragQuery: string,
  clinicianText: string
): string {
  const caseBlock = cases
    .slice(0, 3)
    .map(
      (c, i) =>
        `Case ${i + 1} [${c.source}, similarity: ${c.similarity}]:
  Presentation: ${c.presenting_complaint || c.document.slice(0, 200)}
  Diagnosis: ${c.diagnosis || "Not specified"}`
    )
    .join("\n\n");

  return `
${clinicianText}

[RETRIEVED CLINICAL EVIDENCE]
Patient profile used for retrieval: ${ragQuery}

${caseBlock}

[Generate your FEVERIS ASSESSMENT now using the exact format specified in your instructions. 
Cite the retrieved cases above where relevant to support your reasoning.]
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// HYPOTHESIS NARROWING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Symptom-to-disease discriminator map.
 * When a symptom is detected, diseases NOT consistent with it
 * can be down-weighted or removed from active hypotheses.
 *
 * This is a simple heuristic narrowing — the LLM does the real reasoning.
 * The purpose here is to give claude a hint about what the agent "thinks"
 * is most likely, which improves question selection in the system prompt.
 *
 * Extend this map as you test more cases and find common discriminators.
 */
const SYMPTOM_DISEASE_MAP: Record<string, string[]> = {
  // Symptoms that strongly suggest specific diseases
  "purpuric rash": ["Bacterial Meningitis", "Bacterial Sepsis"],
  "petechiae": ["Dengue Fever", "Bacterial Sepsis"],
  "rose spots": ["Typhoid Fever"],
  "retro-orbital pain": ["Dengue Fever"],
  "rigors": ["Malaria (P. falciparum)", "Bacterial Sepsis"],
  "splenomegaly": ["Malaria (P. falciparum)", "Malaria (P. vivax)", "Visceral Leishmaniasis"],
  "jaundice": ["Malaria (P. falciparum)", "Yellow Fever", "Leptospirosis"],
  "rash": ["Dengue Fever", "Chikungunya", "Rickettsia", "Typhoid Fever"],
  "joint pain": ["Chikungunya", "Dengue Fever", "Brucellosis"],
  "lymphadenopathy": ["Visceral Leishmaniasis", "African Trypanosomiasis", "Tuberculosis (miliary/disseminated)"],
  "neck stiffness": ["Bacterial Meningitis"],
  "haemorrhage": ["Viral Haemorrhagic Fever", "Dengue Fever"],
};

/**
 * Narrows the active hypothesis list based on newly detected symptoms.
 * Uses a prioritisation approach: diseases consistent with detected
 * discriminating symptoms float to the top.
 *
 * Does NOT remove hypotheses entirely during history taking —
 * that's too aggressive given incomplete information.
 * Instead, it reorders so the most likely appear first.
 *
 * @param currentHypotheses - Current active hypothesis list
 * @param newSymptoms       - Symptoms just extracted by BioNER this turn
 * @returns                 - Reordered hypothesis list
 */
function narrowHypotheses(
  currentHypotheses: string[],
  newSymptoms: string[]
): string[] {
  const symptomsLower = newSymptoms.map((s) => s.toLowerCase());

  // Find diseases that match any detected discriminating symptom
  const prioritised = new Set<string>();

  for (const [symptomKey, diseases] of Object.entries(SYMPTOM_DISEASE_MAP)) {
    if (symptomsLower.some((s) => s.includes(symptomKey.toLowerCase()))) {
      diseases.forEach((d) => {
        if (currentHypotheses.includes(d)) prioritised.add(d);
      });
    }
  }

  // Return: matched diseases first, then remaining diseases
  const remaining = currentHypotheses.filter((h) => !prioritised.has(h));
  return [...prioritised, ...remaining];
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deduplicates a string array, case-insensitively.
 * Preserves the first occurrence's original casing.
 */
function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    const lower = item.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

/**
 * Converts a UIMessage array (frontend format) to claudeMessage array
 * (claude SDK format) for passing to model.startChat({ history }).
 *
 * Use this in app/consultation/page.tsx before the fetch call,
 * or in app/api/chat/route.ts if messages arrive in UI format.
 *
 * @param uiMessages - Messages in frontend UIMessage format
 * @returns          - Messages in claude SDK claudeMessage format
 */
export function toclaudeHistory(uiMessages: UIMessage[]): claudeMessage[] {
  return uiMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

/**
 * Returns a human-readable label for the current agent state.
 * Used in the session status sidebar (app/consultation/page.tsx).
 *
 * @param state - Current ConversationState
 * @returns     - Display string for the UI
 */
export function getStateLabel(state: ConversationState): string {
  switch (state.agentState) {
    case "GREETING":
      return "Starting consultation...";
    case "HISTORY_TAKING":
      return `Taking history (${state.turnCount}/${MAX_HISTORY_TURNS} turns)`;
    case "ASSESSING":
      return "Generating assessment...";
    case "COMPLETE":
      return "Assessment complete";
    default:
      return "Unknown state";
  }
}

/**
 * Returns true if a session has been inactive for longer than the timeout.
 * Useful for cleaning up stale sessions in a production multi-user deployment.
 *
 * @param state          - ConversationState to check
 * @param timeoutMinutes - Inactivity threshold (default 30 minutes)
 * @returns              - True if session should be considered expired
 */
export function isSessionExpired(
  state: ConversationState,
  timeoutMinutes = 30
): boolean {
  const lastActivity = new Date(state.lastActivityAt).getTime();
  const now = Date.now();
  return now - lastActivity > timeoutMinutes * 60 * 1000;
}
