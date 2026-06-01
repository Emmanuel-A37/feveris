// app/api/ner/route.ts
// POST /api/ner — returns structured clinical entities from BioNER
import { NextRequest, NextResponse } from "next/server";
import { extractClinicalEntities } from "@/lib/bioner";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Missing or invalid 'text' field." }, { status: 400 });
    }
    const entities = await extractClinicalEntities(text);
    return NextResponse.json({ entities });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Unknown error" }, { status: 500 });
  }
}
