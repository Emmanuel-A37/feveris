// lib/bioner.ts
// BioNER via HuggingFace Inference API — no local model, no ONNX conversion needed.
// d4data/biomedical-ner-all supports hosted inference directly.
// Requires HF_TOKEN in .env.local (Read token is sufficient).

import { performance } from "node:perf_hooks";

export interface ExtractedEntities {
  symptoms: string[];
  diseases_mentioned: string[];
  medications: string[];
  demographics: { age?: string; sex?: string };
  temporal_info: Array<{ type: string; value: string }>;
  severity_markers: string[];
  /**
   * Travel/exposure/occupational-environmental risk context — e.g. "Nigeria"
   * (Nonbiological_location) or "traveled" (Activity). Fed into
   * query_summary, which previously had NO way to surface this at all: none
   * of the other slots above ever captured it, even though it's often the
   * single most discriminating detail for a febrile-disease differential
   * (a malaria case's retrieval query with "fever, headache, splenomegaly"
   * and no mention of West Africa is missing exactly what makes it malaria).
   * Populated using MIN_SCORE_EXPOSURE, a separate and lower confidence
   * floor than every other slot — see that constant's comment for why.
   */
  exposure_context: string[];
  all_entities: Array<{ text: string; type: string; confidence: number }>;
  /**
   * Entities that were detected but appeared right after a negation cue
   * ("no", "not", "without", "denies", "denied", "negative for", "ruled
   * out") in the source text — e.g. "no rash", "not on antibiotics".
   * These are excluded from every positive slot above (and therefore from
   * query_summary / RAG retrieval / the assessment prompt) but kept here
   * so they're still visible rather than silently dropped.
   */
  negated_entities: Array<{ text: string; type: string; confidence: number }>;
  query_summary: string;
}

