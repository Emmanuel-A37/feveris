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

export function isAssessmentResponse(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("---feveris assessment---") ||
    lower.includes("---end assessment---") ||
    (lower.includes("differential diagnosis") && lower.includes("next step"))
  );
}

export function isRestartRequest(msg: string): boolean {
  return /\b(restart|start over|new case|new patient|reset)\b/i.test(msg);
}

export function advanceState(state: ConversationState, isAssessment: boolean): ConversationState {
  let nextState: AgentState = state.agentState;
  if (isAssessment) {
    nextState = state.agentState === "ASSESSING" ? "COMPLETE" : "ASSESSING";
  }
  else if (state.agentState === "GREETING") nextState = "HISTORY_TAKING";
  return {
    ...state,
    agentState: nextState,
    turnCount: state.turnCount + 1,
    lastActivityAt: new Date().toISOString(),
  };
}

export const FEBRILE_DISEASE_PRIORS: readonly string[] = [
  "Malaria (P. falciparum)", "Malaria (P. vivax)", "Visceral Leishmaniasis",
  "African Trypanosomiasis", "Dengue Fever", "Chikungunya", "Yellow Fever",
  "Zika", "Typhoid Fever", "Bacterial Sepsis", "Leptospirosis", "Brucellosis",
  "Rickettsia", "Bacterial Meningitis", "Influenza", "Viral Haemorrhagic Fever",
  "COVID-19", "Tuberculosis (miliary/disseminated)", "Infective Endocarditis"
];
