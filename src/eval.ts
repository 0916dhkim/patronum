#!/usr/bin/env node

import process from "node:process";
import { initConfig, config } from "./config.js";
import { initMemoryStore, initEmbeddings } from "./memory/index.js";
import { loadAllTests, loadTest, filterByTags, type EvalTest } from "./eval/loader.js";
import { runAllTests, runTest } from "./eval/runner.js";
import { saveResults, loadRecentResults } from "./eval/results.js";
import { compareRuns } from "./eval/compare.js";

async function printTestResults(testName?: string, tags?: string[]): Promise<number> {
  let tests: EvalTest[] = [];
  let loadErrors: Array<{ file: string; message: string }> = [];

  if (testName) {
    // Load a specific test by name
    try {
      tests = [loadTest(testName)];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      loadErrors = [{ file: `${testName}.yaml`, message: msg }];
    }
  } else {
    // Load all tests, optionally filtered by tags
    const result = loadAllTests();
    tests = tags && tags.length > 0 ? filterByTags(result.tests, tags) : result.tests;
    loadErrors = result.errors;
  }

  // Report any load errors
  if (loadErrors.length > 0) {
    console.log("❌ Failed to load test files:");
    for (const err of loadErrors) {
      console.log(`   - ${err.file}: ${err.message}`);
    }
    console.log("");
  }

  if (tests.length === 0) {
    console.log("❌ No tests found");
    return 1;
  }

  console.log(`Running ${tests.length} test(s)...`);

  const run = await runAllTests(tests);
  const filePath = saveResults(run, testName);

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Test Results — ${new Date(run.timestamp).toLocaleString()}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  for (const test of run.tests) {
    const icon =
      test.status === "PASS"
        ? "✅"
        : test.status === "FAIL"
          ? "❌"
          : test.status === "PARTIAL"
            ? "⚠️"
            : "🔴";

    console.log(`${icon} ${test.name} (${test.duration_ms}ms)`);

    if (test.error) {
      console.log(`   Error: ${test.error}`);
      continue;
    }

    // Tool assertions
    if (test.toolAssertions.length > 0) {
      for (const a of test.toolAssertions) {
        const mark = a.passed ? "✓" : "✗";
        console.log(`   [${mark}] ${a.assertion}`);
      }
    }

    // Substring assertions
    if (test.substringAssertions.length > 0) {
      for (const a of test.substringAssertions) {
        const mark = a.passed ? "✓" : "✗";
        console.log(`   [${mark}] ${a.assertion}`);
      }
    }

    // Graded assertions
    if (test.gradedAssertions.length > 0) {
      for (const g of test.gradedAssertions) {
        const mark =
          g.verdict === "PASS"
            ? "✓"
            : g.verdict === "FAIL"
              ? "✗"
              : g.verdict === "ERROR"
                ? "⚠"
                : "?";
        console.log(`   [${mark}] ${g.assertion}`);
        if (g.reasoning) {
          console.log(`       ${g.reasoning}`);
        }
      }
    }

    console.log("");
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Summary: ${run.summary.passed}/${run.summary.total} passed`);
  if (run.summary.failed > 0) console.log(`  ${run.summary.failed} failed`);
  if (run.summary.partial > 0) console.log(`  ${run.summary.partial} partial`);
  if (run.summary.error > 0) console.log(`  ${run.summary.error} error`);
  console.log("");
  console.log(`Results saved to: ${filePath}`);
  console.log("");

  // Exit code: 0 if all pass, 1 if any fail
  return run.summary.failed > 0 || run.summary.error > 0 ? 1 : 0;
}

async function printComparison(): Promise<number> {
  const recent = loadRecentResults(2);

  if (recent.length < 2) {
    console.log("❌ Less than 2 recent test runs found. Cannot compare.");
    return 1;
  }

  const prev = recent[1]; // Older
  const next = recent[0]; // Newer

  const comparison = compareRuns(prev, next);
  console.log("");
  console.log(comparison);
  console.log("");

  return 0;
}

async function main(): Promise<number> {
  try {
    await initConfig();

    // Initialize memory store for real memory_search execution
    if (config.voyageApiKey) {
      await initEmbeddings(config.voyageApiKey);
    }
    await initMemoryStore();

    const args = process.argv.slice(2);
    const command = args[0] || "run";

    if (command === "run") {
      // Parse remaining arguments: [test-name] [--tag tag1 [--tag tag2 ...]]
      const testName = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      
      // Collect --tag arguments
      const tags: string[] = [];
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--tag" && i + 1 < args.length) {
          tags.push(args[i + 1]);
          i++; // Skip the tag value
        }
      }

      // Validate mutually exclusive: testName and tags
      if (testName && tags.length > 0) {
        console.error("❌ Error: --tag and test-name are mutually exclusive");
        console.error("Usage:");
        console.error("  eval.js run                     (run all tests)");
        console.error("  eval.js run <test-name>         (run specific test)");
        console.error("  eval.js run --tag <tag>         (run tests with tag)");
        console.error("  eval.js run --tag <tag1> --tag <tag2>  (run tests with any tag)");
        return 1;
      }

      return await printTestResults(testName, tags);
    } else if (command === "compare") {
      return await printComparison();
    } else {
      console.error(`Unknown command: ${command}`);
      console.error("Usage: eval.js [run [test-name] | run --tag <tag> | compare]");
      return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Error: ${msg}`);
    return 1;
  }
}

process.exit(await main());