// Shape returned by the HuggingFace Inference API for token-classification
interface HFEntity {
  entity_group: string;
  word: string;
  score: number;
  start: number;
  end: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATION DETECTION
// ─────────────────────────────────────────────────────────────────────────────

const NEGATION_CUE_REGEX = /\b(no|not|without|denies|denied|negative for|ruled out)\b/i;

/** How many characters before an entity's start offset to scan for a negation cue. */
const NEGATION_WINDOW_CHARS = 45;

/**
 * Lightweight negation check: looks at the text immediately preceding an
 * entity (within NEGATION_WINDOW_CHARS) for a negation cue word/phrase.
 * The window is clipped at the nearest preceding sentence boundary (". ")
 * so a cue in an earlier sentence — e.g. "no rash. Not on prophylaxis" —
 * can't bleed across into the next sentence's entities.
 *
 * This is intentionally simple (character-window + regex, not real
 * dependency parsing) — it will miss negation scopes that don't fit this
 * pattern (e.g. "ruled out" appearing after the entity instead of before),
 * but it catches the common clinical phrasing patterns this app's test
 * cases actually use.
 */
function isNegated(text: string, entityStart: number): boolean {
  const windowStart = Math.max(0, entityStart - NEGATION_WINDOW_CHARS);
  let window = text.slice(windowStart, entityStart);

  const sentenceBoundary = window.lastIndexOf(". ");
  if (sentenceBoundary !== -1) {
    window = window.slice(sentenceBoundary + 2);
  }

  return NEGATION_CUE_REGEX.test(window);
}

const HF_API_URL =
  "https://router.huggingface.co/hf-inference/models/d4data/biomedical-ner-all";

// Minimum confidence score — entities below this are noise
const MIN_SCORE = 0.75;

/**
 * Separate, lower confidence floor used ONLY for Nonbiological_location and
 * Activity entity types (travel/exposure/occupational-environmental risk
 * context — see ExtractedEntities.exposure_context).
 *
 * Why lower, not the shared 0.75 floor everyone else uses: live data from
 * this repo's own Phase 2 investigation showed these two entity types score
 * systematically lower than clinical findings even when they're exactly
 * right — not because the signal is less reliable when it does fire, but
 * because this NER model fragments/tokenizes place names and travel
 * phrasing worse than symptom/disease vocabulary (which dominates its
 * training data). Concrete motivating example: in TC001's real extraction,
 * "nigeria" (Nonbiological_location) scored 0.34 — comfortably above noise,
 * but well under MIN_SCORE=0.75 — and was silently discarded, even though
 * "returned from Nigeria" is exactly the epidemiological detail a malaria
 * differential most needs and none of the other 7 slots would ever have
 * captured it anyway. 0.3 is set just under that real observed score so
 * this specific, already-verified case is rescued, while still filtering
 * out genuine noise (e.g. "5 days" mis-tagged Activity at 0.18, also seen
 * in the same dataset, correctly stays excluded).
 */
const MIN_SCORE_EXPOSURE = 0.3;

/**
 * Calls the HuggingFace Inference API for d4data/biomedical-ner-all.
 * Returns raw entity array. Handles model loading delays (503) with retry.
 */
async function callInferenceAPI(text: string): Promise<HFEntity[]> {
  const token = process.env.HF_TOKEN;
  if (!token) {
    throw new Error("HF_TOKEN not found in environment. Add it to .env.local");
  }

  const MAX_RETRIES = 3;
  const callStart = performance.now();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const attemptStart = performance.now();
    const res = await fetch(HF_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // "first" over "simple": live comparison across "simple"/"first"/
        // "max"/"average" (evaluation/testAggregationStrategies.ts) showed
        // "simple" fragments multi-token clinical terms into WordPiece
        // sub-tokens ("sp"/"##len"/"##omegaly" instead of "splenomegaly")
        // on every fragmentation case tested; "first" was the only strategy
        // that merged cleanly AND kept confidence high (0.99-1.00) — "max"
        // was inconsistent (missed "jaundice" entirely) and "average" merged
        // correctly but dropped confidence to 0.55-0.68, right at risk of
        // falling under this file's own MIN_SCORE=0.75 floor.
        inputs: text,
        parameters: { aggregation_strategy: "first" },
      }),
    });
    const attemptMs = Math.round(performance.now() - attemptStart);

    // 503 means the model is loading on HuggingFace's servers — wait and retry
    if (res.status === 503) {
      console.log(`[BioNER timing] attempt ${attempt}/${MAX_RETRIES} — 503 cold-start after ${attemptMs}ms`);
      if (attempt < MAX_RETRIES) {
        console.log(`[BioNER] Model loading on HF servers, retrying in 3s... (attempt ${attempt}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw new Error("BioNER model timed out loading on HuggingFace. Try again in 30 seconds.");
    }

    if (!res.ok) {
      const body = await res.text();
      console.log(`[BioNER timing] attempt ${attempt}/${MAX_RETRIES} — HTTP ${res.status} (error) after ${attemptMs}ms`);
      throw new Error(`BioNER API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const totalMs = Math.round(performance.now() - callStart);
    console.log(`[BioNER timing] attempt ${attempt}/${MAX_RETRIES} — OK, ${attemptMs}ms this attempt, ${totalMs}ms total${attempt > 1 ? " (included retry delay)" : ""}`);

    const data = await res.json();

    // API returns array directly for token-classification
    if (!Array.isArray(data)) {
      throw new Error(`Unexpected BioNER response shape: ${JSON.stringify(data).slice(0, 200)}`);
    }

    return data as HFEntity[];
  }

  return [];
}

/**
 * Extracts and structures clinical entities from a text string.
 * Maps d4data/biomedical-ner-all entity labels to FEVERIS clinical slots.
 *
 * Entity labels from this model use exact casing — checked case-insensitively.
 * Full label list: https://huggingface.co/d4data/biomedical-ner-all
 */
export async function extractClinicalEntities(text: string): Promise<ExtractedEntities> {
  const out: ExtractedEntities = {
    symptoms: [],
    diseases_mentioned: [],
    medications: [],
    demographics: {},
    temporal_info: [],
    severity_markers: [],
    exposure_context: [],
    all_entities: [],
    negated_entities: [],
    query_summary: "",
  };

  if (!text.trim()) return out;

  const raw = await callInferenceAPI(text);

  for (const ent of raw) {
    if (!ent.entity_group || !ent.word) continue;

    const word = ent.word.trim();
    const score = ent.score ?? 0;
    const type = ent.entity_group; // preserve original casing for all_entities
    const lower = type.toLowerCase();

    // Travel/exposure entities use a lower confidence floor than everything
    // else — see MIN_SCORE_EXPOSURE's comment for why.
    const isExposureType = lower.includes("nonbiological_location") || lower.includes("activity");
    const threshold = isExposureType ? MIN_SCORE_EXPOSURE : MIN_SCORE;

    if (score < threshold || !word) continue;

    // Negated mentions ("no rash", "not on antibiotics", "without X",
    // "denies X", "no recent travel") are recorded separately and never
    // enter a positive slot, all_entities, or query_summary — so they can't
    // be treated as a positive finding by retrieval or the assessment prompt.
    if (isNegated(text, ent.start)) {
      out.negated_entities.push({
        text: word,
        type,
        confidence: Math.round(score * 1000) / 1000,
      });
      continue;
    }

    out.all_entities.push({
      text: word,
      type,
      confidence: Math.round(score * 1000) / 1000,
    });

    if (isExposureType) {
      out.exposure_context.push(word);
      continue;
    }

    // Map entity_group labels to clinical slots
    // d4data model uses labels like "Sign_symptom", "Disease_disorder", etc.
    if (lower.includes("sign_symptom") || lower.includes("symptom")) {
      out.symptoms.push(word);
    } else if (lower.includes("disease") || lower.includes("disorder")) {
      out.diseases_mentioned.push(word);
    } else if (lower.includes("medication") || lower.includes("drug") || lower.includes("chemical")) {
      out.medications.push(word);
    } else if (lower.includes("age")) {
      out.demographics.age = word;
    } else if (lower.includes("sex") || lower.includes("gender")) {
      out.demographics.sex = word;
    } else if (lower.includes("date") || lower.includes("duration") || lower.includes("frequency") || lower.includes("time")) {
      out.temporal_info.push({ type, value: word });
    } else if (lower.includes("severity") || lower.includes("degree")) {
      out.severity_markers.push(word);
    }
  }

  // ── Deterministic fallback: demographics.sex ────────────────────────────
  // The model missed this in 5/20 real test cases despite "male"/"female"
  // being explicit in the text (see FEVERIS_IMPLEMENTATION_NOTES.md's BioNER
  // worksheet) — this is simple enough to catch without relying on the
  // model at all, so we do, but only as a fallback (never overrides a real
  // Sex-type entity the model did find).
  if (!out.demographics.sex) {
    const sexMatch = text.match(/\b(male|female|man|woman|boy|girl)\b/i);
    if (sexMatch && sexMatch.index !== undefined && !isNegated(text, sexMatch.index)) {
      out.demographics.sex = sexMatch[1].toLowerCase();
    }
  }

  // ── Deterministic fallback: "pain"/"ache"/"tenderness" after a body part ─
  // Confirmed via live testing (evaluation/testAggregationStrategies.ts)
  // that "calf pain", "chest pain" etc. losing the pain word entirely is
  // NOT an aggregation_strategy artifact — the model emits no entity at all
  // for the pain word under ANY strategy tested (simple/first/max/average),
  // not even a low-confidence one, so there is nothing to recover by
  // stitching adjacent tokens together (the original hypothesis for this
  // gap). This scans the raw text directly instead. Only adds the phrase
  // if the pain-word isn't already covered by something the model DID
  // capture (e.g. "joint pain" in other cases is captured fine as-is).
  const PAIN_SUFFIX_REGEX = /\b([a-z]+)\s+(pain|ache|aches|tenderness)\b/gi;
  let painMatch: RegExpExecArray | null;
  while ((painMatch = PAIN_SUFFIX_REGEX.exec(text)) !== null) {
    const suffixWord = painMatch[2].toLowerCase();
    const alreadyCaptured = out.symptoms.some((s) => s.toLowerCase().includes(suffixWord));
    if (!alreadyCaptured && !isNegated(text, painMatch.index)) {
      out.symptoms.push(painMatch[0].toLowerCase());
    }
  }

  // Build RAG query summary from structured output
  const parts: string[] = [];
  if (out.demographics.age) parts.push(`Age: ${out.demographics.age}`);
  if (out.demographics.sex) parts.push(`Sex: ${out.demographics.sex}`);
  if (out.symptoms.length)
    parts.push(`Symptoms: ${[...new Set(out.symptoms)].join(", ")}`);
  if (out.diseases_mentioned.length)
    parts.push(`Conditions: ${[...new Set(out.diseases_mentioned)].join(", ")}`);
  const durations = out.temporal_info
    .filter(t => t.type.toLowerCase().includes("duration"))
    .map(t => t.value);
  if (durations.length) parts.push(`Duration: ${durations.join(", ")}`);
  if (out.severity_markers.length)
    parts.push(`Severity: ${[...new Set(out.severity_markers)].join(", ")}`);
  if (out.exposure_context.length)
    parts.push(`Exposure/Travel: ${[...new Set(out.exposure_context)].join(", ")}`);

  out.query_summary = parts.length ? parts.join(". ") : text.slice(0, 400);

  return out;
}

/**
 * Builds a cumulative patient profile from all clinician turns in a conversation.
 * Aggregates entities across turns for a complete picture at assessment time.
 */
export async function buildPatientProfile(
  history: Array<{ role: string; content: string }>
): Promise<ExtractedEntities> {
  // Concatenate all clinician (user) turns into one text block
  const clinicianText = history
    .filter(m => m.role === "user")
    .map(m => m.content)
    .join(". ");

  return extractClinicalEntities(clinicianText);
}