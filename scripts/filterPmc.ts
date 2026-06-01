/**
 * scripts/filterPmc.ts
 * ====================
 * Reads a manually downloaded PMC-Patients-V2 JSON file using a stream
 * to avoid Node.js's ~512MB string length limit (ERR_STRING_TOO_LONG).
 *
 * Run with: npx tsx scripts/filterPmc.ts
 *
 * BEFORE RUNNING:
 *   1. Download from https://huggingface.co/datasets/zhengyun21/PMC-Patients-V2/tree/main
 *   2. Save to: data/raw/PMC-Patients-V2.json
 *   3. Ensure data/raw/ is in your .gitignore
 *
 * Output: data/raw/febrile_cases.json
 * Next:   npx tsx scripts/chunkCases.ts
 */

import { createReadStream, writeFileSync, mkdirSync, existsSync } from "fs";
import { createInterface } from "readline";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_PATH = "data/raw/PMC-Patients-V2.json";
const OUTPUT_PATH = "data/raw/febrile_cases.json";
const TARGET_FEBRILE_CASES = 3000;
const MIN_TEXT_LENGTH = 200;

const FEBRILE_KEYWORDS = [
  "fever", "febrile", "pyrexia", "hyperthermia",
  "malaria", "dengue", "typhoid", "influenza", "sepsis",
  "leptospirosis", "meningitis", "encephalitis", "rickettsia",
  "brucellosis", "chikungunya", "yellow fever", "trypanosomiasis",
  "visceral leishmaniasis", "high-grade fever", "low-grade fever",
  "intermittent fever", "remittent fever", "continuous fever",
  "febrile illness", "febrile episode", "fever of unknown origin",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface PMCRawCase {
  patient_uid: string;
  PMID: string;
  title: string;
  patient: string;
  age: Array<[number, string]> | null;
  gender: "M" | "F" | null;
  [key: string]: unknown;
}

export interface FilteredCase {
  patient_uid: string;
  PMID: string;
  title: string;
  patient: string;
  age_text: string;
  gender_text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function parseAge(age: Array<[number, string]> | null): string {
  if (!age || age.length === 0) return "";
  return age
    .map(([value, unit]) => {
      const v = Math.round(value * 10) / 10;
      return `${v} ${unit}${v !== 1 ? "s" : ""}`;
    })
    .join(" ");
}

function isFebrile(text: string): boolean {
  const lower = text.toLowerCase();
  return FEBRILE_KEYWORDS.some((kw) => lower.includes(kw));
}

function toFilteredCase(row: PMCRawCase): FilteredCase {
  return {
    patient_uid: row.patient_uid,
    PMID: row.PMID ?? "",
    title: row.title ?? "",
    patient: row.patient,
    age_text: parseAge(row.age),
    gender_text:
      row.gender === "M" ? "Male" : row.gender === "F" ? "Female" : "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STREAMING PARSER
//
// The PMC-Patients-V2 JSON file is a single large array: [{...}, {...}, ...]
// It is too large to read into memory as a string.
//
// Strategy: stream the file character by character, accumulate individual
// JSON objects between { } boundaries, parse each one independently.
// This keeps memory usage flat regardless of file size.
// ─────────────────────────────────────────────────────────────────────────────

async function streamFilterFebrile(filePath: string): Promise<FilteredCase[]> {
  return new Promise((resolve, reject) => {
    const filtered: FilteredCase[] = [];
    let buffer = "";
    let depth = 0;
    let inString = false;
    let escape = false;
    let scanned = 0;
    let started = false; // true once we've seen the first {

    const stream = createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 64 * 1024, // 64KB chunks — memory efficient
    });

    stream.on("data", (chunk: string) => {
      // Stop reading if we already have enough cases
      if (filtered.length >= TARGET_FEBRILE_CASES) {
        stream.destroy();
        return;
      }

      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];

        // Track string boundaries so we don't mistake { inside strings for depth
        if (escape) {
          escape = false;
          if (depth > 0) buffer += ch;
          continue;
        }
        if (ch === "\\" && inString) {
          escape = true;
          if (depth > 0) buffer += ch;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          if (depth > 0) buffer += ch;
          continue;
        }

        if (inString) {
          if (depth > 0) buffer += ch;
          continue;
        }

        // Track object depth
        if (ch === "{") {
          depth++;
          started = true;
          buffer += ch;
          continue;
        }

        if (ch === "}") {
          buffer += ch;
          depth--;

          // depth === 0 means we just closed a top-level object
          if (depth === 0 && started) {
            scanned++;

            // Progress every 10k objects
            if (scanned % 10000 === 0) {
              process.stdout.write(
                `\r  Scanned: ${scanned.toLocaleString()} | Found: ${filtered.length}`
              );
            }

            try {
              const row = JSON.parse(buffer) as PMCRawCase;

              if (
                row.patient_uid &&
                row.patient &&
                row.patient.length >= MIN_TEXT_LENGTH &&
                isFebrile(row.patient)
              ) {
                filtered.push(toFilteredCase(row));
              }
            } catch {
              // Malformed object — skip silently and continue
            }

            buffer = "";
          }
          continue;
        }

        // Accumulate characters that are inside an object
        if (depth > 0) {
          buffer += ch;
        }
      }
    });

    stream.on("end", () => {
      process.stdout.write("\n");
      resolve(filtered);
    });

    stream.on("error", reject);

    stream.on("close", () => {
      // Triggered when we call stream.destroy() early (hit target)
      process.stdout.write("\n");
      resolve(filtered);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // Guard: file must exist
  if (!existsSync(INPUT_PATH)) {
    console.error(`
❌ File not found: ${INPUT_PATH}

Download the dataset:
  1. Go to https://huggingface.co/datasets/zhengyun21/PMC-Patients-V2/tree/main
  2. Download the JSON file (free HuggingFace account required)
  3. Save it to: ${INPUT_PATH}
  4. Run this script again
    `);
    process.exit(1);
  }

  console.log(`Reading ${INPUT_PATH} via stream (handles large files safely)...`);
  console.log(`Target: ${TARGET_FEBRILE_CASES} febrile cases\n`);

  const filtered = await streamFilterFebrile(INPUT_PATH);

  if (filtered.length === 0) {
    console.error(`
❌ No febrile cases found.

Possible issues:
  1. Wrong file downloaded — confirm it is PMC-Patients-V2
  2. JSON field for narrative text may not be "patient"
     Open the file and check the first object's keys
  3. Lower MIN_TEXT_LENGTH (currently ${MIN_TEXT_LENGTH}) if cases seem short
    `);
    process.exit(1);
  }

  // Stats
  const withAge = filtered.filter((c) => c.age_text !== "").length;
  const withGender = filtered.filter((c) => c.gender_text !== "").length;
  console.log(`✅ Febrile cases collected: ${filtered.length}`);
  console.log(`   Structured age:    ${withAge} (${Math.round((withAge / filtered.length) * 100)}%)`);
  console.log(`   Structured gender: ${withGender} (${Math.round((withGender / filtered.length) * 100)}%)`);

  // Save
  mkdirSync("data/raw", { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(filtered, null, 2));
  console.log(`\n📁 Saved → ${OUTPUT_PATH}`);

  // Sample
  const s = filtered[0];
  console.log("\n── Sample case ───────────────────────────────────────────────");
  console.log(`ID:     ${s.patient_uid}`);
  console.log(`PMID:   ${s.PMID}`);
  console.log(`Title:  ${s.title.slice(0, 80)}`);
  console.log(`Age:    ${s.age_text || "(not recorded)"}`);
  console.log(`Gender: ${s.gender_text || "(not recorded)"}`);
  console.log(`Text:   ${s.patient.slice(0, 300)}...`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("\nNext step: npx tsx scripts/chunkCases.ts");
})();