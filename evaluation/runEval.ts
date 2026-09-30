import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = "http://localhost:3000";

interface TC {
  id: string;
  disease: string;
  clinician_responses: string[];
  expected_top_1: string;
  expected_confirmatory_test: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW METRIC HELPERS — Top-3 parsing, retrieval relevance, generation latency.
// These are additive: they don't touch the existing formatted/top1/test/ms
// scoring above or below, they just compute alongside it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieved-case shape as returned by /api/chat's `retrievedCases` field
 * (see lib/supabase.ts RetrievedCase / app/api/chat/route.ts RetrievedCase).
 * Only the fields used for relevance scoring/manual review are declared.
 */
interface RetrievedCaseLite {
  diagnosis: string;
  similarity: number;
  pmid?: string;
  title?: string;
}

interface RetrievalRelevanceRow {
  rank: number;
  retrievedDiagnosis: string;
  similarity: number;
  pmid: string;
  title: string;
  status: "exact_match" | "needs_manual_review";
}

/**
 * Parses up to three ranked differential-diagnosis names out of a FEVERIS
 * assessment response, per the numbered-list format defined in
 * FEVERIS_SYSTEM_PROMPT (lib/claude.ts):
 *   "1. [diagnosis] — Confidence: [High/Moderate/Low]"
 * Tolerant of optional markdown bold (**...**) around the diagnosis name,
 * and of em dash / en dash / hyphen before "Confidence:".
 */
function parseDifferentials(assessmentText: string): string[] {
  const pattern = /^\s{0,3}[1-3]\.\s*\*{0,2}(.+?)\*{0,2}\s*[—–-]\s*Confidence\s*:/gim;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(assessmentText)) !== null) {
    const name = match[1].trim();
    if (name) names.push(name);
  }
  return names.slice(0, 3);
}

/**
 * Top-3 hit: true if the expected diagnosis string appears anywhere in the
 * (up to three) parsed differential names, not just position 1 — same
 * case-insensitive substring rule the existing top1 check already uses,
 * just applied to the whole list instead of position 1 only.
 */
function scoreTop3(expectedTop1: string, differentials: string[]): boolean {
  const expectedLower = expectedTop1.toLowerCase();
  return differentials.some((d) => d.toLowerCase().includes(expectedLower));
}

/**
 * Scores up to three retrieved cases against the expected diagnosis.
 * Exact matches are auto-scored via case-insensitive substring containment
 * (either direction, since retrieved `diagnosis` text is often longer/more
 * specific than the short expected_top_1 string, e.g. "plasmodium
 * falciparum malaria" vs "malaria"). Anything that isn't a clean substring
 * match — including an empty/unextracted diagnosis field — is deliberately
 * NOT auto-judged as adjacent-or-not; it's flagged for manual review instead.
 */
function scoreRetrievalRelevance(
  expectedTop1: string,
  cases: RetrievedCaseLite[]
): RetrievalRelevanceRow[] {
  const expectedLower = expectedTop1.toLowerCase();
  return cases.slice(0, 3).map((c, i) => {
    const docLower = (c.diagnosis || "").trim().toLowerCase();
    const isExact =
      docLower.length > 0 &&
      (docLower.includes(expectedLower) || expectedLower.includes(docLower));
    return {
      rank: i + 1,
      retrievedDiagnosis: c.diagnosis?.trim() || "(no diagnosis extracted)",
      similarity: c.similarity,
      pmid: c.pmid || "",
      title: c.title || "",
      status: isExact ? "exact_match" : "needs_manual_review",
    };
  });
}

interface ConversationState {
  sessionId: string;
  agentState: "GREETING" | "HISTORY_TAKING" | "ASSESSING" | "COMPLETE";
  turnCount: number;
  activeHypotheses: string[];
  accumulatedSymptoms: string[];
  accumulatedDiseases: string[];
  accumulatedTemporalInfo: Array<{ type: string; value: string }>;
  demographics: { age?: string; sex?: string };
  createdAt: string;
  lastActivityAt: string;
}

// Load test cases
const testCasesPath = path.join(__dirname, "testCases.json");
const testCases: TC[] = JSON.parse(fs.readFileSync(testCasesPath, "utf8"));

