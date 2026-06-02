import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Medical keywords boosted for clinical accuracy
const KEYWORDS = [
  "malaria:2", "dengue:2", "typhoid:2", "sepsis:2", "febrile:2",
  "pyrexia:2", "rigors:2", "splenomegaly:2", "hepatomegaly:2",
  "meningitis:2", "encephalitis:2", "falciparum:2", "vivax:2",
  "leptospirosis:2", "brucellosis:2", "chikungunya:2",
];

export async function POST(req: NextRequest) {
  if (!DEEPGRAM_API_KEY) {
    return NextResponse.json(
      { error: "DEEPGRAM_API_KEY is not configured" },
      { status: 503 }
    );
  }

  try {
    const audioBuffer = await req.arrayBuffer();

    const contentType = req.headers.get("content-type") ?? "audio/webm";

    const params = new URLSearchParams({
      model: "nova-2-medical",
      language: "en",
      smart_format: "true",
      punctuate: "true",
      keywords: KEYWORDS.join(","),
    });

    const dgRes = await fetch(
      `https://api.deepgram.com/v1/listen?${params}`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": contentType,
        },
        body: audioBuffer,
      }
    );

    if (!dgRes.ok) {
      const errText = await dgRes.text();
      console.error("[STT Deepgram error]", dgRes.status, errText);
      return NextResponse.json(
        { error: "Deepgram transcription failed", detail: errText },
        { status: 502 }
      );
    }

    const dgJson = await dgRes.json();
    const transcript =
      dgJson?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

    return NextResponse.json({ transcript });
  } catch (err) {
    console.error("[STT route error]", err);
    return NextResponse.json({ error: "Internal STT error" }, { status: 500 });
  }
}
