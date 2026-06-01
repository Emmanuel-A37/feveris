// lib/bioner.ts
// BioNER via HuggingFace Inference API — no local model, no ONNX conversion needed.
// d4data/biomedical-ner-all supports hosted inference directly.
// Requires HF_TOKEN in .env.local (Read token is sufficient).

export interface ExtractedEntities {
  symptoms: string[];
  diseases_mentioned: string[];
  medications: string[];
  demographics: { age?: string; sex?: string };
  temporal_info: Array<{ type: string; value: string }>;
  severity_markers: string[];
  all_entities: Array<{ text: string; type: string; confidence: number }>;
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

const HF_API_URL =
  "https://router.huggingface.co/hf-inference/models/d4data/biomedical-ner-all";

// Minimum confidence score — entities below this are noise
const MIN_SCORE = 0.75;

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

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(HF_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: text,
        parameters: { aggregation_strategy: "simple" },
      }),
    });

    // 503 means the model is loading on HuggingFace's servers — wait and retry
    if (res.status === 503) {
      if (attempt < MAX_RETRIES) {
        console.log(`[BioNER] Model loading on HF servers, retrying in 3s... (attempt ${attempt}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw new Error("BioNER model timed out loading on HuggingFace. Try again in 30 seconds.");
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`BioNER API error ${res.status}: ${body.slice(0, 200)}`);
    }

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
    all_entities: [],
    query_summary: "",
  };

  if (!text.trim()) return out;

  const raw = await callInferenceAPI(text);

  for (const ent of raw) {
    if (!ent.entity_group || !ent.word) continue;

    const word = ent.word.trim();
    const score = ent.score ?? 0;
    const type = ent.entity_group; // preserve original casing for all_entities

    if (score < MIN_SCORE || !word) continue;

    out.all_entities.push({
      text: word,
      type,
      confidence: Math.round(score * 1000) / 1000,
    });

    // Map entity_group labels to clinical slots
    // d4data model uses labels like "Sign_symptom", "Disease_disorder", etc.
    const lower = type.toLowerCase();

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