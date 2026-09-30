/**
 * lib/supabase.ts
 * ===============
 * Supabase pgvector client for FEVERIS.
 * Replaces ChromaDB entirely — works on all platforms including Windows x64.
 *
 * Handles:
 *   - Supabase client singleton (one instance across all API routes)
 *   - Semantic similarity search via the match_feveris_cases RPC function
 *     defined in schema.sql
 *
 * Imported by:
 *   - app/api/chat/route.ts        (called when assessment triggers)
 *
 * NOTE: This file uses a path alias (@/lib/embeddings) not a relative path.
 *       Ensure tsconfig.json has:
 *         "paths": { "@/*": ["./*"] }
 *       This is included by default in Next.js projects.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getEmbedding } from "@/lib/embeddings";
import { performance } from "node:perf_hooks";

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT SINGLETON — anon key for reads, safe in API routes
// ─────────────────────────────────────────────────────────────────────────────

let supabaseClient: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
      throw new Error(
        "Missing Supabase credentials.\n" +
        "Add SUPABASE_URL and SUPABASE_ANON_KEY to .env.local\n" +
        "Find these at: Supabase Dashboard → Settings → API"
      );
    }

    supabaseClient = createClient(url, key);
  }
  return supabaseClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES — matches columns returned by match_feveris_cases in schema.sql
//         and RetrievedCase in lib/agent.ts
// ─────────────────────────────────────────────────────────────────────────────

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

interface RPCResult {
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

// ─────────────────────────────────────────────────────────────────────────────
// RETRIEVAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieves the most semantically similar clinical cases to a query.
 *
 * Embeds the query with Xenova/all-MiniLM-L6-v2, then calls the
 * match_feveris_cases Postgres RPC function from schema.sql.
 *
 * @param query          - Natural language patient profile or description
 * @param nResults       - Number of cases to return (default 5)
 * @param matchThreshold - Minimum cosine similarity 0–1 (default 0.3)
 */
export async function retrieveSimilarCases(
  query: string,
  nResults = 5,
  matchThreshold = 0.3
): Promise<RetrievedCase[]> {
  const supabase = getSupabase();

  const embedStart = performance.now();
  const queryEmbedding = await getEmbedding(query);
  const embedMs = Math.round(performance.now() - embedStart);

  const rpcStart = performance.now();
  const { data, error } = await supabase.rpc("match_feveris_cases", {
    query_embedding: queryEmbedding,
    match_threshold: matchThreshold,
    match_count: nResults,
  });
  const rpcMs = Math.round(performance.now() - rpcStart);

  console.log(
    `[Retrieval timing] embed=${embedMs}ms rpc=${rpcMs}ms ` +
    `error=${error ? error.message : "none"} results=${data?.length ?? 0}`
  );

  if (error) {
    throw new Error(
      `Supabase RPC error: ${error.message}\n` +
      "Ensure schema.sql has been run in the Supabase SQL Editor."
    );
  }

  if (!data || data.length === 0) return [];

  return (data as RPCResult[]).map((row, i) => ({
    rank: i + 1,
    patient_uid: row.patient_uid,
    pmid: row.pmid,
    title: row.title,
    age_text: row.age_text,
    gender_text: row.gender_text,
    document: row.document,
    diagnosis: row.diagnosis,
    presenting_complaint: row.presenting_complaint,
    source: row.source,
    similarity: Math.round(row.similarity * 1000) / 1000,
  }));
}

/**
 * Returns top-3 results with a higher threshold (0.4) for assessment prompts
 * where quality matters more than recall.
 */
export async function retrieveTopCasesForAssessment(
  query: string
): Promise<RetrievedCase[]> {
  return retrieveSimilarCases(query, 3, 0.4);
}