import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// Same voice ID that was configured in the old Vapi assistant config
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "Y5TOUsogvnyqs7qlXuqA";

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

export async function POST(req: NextRequest) {
  if (!ELEVENLABS_API_KEY) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY is not configured" },
      { status: 503 }
    );
  }

  try {
    const { text } = await req.json();

    if (!text?.trim()) {
      return NextResponse.json({ error: "No text provided" }, { status: 400 });
    }

    const spoken = stripMarkdown(text);

    const elRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: spoken,
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
      },
    });
  } catch (err) {
    console.error("[TTS route error]", err);
    return NextResponse.json({ error: "Internal TTS error" }, { status: 500 });
  }
}