async function runCase(tc: TC, verbose = false) {
  const t0 = Date.now();
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  let state: ConversationState | undefined;

  // New-metric accumulators — additive, don't affect existing scoring below.
  const generationSamples: number[] = [];
  let retrievedCases: RetrievedCaseLite[] = [];

  try {
    // 1. Initialise session (greeting)
    const initRes = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        isInit: true
      }),
    });

    if (!initRes.ok) {
      throw new Error(`Init failed: ${initRes.status} ${await initRes.text()}`);
    }

    const initData = await initRes.json();
    state = initData.sessionState;
    messages.push({ role: "assistant", content: initData.response });
    if (typeof initData.generationMs === "number") generationSamples.push(initData.generationMs);
  } catch (err: any) {
    return {
      id: tc.id,
      disease: tc.disease,
      formatted: false,
      top1: false,
      test: false,
      ms: Date.now() - t0,
      top3: false,
      differentials: [] as string[],
      generationSamples,
      retrieval: [] as RetrievalRelevanceRow[],
      error: `Init error: ${err.message}`
    };
  }

  let assessment = "";

  // 2. Play clinician responses turn-by-turn
  for (const resp of tc.clinician_responses) {
    messages.push({ role: "user", content: resp });

    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, sessionState: state }),
      });

      if (!res.ok) {
        throw new Error(`Chat API error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      messages.push({ role: "assistant", content: data.response });
      state = data.sessionState;
      if (typeof data.generationMs === "number") generationSamples.push(data.generationMs);

      if (data.isAssessment) {
        assessment = data.response;
        retrievedCases = Array.isArray(data.retrievedCases) ? data.retrievedCases : [];
        break;
      }
    } catch (err: any) {
      return {
        id: tc.id,
        disease: tc.disease,
        formatted: false,
        top1: false,
        test: false,
        ms: Date.now() - t0,
        top3: false,
        differentials: [] as string[],
        generationSamples,
        retrieval: [] as RetrievalRelevanceRow[],
        error: `Chat error: ${err.message}`
      };
    }
  }

  // 3. Force assessment if not auto-triggered
  if (!assessment) {
    messages.push({ role: "user", content: "assess" });
    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, sessionState: state }),
      });

      if (!res.ok) {
        throw new Error(`Assessment API error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      assessment = data.response;
      if (typeof data.generationMs === "number") generationSamples.push(data.generationMs);
      retrievedCases = Array.isArray(data.retrievedCases) ? data.retrievedCases : [];
    } catch (err: any) {
      return {
        id: tc.id,
        disease: tc.disease,
        formatted: false,
        top1: false,
        test: false,
        ms: Date.now() - t0,
        top3: false,
        differentials: [] as string[],
        generationSamples,
        retrieval: [] as RetrievalRelevanceRow[],
        error: `Force assessment error: ${err.message}`
      };
    }
  }

  if (verbose) {
    console.log(`\n--- CONVERSATION TRANSCRIPT (${tc.id}) ---`);
    for (const msg of messages) {
      console.log(`[${msg.role.toUpperCase()}]: ${msg.content}`);
    }
    console.log("-----------------------------------------\n");
  }

  const lower = assessment.toLowerCase();
  const formatted = lower.includes("---feveris assessment---") && lower.includes("---end assessment---");
  const top1 = lower.includes(tc.expected_top_1.toLowerCase());
  const test = lower.includes(tc.expected_confirmatory_test.toLowerCase());

  // New metrics — computed alongside the existing ones above, untouched.
  const differentials = parseDifferentials(assessment);
  const top3 = scoreTop3(tc.expected_top_1, differentials);
  const retrieval = scoreRetrievalRelevance(tc.expected_top_1, retrievedCases);

  return {
    id: tc.id,
    disease: tc.disease,
    formatted,
    top1,
    test,
    ms: Date.now() - t0,
    top3,
    differentials,
    generationSamples,
    retrieval,
  };
}

