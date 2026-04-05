import { EvalRun } from "./runner.js";

interface ComparisonStat {
  name: string;
  prevStatus: string;
  nextStatus: string;
  isRegression: boolean;
  isImprovement: boolean;
}

/**
 * Compare two eval runs and produce a readable text diff.
 */
export function compareRuns(prev: EvalRun, next: EvalRun): string {
  const lines: string[] = [];

  lines.push("📊 Eval Comparison");
  lines.push("");

  // Build a map of previous test results by name
  const prevMap = new Map(prev.tests.map((t) => [t.name, t.status]));
  const nextMap = new Map(next.tests.map((t) => [t.name, t.status]));

  // Compare test results
  const allTestNames = new Set([...prevMap.keys(), ...nextMap.keys()]);
  const comparisons: ComparisonStat[] = [];

  for (const name of allTestNames) {
    const prevStatus = prevMap.get(name) || "MISSING";
    const nextStatus = nextMap.get(name) || "MISSING";

    const isRegression =
      (prevStatus === "PASS" && nextStatus !== "PASS") ||
      (prevStatus === "PARTIAL" && nextStatus === "FAIL");

    const isImprovement =
      (prevStatus === "FAIL" && nextStatus === "PASS") ||
      (prevStatus === "PARTIAL" && nextStatus === "PASS");

    comparisons.push({
      name,
      prevStatus,
      nextStatus,
      isRegression,
      isImprovement,
    });
  }

  // Sort by name
  comparisons.sort((a, b) => a.name.localeCompare(b.name));

  // Output comparisons
  for (const comp of comparisons) {
    const icon =
      comp.isRegression ? "🔴" : comp.isImprovement ? "🟢" : "⚪";
    const status = comp.prevStatus === comp.nextStatus ? "  " : " ";

    lines.push(
      `${icon}${status}${comp.name}: ${comp.prevStatus} → ${comp.nextStatus}`
    );
  }

  lines.push("");

  // Summary
  const regressions = comparisons.filter((c) => c.isRegression).length;
  const improvements = comparisons.filter((c) => c.isImprovement).length;
  const unchanged = comparisons.filter(
    (c) => !c.isRegression && !c.isImprovement
  ).length;

  lines.push("Summary:");
  if (regressions > 0) lines.push(`  ${regressions} regressions 🔴`);
  if (improvements > 0) lines.push(`  ${improvements} improvements 🟢`);
  lines.push(`  ${unchanged} unchanged ⚪`);

  lines.push("");
  lines.push(`Prev run: ${prev.timestamp}`);
  lines.push(`  ${prev.summary.passed}/${prev.summary.total} passed`);
  lines.push(`Next run: ${next.timestamp}`);
  lines.push(`  ${next.summary.passed}/${next.summary.total} passed`);

  return lines.join("\n");
}
