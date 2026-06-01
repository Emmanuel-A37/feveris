/**
 * scripts/chunkCases.ts
 * =====================
 * Reads filtered febrile cases from data/raw/febrile_cases.json,
 * structures each into a retrieval-optimised chunk, and saves to
 * data/processed/case_chunks.json.
 *
 * Run with: npx tsx scripts/chunkCases.ts
 *
 * Prerequisites: npx tsx scripts/filterPmc.ts must have completed
 * Next step:     npx tsx scripts/embedAndStore.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import type { FilteredCase } from "./filterPmc";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_PATH = "data/raw/febrile_cases.json";
const OUTPUT_PATH = "data/processed/case_chunks.json";

/**
 * Final number of cases to embed and store.
 * Downsampled from the raw febrile pool (up to 3000) for manageable
 * Supabase free-tier storage and fast embedding run time.
 * 1500 cases ≈ 30–45 mins embedding on CPU.
 */
const TARGET_CHUNKS = 1500;

/**
 * Max characters of the full narrative to include in the retrieval text.
 * Keeps individual embeddings focused — very long texts dilute the signal.
 */
const MAX_NARRATIVE_CHARS = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shape written to data/processed/case_chunks.json.
 * Must match what embedAndStore.ts expects — do not rename fields
 * without updating that file too.
 */
export interface CaseChunk {
  /** patient_uid from PMC-Patients-V2 — used as Supabase row unique ID */
  id: string;
  /** The text that gets embedded — structured for retrieval quality */
  retrieval_text: string;
  /** Full narrative for reference — not embedded directly */
  full_text: string;
  /** Extracted diagnosis string */
  diagnosis: string;
  /** First 2 sentences — shown in assessment citations */
  presenting_complaint: string;
  /** Source label */
  source: string;
  /** PubMed ID — for citation links in assessment output */
  pmid: string;
  /** Article title — for citation display */
  title: string;
  /** Pre-parsed age e.g. "45 years" from structured dataset field */
  age_text: string;
  /** "Male", "Female", or "" from structured dataset field */
  gender_text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts a diagnosis string from free-text using regex patterns
 * common in case report writing.
 * Returns empty string if no match — embedAndStore will store "" and
 * the LLM will derive diagnosis from the full narrative instead.
 */
function extractDiagnosis(text: string): string {
  const patterns = [
    /diagnosed with ([^.,"]{3,60})/i,
    /diagnosis of ([^.,"]{3,60})/i,
    /confirmed ([^.,"]{3,60}) infection/i,
    /consistent with ([^.,"]{3,60})/i,
    /final diagnosis[:\s]+([^.,"]{3,60})/i,
    /impression[:\s]+([^.,"]{3,60})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim().toLowerCase();
  }
  return "";
}

/**
 * Builds the retrieval text — what actually gets embedded and stored.
 * Structure: presenting complaint → full narrative (truncated) → diagnosis.
 *
 * Including the diagnosis in the retrieval text significantly improves
 * retrieval quality for assessment queries that include disease names.
 */
function buildRetrievalText(
  presentingComplaint: string,
  fullText: string,
  diagnosis: string,
  ageText: string,
  genderText: string
): string {
  const parts: string[] = [];

  // Demographics first — high signal for febrile disease retrieval
  if (ageText || genderText) {
    parts.push(`PATIENT: ${[genderText, ageText].filter(Boolean).join(", ")}`);
  }

  parts.push(`CLINICAL PRESENTATION: ${presentingComplaint}`);
  parts.push(`FULL CASE: ${fullText.slice(0, MAX_NARRATIVE_CHARS)}`);

  if (diagnosis) {
    parts.push(`DIAGNOSIS: ${diagnosis}`);
  }

  return parts.join("\n").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // ── Step 1: Load filtered cases ────────────────────────────────────────────
  console.log(`Reading ${INPUT_PATH}...`);
  const raw: FilteredCase[] = JSON.parse(readFileSync(INPUT_PATH, "utf-8"));
  console.log(`✅ Loaded ${raw.length} filtered cases`);

  // ── Step 2: Reproducible downsample ───────────────────────────────────────
  // Sort by patient_uid for deterministic ordering, then take first TARGET_CHUNKS.
  // This ensures the same 1500 cases are selected on every run.
  const sorted = [...raw].sort((a, b) =>
    a.patient_uid.localeCompare(b.patient_uid)
  );
  const cases = sorted.slice(0, TARGET_CHUNKS);
  console.log(`   Downsampled to ${cases.length} cases (target: ${TARGET_CHUNKS})`);

  // ── Step 3: Build chunks ───────────────────────────────────────────────────
  console.log("\nBuilding retrieval chunks...");

  const chunks: CaseChunk[] = cases.map((c) => {
    const sentences = c.patient.split(". ");
    const presenting = sentences.slice(0, 2).join(". ").trim();
    const diagnosis = extractDiagnosis(c.patient);

    return {
      id: c.patient_uid,
      retrieval_text: buildRetrievalText(
        presenting,
        c.patient,
        diagnosis,
        c.age_text,
        c.gender_text
      ),
      full_text: c.patient,
      diagnosis,
      presenting_complaint: presenting,
      source: "PMC-Patients-V2",
      pmid: c.PMID,
      title: c.title,
      age_text: c.age_text,
      gender_text: c.gender_text,
    };
  });

  // ── Step 4: Quick stats ────────────────────────────────────────────────────
  const withDiagnosis = chunks.filter((c) => c.diagnosis !== "").length;
  const withAge = chunks.filter((c) => c.age_text !== "").length;
  const withGender = chunks.filter((c) => c.gender_text !== "").length;
  const avgTextLen = Math.round(
    chunks.reduce((s, c) => s + c.retrieval_text.length, 0) / chunks.length
  );

  console.log(`\n✅ Created ${chunks.length} chunks`);
  console.log(`   With extracted diagnosis: ${withDiagnosis} (${Math.round((withDiagnosis / chunks.length) * 100)}%)`);
  console.log(`   With structured age:      ${withAge} (${Math.round((withAge / chunks.length) * 100)}%)`);
  console.log(`   With structured gender:   ${withGender} (${Math.round((withGender / chunks.length) * 100)}%)`);
  console.log(`   Avg retrieval text length: ${avgTextLen} chars`);

  // ── Step 5: Save ───────────────────────────────────────────────────────────
  mkdirSync("data/processed", { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(chunks, null, 2));
  console.log(`\n📁 Saved → ${OUTPUT_PATH}`);

  // ── Step 6: Sample ─────────────────────────────────────────────────────────
  const s = chunks[0];
  console.log("\n── Sample chunk ──────────────────────────────────────────────");
  console.log(`ID:        ${s.id}`);
  console.log(`PMID:      ${s.pmid}`);
  console.log(`Age:       ${s.age_text || "(not recorded)"}`);
  console.log(`Gender:    ${s.gender_text || "(not recorded)"}`);
  console.log(`Diagnosis: ${s.diagnosis || "(not extracted)"}`);
  console.log(`Retrieval text:\n${s.retrieval_text.slice(0, 400)}...`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("\nNext step: npx tsx scripts/embedAndStore.ts");
})();