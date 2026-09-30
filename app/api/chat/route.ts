// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import { sendFeverisMessage, streamFeverisMessage } from "@/lib/claude";
import {
  createSession,
  advanceState,
  isAssessmentResponse,
  isRestartRequest,
  shouldTriggerAssessment,
  checkRedFlags,
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

const FALLBACK_ASSESSMENT_REPLY =
  "I can't generate the assessment right now because the model is unavailable. Please try again once the backend is configured.";

function fallbackReply(userText: string): string {
  const lower = userText.toLowerCase();

  if (/assess|differential|what do you think|your opinion|give me|diagnosis|enough information|ready|go ahead/.test(lower)) {
    return FALLBACK_ASSESSMENT_REPLY;
  }

  return "Noted. Please continue with the next clinically relevant detail about the patient's fever.";
}

interface ModelCallResult {
  text: string;
  /** ms spent inside the Claude generation call itself; null when the
   *  fallback text was used instead (no real API call was timed). */
  generationMs: number | null;
  isFallback: boolean;
}

/**
 * Blocking Claude call with fallback handling. Used everywhere except the
 * one path that's explicitly allowed to stream (see streamOrSend below).
 */
async function safeSendFeverisMessage(
  messages: ClaudeMessage[],
  fallbackText: string
): Promise<ModelCallResult> {
  try {
    const { text, generationMs } = await sendFeverisMessage(messages);
    return { text, generationMs, isFallback: false };
  } catch (err) {
    console.error("[Chat model fallback]", err);
    return { text: fallbackText, generationMs: null, isFallback: true };
  }
}

/**
 * Streaming Claude call with the same fallback handling as
 * safeSendFeverisMessage. onDelta is only called for real streamed text —
 * never for the fallback string, so a caller can't accidentally show a
 * "streamed" fallback and think it was a real generation.
 */
async function safeStreamFeverisMessage(
  messages: ClaudeMessage[],
  fallbackText: string,
  onDelta: (deltaText: string) => void
): Promise<ModelCallResult> {
  try {
    const { text, generationMs } = await streamFeverisMessage(messages, onDelta);
    return { text, generationMs, isFallback: false };
  } catch (err) {
    console.error("[Chat model fallback]", err);
    return { text: fallbackText, generationMs: null, isFallback: true };
  }
}

/**
 * Builds the evidence-augmented message array used for every genuine
 * assessment generation (explicit-trigger or spontaneous-regenerated) —
 * shared so both paths construct the exact same prompt shape.
 */
function buildAugmentedMessages(
  validMessages: ClaudeMessage[],
  userText: string,
  cases: RetrievedCase[]
): ClaudeMessage[] {
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

  return [
    ...validMessages.slice(0, -1),
    { role: "user", content: userText + evidenceBlock },
  ];
}

interface AssessmentTurnResult extends ModelCallResult {
  retrievedCases: RetrievedCase[];
  entityData: Awaited<ReturnType<typeof buildPatientProfile>>;
}

/**
 * Runs a genuine, retrieval-grounded assessment turn: builds the patient
 * profile, retrieves similar cases, and generates the assessment with that
 * evidence injected. Used for BOTH the explicit-trigger path (user said
 * "assess" / turn count hit the ceiling) AND the spontaneous-assessment
 * path (Claude decided on its own, on what the code thought was an
 * ordinary history-taking turn, to emit a full assessment — see
 * isAssessmentResponse below) — so a spontaneous assessment is never
 * accepted ungrounded. Pass onDelta to stream the generation; omit it to
 * block until the full text is ready.
 */
async function runAssessmentTurn(
  validMessages: ClaudeMessage[],
  userText: string,
  onDelta?: (deltaText: string) => void
): Promise<AssessmentTurnResult> {
  const profile = await buildPatientProfile(validMessages);

  let cases: RetrievedCase[] = [];
  try {
    const { retrieveTopCasesForAssessment } = await import("@/lib/supabase");
    cases = await retrieveTopCasesForAssessment(profile.query_summary || userText);
  } catch (retrievalErr) {
    console.error("[Chat retrieval error]", retrievalErr);
  }

  const augmentedMessages = buildAugmentedMessages(validMessages, userText, cases);
  const fallbackText = fallbackReply(userText);

  const modelResult = onDelta
    ? await safeStreamFeverisMessage(augmentedMessages, fallbackText, onDelta)
    : await safeSendFeverisMessage(augmentedMessages, fallbackText);

  return { ...modelResult, retrievedCases: cases, entityData: profile };
}

interface HistoryTurnResult extends ModelCallResult {
  entityData: Awaited<ReturnType<typeof extractClinicalEntities>> | null;
}

/**
 * Runs an ordinary history-taking turn: BioNER and the Claude call happen
 * in parallel. Deliberately always blocking (never streamed directly to the
 * client) — the response has to be checked with isAssessmentResponse()
 * before anything is shown, because Claude sometimes decides on its own
 * that it has "sufficient information" and emits a full assessment here
 * instead of a follow-up question (this is exactly what caused retrieval to
 * be silently skipped — see FEVERIS_IMPLEMENTATION_NOTES.md Phase 2). If we
 * streamed this turn directly, an ungrounded spontaneous assessment would
 * already be on the user's screen before we could catch and regenerate it.
 */
async function runHistoryTurn(
  validMessages: ClaudeMessage[],
  userText: string
): Promise<HistoryTurnResult> {
  const [modelResult, ner] = await Promise.all([
    safeSendFeverisMessage(validMessages, fallbackReply(userText)),
    extractClinicalEntities(userText).catch(() => null),
  ]);
  return { ...modelResult, entityData: ner };
}

/** NDJSON encoder for the streaming response — one JSON object per line. */
function ndjson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // ── Parse request ────────────────────────────────────────────────────────
    // Expects: { messages: ClaudeMessage[], sessionState: ConversationState,
    //            isInit?: boolean, stream?: boolean }
    // messages is the FULL conversation history accumulated on the frontend.
    // sessionState is passed back from the previous response and forwarded here.
    // stream defaults to false — evaluation/runEval.ts never sets it, so the
    // eval harness keeps getting the exact same single-JSON-body response it
    // always has. Only the browser frontend opts into stream: true.

    const {
      messages,
      sessionState,
      isInit,
      stream: wantsStream,
    }: {
      messages: ClaudeMessage[];
      sessionState?: ConversationState;
      isInit?: boolean;
      stream?: boolean;
    } = body;

    // Validate session state — fall back to a fresh session if missing
    const currentState: ConversationState =
      sessionState && typeof sessionState.turnCount === "number"
        ? sessionState
        : createSession(crypto.randomUUID());

    // ── Init call (empty history — produce greeting) ──────────────────────────
    if (isInit || !messages || messages.length === 0) {
      const initMessages: ClaudeMessage[] = [
        {
          role: "user",
          content:
            "Begin the consultation. Introduce yourself briefly and ask for the chief complaint. Do not repeat your introduction on subsequent turns.",
        },
      ];

      if (wantsStream) {
        return streamingResponse(async (enqueue) => {
          const greeting = await safeStreamFeverisMessage(initMessages, FALLBACK_GREETING, (d) =>
            enqueue(ndjson({ type: "delta", text: d }))
          );
          const nextState = advanceState(currentState, false);
          enqueue(
            ndjson({
              type: "done",
              response: greeting.text,
              sessionState: nextState,
              entities: null,
              retrievedCases: null,
              isAssessment: false,
              generationMs: greeting.generationMs,
              redFlagsDetected: [],
            })
          );
        });
      }

      const greeting = await safeSendFeverisMessage(initMessages, FALLBACK_GREETING);
      return NextResponse.json({
        response: greeting.text,
        sessionState: advanceState(currentState, false),
        entities: null,
        retrievedCases: null,
        isAssessment: false,
        generationMs: greeting.generationMs,
        redFlagsDetected: [],
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
      const initMessages: ClaudeMessage[] = [
        {
          role: "user",
          content:
            "Begin the consultation. Introduce yourself briefly and ask for the chief complaint. Do not repeat your introduction on subsequent turns.",
        },
      ];

      if (wantsStream) {
        return streamingResponse(async (enqueue) => {
          const greeting = await safeStreamFeverisMessage(initMessages, FALLBACK_GREETING, (d) =>
            enqueue(ndjson({ type: "delta", text: d }))
          );
          enqueue(
            ndjson({
              type: "done",
              response: greeting.text,
              sessionState: advanceState(freshState, false),
              entities: null,
              retrievedCases: null,
              isAssessment: false,
              generationMs: greeting.generationMs,
              redFlagsDetected: [],
            })
          );
        });
      }

      const greeting = await safeSendFeverisMessage(initMessages, FALLBACK_GREETING);
      return NextResponse.json({
        response: greeting.text,
        sessionState: advanceState(freshState, false),
        entities: null,
        retrievedCases: null,
        isAssessment: false,
        generationMs: greeting.generationMs,
        redFlagsDetected: [],
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

    // ── Streaming path ────────────────────────────────────────────────────────
    if (wantsStream) {
      return streamingResponse(async (enqueue) => {
        let result: AssessmentTurnResult | HistoryTurnResult;
        let didAssess: boolean;

        if (triggerAssessment) {
          // Already known to be an assessment turn before Claude runs —
          // always retrieval-grounded, so it's safe to stream directly.
          result = await runAssessmentTurn(validMessages, userText, (d) =>
            enqueue(ndjson({ type: "delta", text: d }))
          );
          didAssess = true;
        } else {
          // Ordinary turn — must buffer (not stream) so we can check
          // whether Claude spontaneously assessed before showing anything.
          const historyResult = await runHistoryTurn(validMessages, userText);
          const spontaneousAssessment =
            !historyResult.isFallback && isAssessmentResponse(historyResult.text);

          if (spontaneousAssessment) {
            // Discard the ungrounded response entirely — never shown to the
            // client — and regenerate it properly, this time streamed.
            enqueue(ndjson({ type: "regenerating" }));
            result = await runAssessmentTurn(validMessages, userText, (d) =>
              enqueue(ndjson({ type: "delta", text: d }))
            );
            didAssess = true;
          } else {
            enqueue(ndjson({ type: "delta", text: historyResult.text }));
            result = historyResult;
            didAssess = false;
          }
        }

        const assessmentGenerated = !result.isFallback && didAssess;
        const nextState = advanceState(
          currentState,
          assessmentGenerated,
          "entityData" in result ? (result.entityData as { symptoms?: string[] } | null)?.symptoms : undefined
        );
        const redFlagsDetected = checkRedFlags(nextState.accumulatedSymptoms);

        enqueue(
          ndjson({
            type: "done",
            response: result.text,
            sessionState: nextState,
            entities: result.entityData ?? null,
            retrievedCases: "retrievedCases" in result ? result.retrievedCases : null,
            isAssessment: assessmentGenerated,
            generationMs: result.generationMs,
            redFlagsDetected,
          })
        );
      });
    }

    // ── Non-streaming path (default — evaluation/runEval.ts uses this) ───────
    let result: AssessmentTurnResult | HistoryTurnResult;
    let didAssess: boolean;

    if (triggerAssessment) {
      result = await runAssessmentTurn(validMessages, userText);
      didAssess = true;
    } else {
      const historyResult = await runHistoryTurn(validMessages, userText);
      const spontaneousAssessment =
        !historyResult.isFallback && isAssessmentResponse(historyResult.text);

      if (spontaneousAssessment) {
        // Same regeneration as the streaming path — discard the ungrounded
        // response and redo it through the retrieval-augmented path.
        result = await runAssessmentTurn(validMessages, userText);
        didAssess = true;
      } else {
        result = historyResult;
        didAssess = false;
      }
    }

    // A fallback response (the real Claude call failed) can never count as
    // a genuine assessment — otherwise a failed call silently completes the
    // session (see FEVERIS_IMPLEMENTATION_NOTES.md §4.2 for the bug this fixes).
    const assessmentGenerated = !result.isFallback && didAssess;

    const nextState = advanceState(
      currentState,
      assessmentGenerated,
      "entityData" in result ? (result.entityData as { symptoms?: string[] } | null)?.symptoms : undefined
    );
    const redFlagsDetected = checkRedFlags(nextState.accumulatedSymptoms);

    return NextResponse.json({
      response: result.text,
      sessionState: nextState,
      entities: result.entityData ?? null,
      retrievedCases: "retrievedCases" in result ? result.retrievedCases : null,
      isAssessment: assessmentGenerated,
      generationMs: result.generationMs,
      redFlagsDetected,
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

/**
 * Wraps an async producer function in a ReadableStream NextResponse with
 * the right headers for a newline-delimited-JSON stream. The producer gets
 * an `enqueue` callback to push NDJSON-encoded events; any error it throws
 * is sent as a final {"type":"error"} event rather than crashing the stream
 * silently (the HTTP status is already 200 by the time streaming starts, so
 * errors can't change it — this is the standard tradeoff for this style of
 * streaming response).
 */
function streamingResponse(
  producer: (enqueue: (chunk: Uint8Array) => void) => Promise<void>
): NextResponse {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: Uint8Array) => controller.enqueue(chunk);
      try {
        await producer(enqueue);
      } catch (err) {
        console.error("[Chat stream error]", err);
        enqueue(ndjson({ type: "error", message: "Temporary service issue. Please retry your last message." }));
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
