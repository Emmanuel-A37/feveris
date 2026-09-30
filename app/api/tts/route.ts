import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// Provider selection: set TTS_PROVIDER=elevenlabs in .env.local to use ElevenLabs.
// Defaults to "deepgram".
const TTS_PROVIDER = process.env.TTS_PROVIDER ?? "deepgram";

// ElevenLabs config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "Y5TOUsogvnyqs7qlXuqA";

// Deepgram config
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
// Aura voices: aura-asteria-en (warm female), aura-orion-en (male), aura-luna-en (soft female)
// aura-arcas-en, aura-perseus-en, aura-angus-en, aura-helios-en, aura-hera-en
const DEEPGRAM_VOICE = process.env.DEEPGRAM_TTS_VOICE ?? "aura-asteria-en";

function stripMarkdown(text: string): string {
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

async function ttsDeepgram(text: string): Promise<NextResponse> {
  if (!DEEPGRAM_API_KEY) {
    return NextResponse.json(
      { error: "DEEPGRAM_API_KEY is not configured" },
      { status: 503 }
    );
  }

  const dgRes = await fetch(
    `https://api.deepgram.com/v1/speak?model=${DEEPGRAM_VOICE}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );

  if (!dgRes.ok) {
    const errText = await dgRes.text();
    console.error("[TTS Deepgram error]", dgRes.status, errText);
    return NextResponse.json(
      { error: "Deepgram TTS failed", detail: errText },
      { status: 502 }
    );
  }

  const audioBuffer = await dgRes.arrayBuffer();
  return new NextResponse(audioBuffer, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-TTS-Provider": "deepgram",
    },
  });
}

async function ttsElevenLabs(text: string): Promise<NextResponse> {
  if (!ELEVENLABS_API_KEY) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY is not configured" },
      { status: 503 }
    );
  }

  const elRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!elRes.ok) {
    const errText = await elRes.text();
    console.error("[TTS ElevenLabs error]", elRes.status, errText);
    return NextResponse.json(
      { error: "ElevenLabs TTS failed", detail: errText },
      { status: 502 }
    );
  }

  const audioBuffer = await elRes.arrayBuffer();
  return new NextResponse(audioBuffer, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-TTS-Provider": "elevenlabs",
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();

    if (!text?.trim()) {
      return NextResponse.json({ error: "No text provided" }, { status: 400 });
    }

    const spoken = stripMarkdown(text);

    if (TTS_PROVIDER === "elevenlabs") {
      return await ttsElevenLabs(spoken);
    }

    // Default: Deepgram Aura
    return await ttsDeepgram(spoken);
  } catch (err) {
    console.error("[TTS route error]", err);
    return NextResponse.json({ error: "Internal TTS error" }, { status: 500 });
  }
}
