import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { EvalRun } from "./runner.js";

/**
 * Save eval results to a JSON file in tests/results/{timestamp}_{name}.json
 */
export function saveResults(run: EvalRun, testName?: string): string {
  const resultsDir = path.join(config.workspace, "tests", "results");
  mkdirSync(resultsDir, { recursive: true });

  // Create filename from timestamp
  const timestamp = new Date(run.timestamp).toISOString().slice(0, 19).replace(/:/g, "-");
  const filename = testName ? `${timestamp}_${testName}.json` : `${timestamp}_all.json`;
  const filePath = path.join(resultsDir, filename);

  writeFileSync(filePath, JSON.stringify(run, null, 2));

  return filePath;
}

/**
 * Load the most recent N result files
 */
export function loadRecentResults(n: number): EvalRun[] {
  const resultsDir = path.join(config.workspace, "tests", "results");

  if (!existsSync(resultsDir)) {
    return [];
  }

  const files = readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, n);

  return files
    .map((file) => {
      try {
        const content = readFileSync(path.join(resultsDir, file), "utf-8");
        return JSON.parse(content) as EvalRun;
      } catch {
        return null;
      }
    })
    .filter((r) => r !== null) as EvalRun[];
}

/**
 * Load a specific result file by filename
 */
export function loadResultFile(filename: string): EvalRun {
  const filePath = path.join(config.workspace, "tests", "results", filename);
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content) as EvalRun;
}
