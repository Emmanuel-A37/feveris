/**
 * scripts/embedAndStore.ts
 * ========================
 * Reads chunked cases from data/processed/case_chunks.json,
 * generates embeddings using Xenova/all-MiniLM-L6-v2,
 * and stores them in Supabase pgvector.
 *
 * Run with: npx tsx scripts/embedAndStore.ts
 *
 * Prerequisites:
 *   1. Run schema.sql in the Supabase SQL Editor first
 *   2. npx tsx scripts/chunkCases.ts must have completed
 *   3. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 *      (use SERVICE_ROLE key here — anon key cannot insert rows)
 *
 * Next step: npx tsx scripts/verifySetup.ts to confirm retrieval works
 */

import { readFileSync } from "fs";
import { pipeline, env } from "@huggingface/transformers";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

env.allowRemoteModels = true;

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_PATH = "data/processed/case_chunks.json";

/**
 * How many cases to embed and insert per batch.
 * Keep this low (25–50) to avoid Supabase's request size limits
 * and to give you recoverable checkpoints if something fails mid-run.
 */
const BATCH_SIZE = 25;

/**
 * Minimum cosine similarity for a retrieved result to be considered relevant.
 * Used in the verification test at the end of the script.
 */
const MIN_SIMILARITY_THRESHOLD = 0.3;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES — must match schema.sql column names exactly
// ─────────────────────────────────────────────────────────────────────────────

interface CaseChunk {
  id: string;             // patient_uid from filterPmc.ts
  retrieval_text: string; // the text that gets embedded
  full_text: string;
  diagnosis: string;
  presenting_complaint: string;
  source: string;
  // Added by chunkCases.ts from FilteredCase
  pmid?: string;
  title?: string;
  age_text?: string;
  gender_text?: string;
}

