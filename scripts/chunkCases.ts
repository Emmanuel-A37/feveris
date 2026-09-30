/**
 * scripts/chunkCases.ts
 * =====================
 * Turns data/raw/febrile_cases.json (output of scripts/filterPmc.ts) into
 * retrieval chunks: data/processed/case_chunks.json. Uses every filtered
 * case (3,004 in the paper's run), no downsampling.
 *
 * Run with: npx tsx scripts/chunkCases.ts
 * Next:     npx tsx scripts/embedAndStore.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import type { FilteredCase } from "./filterPmc";
import { extractDiagnosis } from "./extractDiagnosis";

const INPUT_PATH = "data/raw/febrile_cases.json";
const OUTPUT_PATH = "data/processed/case_chunks.json";
const MAX_NARRATIVE_CHARS = 1000;

interface CaseChunk {
  id: string;
  retrieval_text: string;
  full_text: string;
  diagnosis: string;
  presenting_complaint: string;
  source: string;
  pmid: string;
  title: string;
  age_text: string;
  gender_text: string;
}

function buildRetrievalText(
  presentingComplaint: string,
  fullText: string,
  diagnosis: string,
  ageText: string,
  genderText: string
): string {
  const parts: string[] = [];
  if (ageText || genderText) {
    parts.push(`PATIENT: ${[genderText, ageText].filter(Boolean).join(", ")}`);
  }
  parts.push(`CLINICAL PRESENTATION: ${presentingComplaint}`);
  parts.push(`FULL CASE: ${fullText.slice(0, MAX_NARRATIVE_CHARS)}`);
  if (diagnosis) parts.push(`DIAGNOSIS: ${diagnosis}`);
  return parts.join("\n").trim();
}

(async () => {
  console.log(`Reading ${INPUT_PATH}...`);
  const raw: FilteredCase[] = JSON.parse(readFileSync(INPUT_PATH, "utf-8"));
  console.log(`Loaded ${raw.length} filtered cases`);

  const chunks: CaseChunk[] = raw.map((c) => {
    const presenting = c.patient.split(". ").slice(0, 2).join(". ").trim();
    const diagnosis = extractDiagnosis(c.patient);
    return {
      id: c.patient_uid,
      retrieval_text: buildRetrievalText(presenting, c.patient, diagnosis, c.age_text, c.gender_text),
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

  const withDiagnosis = chunks.filter((c) => c.diagnosis !== "").length;
  console.log(`Created ${chunks.length} chunks; with extracted diagnosis: ${withDiagnosis} (${Math.round((withDiagnosis / chunks.length) * 100)}%)`);

  mkdirSync("data/processed", { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(chunks, null, 2));
  console.log(`Saved -> ${OUTPUT_PATH}\nNext step: npx tsx scripts/embedAndStore.ts`);
})();
