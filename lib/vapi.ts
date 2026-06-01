import Vapi from "@vapi-ai/web";

const vapiPublicKey = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;

export const vapi = new Vapi(vapiPublicKey ?? "");

// Guard against unhandled EventEmitter "error" events before UI listeners attach.
vapi.on("error", () => {});

export function getVoiceWebhookUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    return `${configured.replace(/\/$/, "")}/api/voice`;
  }

  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/voice`;
  }

  return "/api/voice";
}

export const FEVERIS_ASSISTANT_CONFIG = {
  name: "FEVERIS",
  voice: {
    provider: "11labs" as const,
    voiceId: "Y5TOUsogvnyqs7qlXuqA",
  },
  transcriber: {
    provider: "deepgram" as const,
    model: "nova-2",
    language: "en" as const,
    keywords: [
      "malaria:2",
      "dengue:2",
      "typhoid:2",
      "sepsis:2",
      "febrile:2",
      "pyrexia:2",
      "rigors:2",
      "splenomegaly:2",
      "hepatomegaly:2",
      "meningitis:2",
      "encephalitis:2",
      "falciparum:2",
      "vivax:2",
      "leptospirosis:2",
      "brucellosis:2",
      "chikungunya:2",
      "rickettsia:2",
    ],
  },
  model: {
    provider: "custom-llm" as const,
    url: getVoiceWebhookUrl(),
    model: "claude-sonnet-4-6",
  },
  firstMessage:
    "I'm FEVERIS, your diagnostic reasoning assistant. What is your patient's chief complaint?",
  endCallMessage:
    "Assessment complete. Please review the diagnostic output on screen.",
};
