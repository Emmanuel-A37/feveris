// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sendFeverisMessage } from "@/lib/claude";
import {
  createSession,
  advanceState,
  isAssessmentResponse,
  isRestartRequest,
  shouldTriggerAssessment,
  ConversationState,
} from "@/lib/agent";
import { buildPatientProfile, extractClinicalEntities } from "@/lib/bioner";

export interface RetrievedCase {
  rank: number;
  patient_uid: string;
  pmid: string;
  title: string;
  age_text: string;
  gender_text: string;
  document: string;
  diagnosis: string;
  presenting_complaint: string;
  source: string;
  similarity: number;
}

// Claude message format — used throughout this file
interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

const FALLBACK_GREETING =
  "I'm FEVERIS, your diagnostic reasoning assistant. What is your patient's chief complaint?";

function fallbackReply(userText: string): string {
  const lower = userText.toLowerCase();

  if (/assess|differential|what do you think|your opinion|give me|diagnosis|enough information|ready|go ahead/.test(lower)) {
    return "I can't generate the assessment right now because the model is unavailable. Please try again once the backend is configured.";
  }

  return "Noted. Please continue with the next clinically relevant detail about the patient's fever.";
}

async function safeSendFeverisMessage(
  messages: ClaudeMessage[],
  fallbackText: string
): Promise<string> {
  try {
    return await sendFeverisMessage(messages);
  } catch (err) {
    console.error("[Chat model fallback]", err);
    return fallbackText;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // ── Parse request ────────────────────────────────────────────────────────
    // Expects: { messages: ClaudeMessage[], sessionState: ConversationState, isInit?: boolean }
    // messages is the FULL conversation history accumulated on the frontend.
    // sessionState is passed back from the previous response and forwarded here.

    const {
      messages,
      sessionState,
      isInit,
    }: {
      messages: ClaudeMessage[];
      sessionState?: ConversationState;
      isInit?: boolean;
    } = body;

    // Validate session state — fall back to a fresh session if missing
    const currentState: ConversationState =
      sessionState && typeof sessionState.turnCount === "number"
        ? sessionState
        : createSession(crypto.randomUUID());

    // ── Init call (empty history — produce greeting) ──────────────────────────
    if (isInit || !messages || messages.length === 0) {
      const greeting = await safeSendFeverisMessage([
        {
          role: "user",
          content:
            "Begin the consultation. Introduce yourself briefly and ask for the chief complaint. Do not repeat your introduction on subsequent turns.",
        },
      ], FALLBACK_GREETING);

      return NextResponse.json({
        response: greeting,
        sessionState: advanceState(currentState, false),
        entities: null,
        retrievedCases: null,
        isAssessment: false,
      });
    }

    // ── Validate messages array ──────────────────────────────────────────────
    // Claude requires messages to alternate user/assistant and start with user.
    // Filter out any empty content and ensure correct alternation.
    const validMessages = messages.filter((m) => m.content?.trim());

    if (validMessages.length === 0) {
      return NextResponse.json(
        {
          error: "No valid messages in history",
          sessionState: currentState,
        },
        { status: 400 }
      );
    }

    // The last message must be from the user
    const lastMessage = validMessages[validMessages.length - 1];
    if (lastMessage.role !== "user") {
      return NextResponse.json(
        {
          error: "Last message must be from user",
          sessionState: currentState,
        },
        { status: 400 }
      );
    }

    const userText = lastMessage.content;

    if (isRestartRequest(userText)) {
      const freshState = createSession(crypto.randomUUID());
      const greeting = await safeSendFeverisMessage([
        {
          role: "user",
          content:
            "Begin the consultation. Introduce yourself briefly and ask for the chief complaint. Do not repeat your introduction on subsequent turns.",
        },
      ], FALLBACK_GREETING);

      return NextResponse.json({
        response: greeting,
        sessionState: advanceState(freshState, false),
        entities: null,
        retrievedCases: null,
        isAssessment: false,
      });
    }

    // ── Determine if this turn triggers assessment ───────────────────────────
    const triggerAssessment = shouldTriggerAssessment(currentState, userText);

    if (currentState.agentState === "COMPLETE" && !triggerAssessment) {
      return NextResponse.json({
        response:
          "Assessment is complete. Say 'assess again' to generate another assessment with updated details, or say 'restart' to begin a new patient consultation.",
        sessionState: currentState,
        entities: null,
        retrievedCases: null,
        isAssessment: false,
      });
    }

    let responseText: string;
    let retrievedCases: RetrievedCase[] | null = null;
    let entityData = null;

    // ── Assessment turn ──────────────────────────────────────────────────────
    if (triggerAssessment) {
      // Build patient profile from full conversation history
      const profile = await buildPatientProfile(validMessages);
      entityData = profile;

      // Retrieve similar cases using the accumulated patient summary
      let cases: RetrievedCase[] = [];
      try {
        const { retrieveTopCasesForAssessment } = await import("@/lib/supabase");
        cases = await retrieveTopCasesForAssessment(
          profile.query_summary || userText
        );
      } catch (retrievalErr) {
        console.error("[Chat retrieval error]", retrievalErr);
      }
      retrievedCases = cases;

      // Inject retrieved evidence into the final user message
      const evidenceBlock =
        cases.length > 0
          ? [
              "\n\n[RETRIEVED CLINICAL EVIDENCE — use to ground your assessment:]",
              ...cases.slice(0, 3).map(
                (c, i) =>
                  `Case ${i + 1}: ${
                    c.presenting_complaint || c.document.slice(0, 200)
                  } | Diagnosis: ${c.diagnosis || "not specified"} | Similarity: ${c.similarity.toFixed(2)}`
              ),
              "\n[Generate your FEVERIS ASSESSMENT now using the exact format in your instructions.]",
            ].join("\n")
          : "\n\n[No similar cases retrieved — generate assessment from clinical reasoning alone.]";

      // Replace the last user message with the augmented version
      const augmentedMessages: ClaudeMessage[] = [
        ...validMessages.slice(0, -1),
        {
          role: "user",
          content: userText + evidenceBlock,
        },
      ];

      responseText = await safeSendFeverisMessage(
        augmentedMessages,
        fallbackReply(userText)
      );
    }

    // ── Normal history-taking turn ───────────────────────────────────────────
    else {
      // Run NER in parallel with the LLM call — non-blocking
      const [text, ner] = await Promise.all([
        safeSendFeverisMessage(validMessages, fallbackReply(userText)),
        extractClinicalEntities(userText).catch(() => null),
      ]);

      responseText = text;
      entityData = ner;
    }

    // ── Advance state and respond ────────────────────────────────────────────
    const assessmentGenerated = triggerAssessment || isAssessmentResponse(responseText);

    return NextResponse.json({
      response: responseText,
      sessionState: advanceState(currentState, assessmentGenerated),
      entities: entityData,
      retrievedCases,
      isAssessment: assessmentGenerated,
    });
  } catch (err) {
    console.error("[Chat route error]", err);
    return NextResponse.json(
      {
        error: "Temporary service issue. Please retry your last message.",
        sessionState: createSession(crypto.randomUUID()),
      },
      { status: 500 }
    );
  }
}