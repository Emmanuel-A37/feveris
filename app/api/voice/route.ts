import { NextRequest, NextResponse } from "next/server";
import {
  createSession,
  advanceState,
  isAssessmentResponse,
  isRestartRequest,
  shouldTriggerAssessment,
  ConversationState,
} from "@/lib/agent";
import { sendFeverisMessage } from "@/lib/claude";
import { buildPatientProfile, extractClinicalEntities } from "@/lib/bioner";
import { retrieveTopCasesForAssessment } from "@/lib/supabase";

interface VapiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

interface VapiWebhookBody {
  call?: { id?: string };
  messages?: VapiMessage[];
  type?: string;
}

interface VoiceSession {
  state: ConversationState;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

const voiceSessions = new Map<string, VoiceSession>();

function toSpokenText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/#{1,3}\s+/g, "")
    .replace(/---FEVERIS ASSESSMENT---/g, "Here is my diagnostic assessment.")
    .replace(/---END ASSESSMENT---/g, "That concludes my assessment.")
    .replace(/DIFFERENTIAL DIAGNOSIS:/g, "Differential diagnosis.")
    .replace(/PATIENT SUMMARY:/g, "Patient summary.")
    .replace(/RED FLAGS:/g, "Red flags.")
    .replace(/NEXT STEP:/g, "Next step.")
    .replace(/DISCLAIMER:/g, "")
    .replace(/^\s*[-•]\s/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim();
}

function extractCleanHistory(
  vapiMessages: VapiMessage[]
): Array<{ role: "user" | "assistant"; content: string }> {
  return vapiMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => m.content?.trim())
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content.trim(),
    }));
}

export async function POST(req: NextRequest) {
  try {
    const body: VapiWebhookBody = await req.json();

    const callId = body.call?.id;
    const eventType = body.type;
    const vapiMessages = body.messages ?? [];

    if (eventType === "end-of-call-report") {
      if (callId) voiceSessions.delete(callId);
      return NextResponse.json({ received: true });
    }

    if (!callId) {
      return NextResponse.json({ error: "No call ID in request" }, { status: 400 });
    }

    if (!voiceSessions.has(callId)) {
      voiceSessions.set(callId, {
        state: createSession(callId),
        history: [],
      });
    }

    const session = voiceSessions.get(callId)!;
    if (session.history.length === 0 && vapiMessages.length > 0) {
      session.history = extractCleanHistory(vapiMessages);
    }

    const lastUserMessage = [...vapiMessages].reverse().find((m) => m.role === "user");

    if (!lastUserMessage?.content?.trim()) {
      return NextResponse.json({ response: "" });
    }

    const userText = lastUserMessage.content.trim();

    if (isRestartRequest(userText)) {
      session.state = createSession(callId);
      session.history = [];

      const restartText =
        "Consultation restarted. What is your patient's chief complaint?";
      session.history.push({ role: "assistant", content: restartText });
      session.state = advanceState(session.state, false);

      return NextResponse.json({ response: restartText });
    }

    const alreadyAdded = session.history.some(
      (m) => m.role === "user" && m.content === userText
    );

    if (!alreadyAdded) {
      session.history.push({ role: "user", content: userText });
    }

    const triggerAssessment = shouldTriggerAssessment(session.state, userText);

    if (session.state.agentState === "COMPLETE" && !triggerAssessment) {
      const guidanceText =
        "Assessment is complete. Say assess again to generate another assessment, or say restart to begin a new patient consultation.";
      session.history.push({ role: "assistant", content: guidanceText });
      return NextResponse.json({ response: guidanceText });
    }

    let responseText: string;

    if (triggerAssessment) {
      const profile = await buildPatientProfile(session.history);
      let cases = [];
      try {
        cases = await retrieveTopCasesForAssessment(profile.query_summary || userText);
      } catch (retrievalErr) {
        console.error("[Voice retrieval error]", retrievalErr);
      }

      const evidenceBlock =
        cases.length > 0
          ? [
              "\n\n[RETRIEVED CLINICAL EVIDENCE — use to ground your assessment:]",
              ...cases.slice(0, 3).map(
                (c, i) =>
                  `Case ${i + 1}: ${
                    c.presenting_complaint || c.document.slice(0, 150)
                  } | Diagnosis: ${c.diagnosis || "not specified"}`
              ),
              "\n[Generate FEVERIS ASSESSMENT now using the exact format in your instructions.]",
            ].join("\n")
          : "\n\n[No similar cases retrieved — generate assessment from clinical reasoning.]";

      const augmentedHistory = [
        ...session.history.slice(0, -1),
        {
          role: "user" as const,
          content: userText + evidenceBlock,
        },
      ];

      responseText = await sendFeverisMessage(augmentedHistory);
    } else {
      const [text] = await Promise.all([
        sendFeverisMessage(session.history),
        extractClinicalEntities(userText).catch(() => null),
      ]);
      responseText = text;
    }

    const assessmentGenerated = triggerAssessment || isAssessmentResponse(responseText);

    session.history.push({ role: "assistant", content: responseText });
    session.state = advanceState(session.state, assessmentGenerated);

    const spokenText = toSpokenText(responseText);
    return NextResponse.json({ response: spokenText });
  } catch (err) {
    console.error("[Voice route error]", err);
    return NextResponse.json({
      response: "I encountered a technical issue. Please repeat your last response.",
    });
  }
}
