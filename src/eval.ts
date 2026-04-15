#!/usr/bin/env node

import process from "node:process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { initConfig, config } from "./config.js";
import { initMemoryStore, initEmbeddings } from "./memory/index.js";
import { loadAllTests, loadTest, filterByTags, type EvalTest } from "./eval/loader.js";
import { runAllTests, runTest } from "./eval/runner.js";
import { saveResults, loadRecentResults } from "./eval/results.js";
import { compareRuns } from "./eval/compare.js";
import { loadSubagentMessages, findThreadAnyStatus } from "./agent-thread.js";
import type { Message } from "./types.js";

export interface PromptOverrides {
  agentsMdPath?: string;
  agentsContent?: string;
  soulMdPath?: string;
  soulContent?: string;
  subagentMdPath?: string;
  subagentContent?: string;
}

async function printTestResults(
  testName?: string,
  tags?: string[],
  overrides?: PromptOverrides
): Promise<number> {
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

  // Print override banner if any overrides are active
  if (overrides && isAnyOverrideActive(overrides)) {
    printOverrideBanner(overrides);
  }

  console.log(`Running ${tests.length} test(s)...`);

  const run = await runAllTests(tests, overrides);
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

async function dumpSubagentFixture(
  chatId: string,
  threadName: string,
  agentName?: string,
  outputPath?: string
): Promise<number> {
  try {
    // Open database directly (same pattern as dumpFixture)
    const dbPath = path.join(config.workspace, "patronum.db");
    if (!existsSync(dbPath)) {
      console.error(`❌ Database not found: ${dbPath}`);
      return 1;
    }

    const db = new Database(dbPath, { readonly: true });

    try {
      // Look up thread ID by chat ID and name (search all statuses, not just active)
      const threadResult = db
        .prepare(
          `SELECT id, name FROM agent_threads
           WHERE chat_id = ? AND name = ?
           LIMIT 1`
        )
        .get(chatId, threadName) as { id: string; name: string } | undefined;

      if (!threadResult) {
        console.error(`❌ Thread not found: chat_id=${chatId}, name=${threadName}`);
        return 1;
      }

      // Load subagent messages from the database
      const query = agentName
        ? `SELECT agent_name, internal_messages_json
           FROM subagent_internal_messages
           WHERE thread_id = ? AND agent_name = ?
           ORDER BY rowid ASC`
        : `SELECT agent_name, internal_messages_json
           FROM subagent_internal_messages
           WHERE thread_id = ?
           ORDER BY rowid ASC`;

      const rows = (
        agentName
          ? db.prepare(query).all(threadResult.id, agentName)
          : db.prepare(query).all(threadResult.id)
      ) as Array<{ agent_name: string; internal_messages_json: string }>;

      const runs = rows.map((row) => ({
        agentName: row.agent_name,
        messages: JSON.parse(row.internal_messages_json) as Message[],
      }));

      if (runs.length === 0) {
        console.log(
          `⚠️  No subagent runs found for thread ${threadName}${agentName ? ` (agent: ${agentName})` : ""}`
        );
        return 1;
      }

      // If multiple runs and no agent filter, ask user to pick or combine them
      if (runs.length > 1 && !agentName) {
        console.log(`Found ${runs.length} runs for thread ${threadName}:`);
        runs.forEach((run, i) => {
          console.log(`  [${i}] ${run.agentName}`);
        });
        console.log("");
        console.log("Tip: Specify --agent <name> to filter by agent, or use index [0], [1], etc. for now.");
        console.log("For now, dumping all runs combined...");
        console.log("");
      }

      // Flatten all runs into a single fixture
      const allMessages: Message[] = runs.flatMap((run) => run.messages);

      // Determine output path
      const finalOutputPath =
        outputPath || path.join(config.workspace, "tests", "fixtures", `${threadName}-subagent.json`);
      const outputDir = path.dirname(finalOutputPath);

      mkdirSync(outputDir, { recursive: true });

      // Write to file
      writeFileSync(finalOutputPath, JSON.stringify(allMessages, null, 2), "utf-8");

      // Report results
      console.log(
        `✅ Dumped ${allMessages.length} message(s) from ${runs.length} run(s) to: ${finalOutputPath}`
      );
      if (allMessages.length > 0) {
        console.log("");
        console.log("First entry:");
        console.log(JSON.stringify(allMessages[0], null, 2).split("\n").slice(0, 5).join("\n"));
        console.log("");
        console.log("Last entry:");
        console.log(JSON.stringify(allMessages[allMessages.length - 1], null, 2).split("\n").slice(0, 5).join("\n"));
      }

      return 0;
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Error dumping subagent fixture: ${msg}`);
    return 1;
  }
}

async function dumpFixture(chatId: string, startId: number, endId: number, outputPath?: string): Promise<number> {
  try {
    // Determine output path
    const finalOutputPath = outputPath || path.join(config.workspace, "tests", "fixtures", `${chatId}-${startId}-${endId}.json`);
    const outputDir = path.dirname(finalOutputPath);

    // Create output directory if needed
    mkdirSync(outputDir, { recursive: true });

    // Open database
    const dbPath = path.join(config.workspace, "patronum.db");
    if (!existsSync(dbPath)) {
      console.error(`❌ Database not found: ${dbPath}`);
      return 1;
    }

    const db = new Database(dbPath, { readonly: true });

    try {
      // Query messages — check active table first, fall back to archived
      const stmt = db.prepare(
        "SELECT role, content_json FROM messages WHERE chat_id = ? AND id BETWEEN ? AND ? ORDER BY id ASC"
      );
      let rows = stmt.all(chatId as string, startId, endId) as Array<{ role: string; content_json: string }>;

      if (rows.length === 0) {
        try {
          const archivedStmt = db.prepare(
            "SELECT role, content_json FROM archived_messages WHERE chat_id = ? AND id BETWEEN ? AND ? ORDER BY id ASC"
          );
          rows = archivedStmt.all(chatId as string, startId, endId) as Array<{ role: string; content_json: string }>;
          if (rows.length > 0) {
            console.log(`ℹ️  Messages found in archived_messages table.`);
          }
        } catch (err: unknown) {
          // If archived_messages doesn't exist, fall through to "no messages found"
          if (!(err instanceof Error && err.message.includes("no such table"))) {
            throw err;
          }
        }
      }

      if (rows.length === 0) {
        console.log(`⚠️  No messages found for chat_id=${chatId}, id between ${startId} and ${endId}`);
      }

      // Map to fixture format
      const fixture = rows.map((row) => {
        let content: string | Record<string, unknown>[] | Record<string, unknown>;
        try {
          content = JSON.parse(row.content_json);
        } catch {
          // If not valid JSON, treat as string
          content = row.content_json;
        }

        return {
          role: row.role,
          content: content,
        };
      });

      // Write to file
      writeFileSync(finalOutputPath, JSON.stringify(fixture, null, 2), "utf-8");

      // Report results
      console.log(`✅ Dumped ${fixture.length} message(s) to: ${finalOutputPath}`);
      if (fixture.length > 0) {
        console.log("");
        console.log("First entry:");
        console.log(JSON.stringify(fixture[0], null, 2).split("\n").slice(0, 5).join("\n"));
        console.log("");
        console.log("Last entry:");
        console.log(JSON.stringify(fixture[fixture.length - 1], null, 2).split("\n").slice(0, 5).join("\n"));
      }

      return 0;
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Error dumping fixture: ${msg}`);
    return 1;
  }
}

function isAnyOverrideActive(overrides: PromptOverrides): boolean {
  return !!(
    overrides.agentsMdPath ||
    overrides.agentsContent ||
    overrides.soulMdPath ||
    overrides.soulContent ||
    overrides.subagentMdPath ||
    overrides.subagentContent
  );
}

function printOverrideBanner(overrides: PromptOverrides): void {
  console.log("⚠️  PROMPT OVERRIDES ACTIVE:");
  if (overrides.agentsMdPath) {
    console.log(`   --agents-md: ${overrides.agentsMdPath}`);
  }
  if (overrides.soulMdPath) {
    console.log(`   --soul-md: ${overrides.soulMdPath}`);
  }
  if (overrides.subagentMdPath) {
    console.log(`   --subagent-md: ${overrides.subagentMdPath}`);
  }
  console.log("");
}

function parsePromptOverrides(args: string[]): PromptOverrides {
  const overrides: PromptOverrides = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agents-md" && i + 1 < args.length) {
      const filePath = args[i + 1];
      if (!existsSync(filePath)) {
        throw new Error(`File not found: --agents-md ${filePath}`);
      }
      overrides.agentsMdPath = filePath;
      overrides.agentsContent = readFileSync(filePath, "utf-8");
      i++;
    } else if (args[i] === "--soul-md" && i + 1 < args.length) {
      const filePath = args[i + 1];
      if (!existsSync(filePath)) {
        throw new Error(`File not found: --soul-md ${filePath}`);
      }
      overrides.soulMdPath = filePath;
      overrides.soulContent = readFileSync(filePath, "utf-8");
      i++;
    } else if (args[i] === "--subagent-md" && i + 1 < args.length) {
      const filePath = args[i + 1];
      if (!existsSync(filePath)) {
        throw new Error(`File not found: --subagent-md ${filePath}`);
      }
      overrides.subagentMdPath = filePath;
      overrides.subagentContent = readFileSync(filePath, "utf-8");
      i++;
    }
  }

  return overrides;
}