interface SupabaseRow {
  patient_uid: string;
  pmid: string;
  title: string;
  age_text: string;
  gender_text: string;
  document: string;
  diagnosis: string;
  presenting_complaint: string;
  source: string;
  embedding: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // ── Guard: check env vars ──────────────────────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error(`
❌ Missing Supabase credentials in .env.local

Add these to .env.local:
  SUPABASE_URL=https://your-project-ref.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key  ← NOT the anon key

Find these in: Supabase Dashboard → Settings → API
    `);
    process.exit(1);
  }

  // ── Step 1: Load case chunks ───────────────────────────────────────────────
  console.log(`Reading ${INPUT_PATH}...`);
  const chunks: CaseChunk[] = JSON.parse(readFileSync(INPUT_PATH, "utf-8"));
  console.log(`✅ Loaded ${chunks.length} case chunks\n`);

  // ── Step 2: Init Supabase client ───────────────────────────────────────────
  // Use service_role key for inserts — anon key is read-only
  const supabase = createClient(supabaseUrl, supabaseKey);

  // ── Step 3: Load embedding model ──────────────────────────────────────────
  console.log("Loading Xenova/all-MiniLM-L6-v2...");
  const embedder = await pipeline(
    "feature-extraction",
    "Xenova/all-MiniLM-L6-v2"
  );
  console.log("✅ Embedding model ready\n");

  // ── Step 4: Check existing count to support resume on partial runs ─────────
  const { count: existingCount } = await supabase
    .from("feveris_cases")
    .select("*", { count: "exact", head: true });

  if (existingCount && existingCount > 0) {
    console.log(`ℹ️  ${existingCount} cases already in Supabase.`);
    console.log(
      "   Continuing from where we left off (duplicate patient_uids will be skipped).\n" +
      "   To start fresh: run 'truncate feveris_cases;' in the Supabase SQL Editor.\n"
    );
  }

  // ── Step 5: Embed and insert in batches ────────────────────────────────────
 // Replace the batch loop and everything after it with this

const BATCH_SIZE = 10;        // down from 25
const DELAY_MS = 2000;        // 1 second between batches
const MAX_RETRIES = 3;        // retry transient failures

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function upsertWithRetry(
  rows: object[],
  batchNum: number,
  retries = MAX_RETRIES
): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { error } = await supabase
      .from("feveris_cases")
      .upsert(rows, { onConflict: "patient_uid", ignoreDuplicates: true });

    if (!error) return true;

    // If it's a 502/503 or fetch failed, wait longer before retrying
    const isTransient =
      error.message.includes("502") ||
      error.message.includes("503") ||
      error.message.includes("fetch failed") ||
      error.message.includes("DOCTYPE");

    if (isTransient && attempt < retries) {
      const wait = attempt * 3000; // 3s, 6s, 9s
      console.error(`\n  ⚠️  Batch ${batchNum} attempt ${attempt} failed (transient). Retrying in ${wait/1000}s...`);
      await sleep(wait);
      continue;
    }

    console.error(`\n❌ Batch ${batchNum} failed after ${attempt} attempts: ${error.message.slice(0, 100)}`);
    return false;
  }
  return false;
}

let inserted = 0;
const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
console.log(`Embedding and storing ${chunks.length} cases in ${totalBatches} batches of ${BATCH_SIZE}...`);

for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
  const batch = chunks.slice(i, i + BATCH_SIZE);
  const batchNum = Math.floor(i / BATCH_SIZE) + 1;
  process.stdout.write(`\r  Batch ${batchNum}/${totalBatches} | Inserted: ${inserted}`);

  const embeddings = await Promise.all(
    batch.map(async (c) => {
      const out = await embedder(c.retrieval_text, { pooling: "mean", normalize: true });
      return Array.from(out.data as Float32Array);
    })
  );

  const rows = batch.map((c, j) => ({
    patient_uid: c.id,
    pmid: c.pmid ?? "",
    title: c.title ?? "",
    age_text: c.age_text ?? "",
    gender_text: c.gender_text ?? "",
    document: c.retrieval_text,
    diagnosis: c.diagnosis,
    presenting_complaint: c.presenting_complaint,
    source: c.source,
    embedding: embeddings[j],
  }));

  const success = await upsertWithRetry(rows, batchNum);
  if (success) inserted += batch.length;

  // Delay between every batch — gives Supabase breathing room
  if (i + BATCH_SIZE < chunks.length) await sleep(DELAY_MS);
}

process.stdout.write("\n");

// Get final count separately — don't chain on upsert
const { count: final, error: countError } = await supabase
  .from("feveris_cases")
  .select("*", { count: "exact", head: true });

if (countError) {
  console.error("Could not get final count:", countError.message);
} else {
  console.log(`\n✅ Done — ${final} total rows in Supabase`);
}
  // ── Step 7: Retrieval sanity check ────────────────────────────────────────
  console.log("\n── Retrieval Sanity Check ─────────────────────────────────────");
  console.log("Query: adult male, 5 days high fever, rigors, recent travel West Africa\n");

  const testEmbedding = await embedder(
    "adult male 5 days high fever rigors headache recent travel West Africa",
    { pooling: "mean", normalize: true }
  );

  const { data: results, error: rpcError } = await supabase.rpc(
    "match_feveris_cases",
    {
      query_embedding: Array.from(testEmbedding.data as Float32Array),
      match_threshold: MIN_SIMILARITY_THRESHOLD,
      match_count: 3,
    }
  );

  if (rpcError) {
    console.error("❌ Retrieval test failed:", rpcError.message);
    console.error("Check that schema.sql was run correctly in the Supabase SQL Editor.");
  } else if (!results || results.length === 0) {
    console.warn("⚠️  No results returned. Your similarity threshold may be too high,");
    console.warn("   or the cases in your corpus may not match this query well.");
    console.warn(`   Try lowering MIN_SIMILARITY_THRESHOLD below ${MIN_SIMILARITY_THRESHOLD}.`);
  } else {
    results.forEach((r: { diagnosis: string; similarity: number; presenting_complaint: string }, i: number) => {
      console.log(`Result ${i + 1}:`);
      console.log(`  Diagnosis:  ${r.diagnosis || "(not extracted)"}`);
      console.log(`  Similarity: ${r.similarity.toFixed(3)}`);
      console.log(`  Preview:    ${r.presenting_complaint?.slice(0, 120) || "(no preview)"}...`);
    });
    console.log("\n✅ Retrieval working correctly");
  }

  console.log("\nNext step: npm run dev  →  test FEVERIS in the browser");
})();