async function main() {
  console.log("=== FEVERIS Evaluation Suite ===");

  // Simple CLI argument parsing
  const args = process.argv.slice(2);
  let limit: number | undefined;
  let caseId: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.split("=")[1], 10);
    } else if (arg === "-l" && i + 1 < args.length) {
      limit = parseInt(args[++i], 10);
    } else if (arg.startsWith("--case=")) {
      caseId = arg.split("=")[1];
    } else if (arg === "-c" && i + 1 < args.length) {
      caseId = args[++i];
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx evaluation/runEval.ts [options]
Options:
  --limit=<n>, -l <n>   Limit run to first <n> test cases
  --case=<id>, -c <id>   Run only test case with ID <id> (e.g. TC001)
  --verbose, -v         Print full conversation transcripts and assessments
  --help, -h            Show this help message`);
      return;
    }
  }

  let casesToRun = testCases;
  if (caseId) {
    casesToRun = testCases.filter(tc => tc.id.toLowerCase() === caseId.toLowerCase());
    if (casesToRun.length === 0) {
      console.log(`❌ Error: Test case '${caseId}' not found.`);
      return;
    }
  } else if (limit !== undefined) {
    if (isNaN(limit) || limit <= 0) {
      console.log("❌ Error: Invalid limit value.");
      return;
    }
    casesToRun = testCases.slice(0, limit);
  }

  console.log(`Loaded ${testCases.length} total test cases.`);
  console.log(`Running ${casesToRun.length} selected test cases (verbose=${verbose}).\n`);

  const results = [];

  for (const tc of casesToRun) {
    process.stdout.write(`${tc.id} (${tc.disease})... `);
    const r = await runCase(tc, verbose);
    results.push(r);
    if (r.error) {
      console.log(`❌ ERROR: ${r.error}`);
    } else {
      console.log(`Top-1: ${r.top1 ? "✅" : "❌"} | Test: ${r.test ? "✅" : "❌"} | Format: ${r.formatted ? "✅" : "❌"} | ${r.ms}ms`);

      // ── New metrics (additive — printed separately from the line above) ──
      const genCount = r.generationSamples.length;
      const genMean = genCount > 0
        ? Math.round(r.generationSamples.reduce((s, v) => s + v, 0) / genCount)
        : null;
      console.log(
        `  Top-3: ${r.top3 ? "✅" : "❌"}` +
        (r.differentials.length > 0 ? ` | Differentials: ${r.differentials.join(" | ")}` : " | Differentials: (none parsed)")
      );
      console.log(
        `  Generation calls this case: ${genCount}` +
        (genMean !== null ? ` (mean ${genMean}ms)` : " (no successful Claude calls — all fallback)")
      );
      if (r.retrieval.length === 0) {
        console.log(`  Retrieval: no retrieved cases captured for this case`);
      } else {
        const exactCount = r.retrieval.filter(row => row.status === "exact_match").length;
        console.log(`  Retrieval (${r.retrieval.length} cases, expected: "${tc.expected_top_1}"): ${exactCount} exact match / ${r.retrieval.length - exactCount} needs manual review`);
        for (const row of r.retrieval) {
          const mark = row.status === "exact_match" ? "✅ exact match" : "⚠️  needs manual adjacency review";
          const ref = row.pmid ? ` pmid=${row.pmid}` : "";
          console.log(`    [${row.rank}] sim=${row.similarity.toFixed(2)}${ref} dx="${row.retrievedDiagnosis}" → ${mark}`);
        }
      }
    }
  }

  const n = results.length;
  const validResults = results.filter(r => !r.error);
  const vN = validResults.length;

  if (vN === 0) {
    console.log("\n❌ All evaluation runs encountered errors.");
    return;
  }

  const top1Count = validResults.filter(r => r.top1).length;
  const testCount = validResults.filter(r => r.test).length;
  const formatCount = validResults.filter(r => r.formatted).length;
  const avgLatency = Math.round(validResults.reduce((s, r) => s + r.ms, 0) / vN);

  console.log(`
=== SUMMARY ===
Cases Run:       ${vN} / ${n}
Top-1 Accuracy:  ${(top1Count / vN * 100).toFixed(1)}%  (target >= 60%)
Test Mentioned:  ${(testCount / vN * 100).toFixed(1)}%  (target >= 80%)
Format OK:       ${(formatCount / vN * 100).toFixed(1)}%  (target 100%)
Avg Latency:     ${avgLatency}ms      (target < 3000ms)
`);

  // ── New metrics summary (additive — everything above this point is untouched) ──
  const top3Count = validResults.filter(r => r.top3).length;

  const allGenSamples = validResults.flatMap(r => r.generationSamples);
  const meanGenLatency = allGenSamples.length > 0
    ? Math.round(allGenSamples.reduce((s, v) => s + v, 0) / allGenSamples.length)
    : null;

  const allRetrievalRows = validResults.flatMap(r =>
    r.retrieval.map(row => ({ ...row, caseId: r.id, expected: casesToRun.find(tc => tc.id === r.id)?.expected_top_1 ?? "" }))
  );
  const exactRows = allRetrievalRows.filter(row => row.status === "exact_match");
  const manualReviewRows = allRetrievalRows.filter(row => row.status === "needs_manual_review");
  const retrievalRelevancePct = allRetrievalRows.length > 0
    ? (exactRows.length / allRetrievalRows.length * 100)
    : null;

  console.log(`=== NEW METRICS (this session's additions) ===
Top-3 Accuracy:              ${(top3Count / vN * 100).toFixed(1)}%  (target >= 80%)  [${top3Count}/${vN} cases]
Mean Generation-Call Latency: ${meanGenLatency !== null ? meanGenLatency + "ms" : "n/a (no successful Claude calls captured)"}  (single Claude API call only — anthropic.messages.create(), not the whole-case timer above; ${allGenSamples.length} calls measured)
Retrieval Relevance (exact): ${retrievalRelevancePct !== null ? retrievalRelevancePct.toFixed(1) + "%" : "n/a (no retrieved cases captured)"}  (target >= 70%)  [${exactRows.length}/${allRetrievalRows.length} retrieved-case slots]
Needs Manual Adjacency Review: ${manualReviewRows.length} retrieved-case slot(s) across ${new Set(manualReviewRows.map(r => r.caseId)).size} case(s) — see MANUAL REVIEW QUEUE below
`);

  if (manualReviewRows.length > 0) {
    console.log("=== MANUAL REVIEW QUEUE (retrieval relevance — not auto-scored) ===");
    console.log("These were NOT counted as matches or non-matches automatically — review by hand and judge clinical adjacency yourself.\n");
    for (const row of manualReviewRows) {
      const ref = row.pmid ? `pmid=${row.pmid}` : "pmid=(none)";
      const titlePart = row.title ? ` — "${row.title}"` : "";
      console.log(`${row.caseId} (expected: "${row.expected}") — retrieved rank ${row.rank}, similarity ${row.similarity.toFixed(2)}, ${ref}${titlePart}`);
      console.log(`  Retrieved diagnosis: "${row.retrievedDiagnosis}"\n`);
    }
  }
}

main().catch(console.error);