async function main(): Promise<number> {
  try {
    await initConfig();

    // Initialize memory store for real memory_search execution (not needed for dump-fixture)
    const args = process.argv.slice(2);
    const command = args[0] || "run";

    // Handle dump-fixture without initializing memory store
    if (command === "dump-fixture") {
      if (args.length < 4) {
        console.error("❌ dump-fixture requires arguments: <chat_id> <start_id> <end_id> [output_path]");
        console.error("Usage: eval.js dump-fixture <chat_id> <start_id> <end_id> [output_path]");
        return 1;
      }

      const chatId = args[1];
      const startId = parseInt(args[2], 10);
      const endId = parseInt(args[3], 10);
      const outputPath = args[4];

      if (isNaN(startId) || isNaN(endId)) {
        console.error("❌ start_id and end_id must be valid numbers");
        return 1;
      }

      return await dumpFixture(chatId, startId, endId, outputPath);
    }

    // Initialize memory store for other commands
    if (config.voyageApiKey) {
      await initEmbeddings(config.voyageApiKey);
    }
    await initMemoryStore();

    if (command === "dump-subagent-fixture") {
      if (args.length < 3) {
        console.error("❌ dump-subagent-fixture requires arguments: <chat_id> <thread_name> [--agent <agent_name>] [output_path]");
        console.error("Usage: eval.js dump-subagent-fixture <chat_id> <thread_name> [--agent <agent_name>] [output_path]");
        return 1;
      }

      const chatId = args[1];
      const threadName = args[2];
      let agentName: string | undefined;
      let outputPath: string | undefined;

      // Parse optional --agent flag and output path
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "--agent" && i + 1 < args.length) {
          agentName = args[i + 1];
          i++;
        } else if (!args[i].startsWith("--")) {
          outputPath = args[i];
        }
      }

      return await dumpSubagentFixture(chatId, threadName, agentName, outputPath);
    }

    if (command === "run") {
      // Parse remaining arguments: [test-name] [--tag tag1 [--tag tag2 ...]] [--agents-md ...] etc
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

      // Parse prompt overrides
      const overrides = parsePromptOverrides(args);

      return await printTestResults(testName, tags, overrides);
    } else if (command === "compare") {
      return await printComparison();
    } else {
      console.error(`Unknown command: ${command}`);
      console.error("Usage:");
      console.error("  eval.js run [test-name] [--tag <tag>] [--agents-md <path>] ...");
      console.error("  eval.js compare");
      console.error("  eval.js dump-fixture <chat_id> <start_id> <end_id> [output_path]");
      console.error("  eval.js dump-subagent-fixture <chat_id> <thread_name> [--agent <agent_name>] [output_path]");
      return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Error: ${msg}`);
    return 1;
  }
}

process.exit(await main());
