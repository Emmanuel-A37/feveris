/**
 * Re-scores a saved runEval.ts log without any API calls.
 *
 * Usage: npx tsx evaluation/rescore.ts [path-to-log]
 * Default log: evaluation/results/final-20case-run.log
 *
 * Prints three figures:
 *   - Whole-text match: the harness's own "Top-1" (read from the log's mark,
 *     because the full assessment text is not saved for every case).
 *   - First-differential match: expected_top_1 appears in differential #1.
 *     This is the Top-1 reported in the paper.
 *   - Top-3: expected_top_1 appears in any of the three parsed differentials.
 * Matching is the same case-insensitive substring rule runEval.ts uses.
 */
import fs from "fs";
import path from "path";

interface TC {
  id: string;
  disease: string;
  expected_top_1: string;
}

interface LoggedCase {
  id: string;
  wholeText: boolean | null;
  loggedTop3: boolean | null;
  differentials: string[];
  error: boolean;
}

const logPath = process.argv[2] ?? path.join(__dirname, "results", "final-20case-run.log");
const testCases: TC[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "testCases.json"), "utf8")
);
const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);

const logged = new Map<string, LoggedCase>();
let current: LoggedCase | null = null;

for (const line of lines) {
  const header = line.match(/^(TC\d+) \(.*\)\.\.\./);
  if (header) {
    current = { id: header[1], wholeText: null, loggedTop3: null, differentials: [], error: false };
    logged.set(current.id, current);
    if (/ERROR/.test(line)) current.error = true;
    continue;
  }
  if (!current) continue;

  const top1 = line.match(/^Top-1: (✅|❌)/);
  if (top1) current.wholeText = top1[1] === "✅";

  const top3 = line.match(/^\s+Top-3: (✅|❌) \| Differentials: (.*)$/);
  if (top3) {
    current.loggedTop3 = top3[1] === "✅";
    current.differentials = top3[2].startsWith("(none parsed)")
      ? []
      : top3[2].split(" | ").map((d) => d.trim());
  }
}

const hit = (expected: string, name: string) => name.toLowerCase().includes(expected.toLowerCase());

const failWhole: string[] = [];
const failFirst: string[] = [];
const failTop3: string[] = [];
const mismatches: string[] = [];
let scored = 0;

for (const tc of testCases) {
  const c = logged.get(tc.id);
  if (!c || c.error || c.wholeText === null) continue;
  scored++;

  if (!c.wholeText) failWhole.push(tc.id);
  if (!(c.differentials.length > 0 && hit(tc.expected_top_1, c.differentials[0]))) failFirst.push(tc.id);

  const top3 = c.differentials.some((d) => hit(tc.expected_top_1, d));
  if (!top3) failTop3.push(tc.id);
  if (c.loggedTop3 !== null && c.loggedTop3 !== top3) mismatches.push(tc.id);
}

const fmt = (fails: string[]) => {
  const n = scored - fails.length;
  return `${n}/${scored} (${((n / scored) * 100).toFixed(1)}%)  failing: ${fails.length ? fails.join(", ") : "none"}`;
};

console.log(`Log: ${path.relative(process.cwd(), logPath)}  (${scored} cases scored of ${testCases.length})`);
console.log(`Whole-text match (harness "Top-1"): ${fmt(failWhole)}`);
console.log(`First-differential match (paper Top-1): ${fmt(failFirst)}`);
console.log(`Top-3 (parsed differential names):  ${fmt(failTop3)}`);
if (mismatches.length) {
  console.log(`Note: recomputed Top-3 differs from the logged mark for: ${mismatches.join(", ")}`);
}
