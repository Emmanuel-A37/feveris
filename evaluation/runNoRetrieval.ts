/**
 * evaluation/runNoRetrieval.ts
 * =============================
 * Ablation: the same 20 scripted cases as evaluation/runEval.ts, same model,
 * same system prompt, same temperature (all inherited by calling
 * lib/claude.ts directly), but with retrieval DISABLED. Assessment turns get
 * the exact "[No similar cases retrieved ...]" suffix that /api/chat already
 * uses when retrieval returns nothing (app/api/chat/route.ts
 * buildAugmentedMessages, empty-cases branch), so the prompt shape is the
 * one the production code already produces for the no-evidence case.
 *
 * Differences from runEval.ts, stated plainly:
 *   - Calls lib/claude.ts directly instead of going through /api/chat, so NO
 *     dev server, BioNER, or Supabase is needed (only ANTHROPIC_API_KEY).
 *   - Mirrors the /api/chat turn logic: a history turn that comes back with
 *     the assessment marker is discarded and regenerated (without evidence);
 *     agent.ts's explicit/auto triggers are not needed because the script
 *     sends "assess" after the five scripted turns exactly like runEval.ts.
 *   - The scoring functions below are COPIED VERBATIM from runEval.ts
 *     (parseDifferentials, scoreTop3, and the top1/test/format lines). If you
 *     change them there, change them here.
 *   - Saves every full assessment to results/no-retrieval-<timestamp>.json so
 *     it can be re-scored later without new API calls.
 *
 * Run (after npx tsx): npx tsx evaluation/runNoRetrieval.ts [--limit=N] [--case=TC001]
 * Requires: ANTHROPIC_API_KEY in .env.local
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.join(__dirname, "..", ".env.local") });

import { sendFeverisMessage } from "../lib/claude";
import { isAssessmentResponse } from "../lib/agent";

interface TC {
  id: string;
  disease: string;
  clinician_responses: string[];
  expected_top_1: string;
  expected_confirmatory_test: string;
}

type Msg = { role: "user" | "assistant"; content: string };

const NO_EVIDENCE_SUFFIX =
  "\n\n[No similar cases retrieved — generate assessment from clinical reasoning alone.]";

// Same init prompt as app/api/chat/route.ts.
const INIT_PROMPT =
  "Begin the consultation. Introduce yourself briefly and ask for the chief complaint. Do not repeat your introduction on subsequent turns.";

// ── Scoring: verbatim from evaluation/runEval.ts ────────────────────────────
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

function scoreTop3(expectedTop1: string, differentials: string[]): boolean {
  const expectedLower = expectedTop1.toLowerCase();
  return differentials.some((d) => d.toLowerCase().includes(expectedLower));
}

function scoreAssessment(tc: TC, assessment: string) {
  const lower = assessment.toLowerCase();
  const formatted = lower.includes("---feveris assessment---") && lower.includes("---end assessment---");
  const top1 = lower.includes(tc.expected_top_1.toLowerCase());
  const test = lower.includes(tc.expected_confirmatory_test.toLowerCase());
  const differentials = parseDifferentials(assessment);
  const top3 = scoreTop3(tc.expected_top_1, differentials);
  // Extra (not in runEval.ts): strict first-differential-only check.
  const first = differentials.length > 0 && differentials[0].toLowerCase().includes(tc.expected_top_1.toLowerCase());
  return { formatted, top1, test, differentials, top3, first };
}

async function runCase(tc: TC) {
  const t0 = Date.now();
  const messages: Msg[] = [];
  const generationSamples: number[] = [];
  let assessment = "";
  let endedBy: "spontaneous" | "forced-assess" = "forced-assess";

  try {
    const init = await sendFeverisMessage([{ role: "user", content: INIT_PROMPT }]);
    generationSamples.push(init.generationMs);
    messages.push({ role: "assistant", content: init.text });

    for (const resp of tc.clinician_responses) {
      messages.push({ role: "user", content: resp });
      const res = await sendFeverisMessage(messages);
      if (isAssessmentResponse(res.text)) {
        // Mirror /api/chat: discard the spontaneous assessment, regenerate
        // with the (empty) evidence block.
        const regen = await sendFeverisMessage([
          ...messages.slice(0, -1),
          { role: "user", content: resp + NO_EVIDENCE_SUFFIX },
        ]);
        generationSamples.push(regen.generationMs);
        assessment = regen.text;
        endedBy = "spontaneous";
        break;
      }
      generationSamples.push(res.generationMs);
      messages.push({ role: "assistant", content: res.text });
    }

    if (!assessment) {
      messages.push({ role: "user", content: "assess" });
      const res = await sendFeverisMessage([
        ...messages.slice(0, -1),
        { role: "user", content: "assess" + NO_EVIDENCE_SUFFIX },
      ]);
      generationSamples.push(res.generationMs);
      assessment = res.text;
    }
  } catch (err) {
    return { id: tc.id, disease: tc.disease, error: String((err as Error).message), ms: Date.now() - t0 };
  }

  return {
    id: tc.id,
    disease: tc.disease,
    expected: tc.expected_top_1,
    endedBy,
    ms: Date.now() - t0,
    generationSamples,
    assessment,
    ...scoreAssessment(tc, assessment),
  };
}

async function main() {
  const testCases: TC[] = JSON.parse(fs.readFileSync(path.join(__dirname, "testCases.json"), "utf8"));
  let cases = testCases;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--limit=")) cases = cases.slice(0, parseInt(arg.split("=")[1], 10));
    else if (arg.startsWith("--case=")) cases = testCases.filter((t) => t.id.toLowerCase() === arg.split("=")[1].toLowerCase());
  }

  console.log("=== FEVERIS No-Retrieval Ablation ===");
  console.log(`Running ${cases.length} cases (retrieval disabled).\n`);

  const results: Array<Awaited<ReturnType<typeof runCase>>> = [];
  for (const tc of cases) {
    process.stdout.write(`${tc.id} (${tc.disease})... `);
    const r = await runCase(tc);
    results.push(r);
    if ("error" in r) {
      console.log(`ERROR: ${r.error}`);
    } else {
      console.log(
        `Top-1: ${r.top1 ? "Y" : "N"} | Top-3: ${r.top3 ? "Y" : "N"} | First-dx: ${r.first ? "Y" : "N"} | ` +
          `Test: ${r.test ? "Y" : "N"} | Format: ${r.formatted ? "Y" : "N"} | ${r.ms}ms | ended by ${r.endedBy}`
      );
      console.log(`  Differentials: ${r.differentials.join(" | ") || "(none parsed)"}`);
    }
  }

  const ok = results.filter((r): r is Extract<typeof r, { assessment: string }> => "assessment" in r);
  const n = ok.length;
  if (n === 0) {
    console.log("\nAll runs errored.");
    return;
  }
  const pct = (k: number) => ((k / n) * 100).toFixed(1) + "%";
  const gen = ok.flatMap((r) => r.generationSamples);
  console.log(`
=== SUMMARY (no retrieval) ===
Cases Run:       ${n} / ${results.length}
Top-1 Accuracy:  ${pct(ok.filter((r) => r.top1).length)}   (whole-text, same rule as runEval.ts)
Top-3 Accuracy:  ${pct(ok.filter((r) => r.top3).length)}
First-dx only:   ${pct(ok.filter((r) => r.first).length)}   (strict; not in runEval.ts)
Test Mentioned:  ${pct(ok.filter((r) => r.test).length)}
Format OK:       ${pct(ok.filter((r) => r.formatted).length)}
Mean Generation-Call Latency: ${Math.round(gen.reduce((s, v) => s + v, 0) / gen.length)}ms (${gen.length} calls)
`);

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `no-retrieval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Saved full assessments -> ${outPath}`);
}

main().catch(console.error);
