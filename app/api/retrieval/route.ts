// app/api/retrieval/route.ts
import { NextRequest, NextResponse } from "next/server";
import { retrieveTopCasesForAssessment } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const { query, n_results = 5 } = await req.json();
    if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });
    const cases = await retrieveTopCasesForAssessment(query);
    return NextResponse.json({ success: true, cases });
  } catch (err) {
    console.error("[Retrieval]", err);
    return NextResponse.json({ error: "Retrieval failed" }, { status: 500 });
  }
}
