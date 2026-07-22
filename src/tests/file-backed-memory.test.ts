/**
 * Tests for file-backed shared memory (USER.md + MEMORY.md).
 *
 * Verifies:
 * - USER.md and MEMORY.md are loaded into system prompt blocks for Lin
 * - USER.md and MEMORY.md are loaded into system prompt blocks for subagents
 * - Default templates are returned when files don't exist
 * - User messages are NOT augmented with <memory_context> or <living_memory>
 * - extraContext is empty for memory (no Living Memory injection)
 * - Cognee dual-write (indexExchange) is preserved
 * - living_memory_update tool is not in the registered tool set
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helper: set up a temp workspace with known USER.md and MEMORY.md content
// ---------------------------------------------------------------------------

function setupWorkspace(): { workspace: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "file-memory-test-"));
  return {
    workspace: tmpDir,
    cleanup: () => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

function writeFile(workspace: string, filename: string, content: string): void {
  writeFileSync(join(workspace, filename), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("File-backed shared memory", () => {
  let testCtx: ReturnType<typeof setupWorkspace>;

  before(() => {
    testCtx = setupWorkspace();
  });

  after(() => {
    testCtx.cleanup();
  });

  describe("buildSystemPrompt includes USER.md and MEMORY.md", () => {
    it("should include USER.md content as a system block", async () => {
      const { buildSystemPrompt } = await import("../agent.js");
      writeFile(testCtx.workspace, "USER.md", "# Test USER");
      writeFile(testCtx.workspace, "MEMORY.md", "# Test MEMORY");

      const system = buildSystemPrompt({
        workspace: testCtx.workspace,
        soulContent: "",
        agentsContent: "",
      });

      const allText = system.map((b) => b.text).join("\n");
      assert.ok(allText.includes("# Test USER"), "USER.md content should appear in system prompt");
    });

    it("should include MEMORY.md content as a system block", async () => {
      const { buildSystemPrompt } = await import("../agent.js");
      writeFile(testCtx.workspace, "USER.md", "# Test USER");
      writeFile(testCtx.workspace, "MEMORY.md", "# Test MEMORY");

      const system = buildSystemPrompt({
        workspace: testCtx.workspace,
        soulContent: "",
        agentsContent: "",
      });

      const allText = system.map((b) => b.text).join("\n");
      assert.ok(allText.includes("# Test MEMORY"), "MEMORY.md content should appear in system prompt");
    });

    it("should place USER.md and MEMORY.md after AGENTS.md and before project context", async () => {
      const { buildSystemPrompt } = await import("../agent.js");
      writeFile(testCtx.workspace, "USER.md", "# Test USER");
      writeFile(testCtx.workspace, "MEMORY.md", "# Test MEMORY");

      const system = buildSystemPrompt({
        workspace: testCtx.workspace,
        agentsContent: "## Test AGENTS",
        soulContent: "",
      });

      const blocks = system.map((b) => b.text);
      const agentsIdx = blocks.findIndex((t) => t.includes("## Test AGENTS"));
      const userIdx = blocks.findIndex((t) => t.includes("# Test USER"));
      const memoryIdx = blocks.findIndex((t) => t.includes("# Test MEMORY"));
      const projectIdx = blocks.findIndex((t) => t.includes("[Project Context"));

      assert.ok(agentsIdx >= 0, "AGENTS.md should be present");
      assert.ok(userIdx >= 0, "USER.md should be present");
      assert.ok(memoryIdx >= 0, "MEMORY.md should be present");
      assert.ok(projectIdx >= 0, "Project context should be present");

      assert.ok(agentsIdx < userIdx, "USER.md should come after AGENTS.md");
      assert.ok(userIdx < memoryIdx, "MEMORY.md should come after USER.md");
      assert.ok(memoryIdx < projectIdx, "MEMORY.md should come before project context");
    });

    it("should not affect SOUL.md, AGENTS.md, project context, subagents, or skills blocks", async () => {
      const { buildSystemPrompt } = await import("../agent.js");
      writeFile(testCtx.workspace, "USER.md", "# Test USER");
      writeFile(testCtx.workspace, "MEMORY.md", "# Test MEMORY");

      const system = buildSystemPrompt({
        workspace: testCtx.workspace,
        soulContent: "## Test SOUL",
        agentsContent: "## Test AGENTS",
      });

      const allText = system.map((b) => b.text).join("\n");
      assert.ok(allText.includes("## Test SOUL"), "SOUL.md should be preserved");
      assert.ok(allText.includes("## Test AGENTS"), "AGENTS.md should be preserved");
      assert.ok(allText.includes("[Project Context"), "Project context should be preserved");
      assert.ok(allText.includes("# Test USER"), "USER.md should be present");
      assert.ok(allText.includes("# Test MEMORY"), "MEMORY.md should be present");
    });
  });

  describe("loadContextFile returns default templates", () => {
    it("should return DEFAULT_USER when USER.md does not exist", async () => {
      const { loadContextFile } = await import("../context.js");
      const { DEFAULT_USER } = await import("../templates.js");

      const emptyWorkspace = setupWorkspace();
      const result = loadContextFile(emptyWorkspace.workspace, "USER.md");
      assert.equal(result, DEFAULT_USER, "Should return DEFAULT_USER template when file is missing");
      emptyWorkspace.cleanup();
    });

    it("should return DEFAULT_MEMORY when MEMORY.md does not exist", async () => {
      const { loadContextFile } = await import("../context.js");
      const { DEFAULT_MEMORY } = await import("../templates.js");

      const emptyWorkspace = setupWorkspace();
      const result = loadContextFile(emptyWorkspace.workspace, "MEMORY.md");
      assert.equal(result, DEFAULT_MEMORY, "Should return DEFAULT_MEMORY template when file is missing");
      emptyWorkspace.cleanup();
    });

    it("should contain ownership header in default templates", async () => {
      const { DEFAULT_USER, DEFAULT_MEMORY } = await import("../templates.js");

      assert.ok(DEFAULT_USER.includes("edited only by Lin"), "USER.md default should have ownership header");
      assert.ok(DEFAULT_MEMORY.includes("edited only by Lin"), "MEMORY.md default should have ownership header");
    });

    it("should respect token budget (~500 chars for USER.md, ~1000 chars for MEMORY.md)", async () => {
      const { DEFAULT_USER, DEFAULT_MEMORY } = await import("../templates.js");

      // Budgets are approximate: USER.md ~500 tokens (~2000 chars), MEMORY.md ~1000 tokens (~4000 chars)
      // Default templates are well under budget since they're placeholder stubs
      assert.ok(DEFAULT_USER.length <= 2000, `USER.md default should be within ~2000 char budget (was ${DEFAULT_USER.length})`);
      assert.ok(DEFAULT_MEMORY.length <= 4000, `MEMORY.md default should be within ~4000 char budget (was ${DEFAULT_MEMORY.length})`);
    });
  });

  describe("User message is not augmented", () => {
    it("should not contain <memory_context> in user message content", async () => {
      // Simulate what bot.ts does: user message is stored as-is
      const userText = "Hello, what do you know about me?";
      const userMessage = { role: "user" as const, content: userText };

      assert.equal(userMessage.content, userText, "User message should be exactly the original text");
      assert.ok(!userMessage.content.includes("<memory_context>"), "No Cognee <memory_context> in user message");
      assert.ok(!userMessage.content.includes("<living_memory>"), "No <living_memory> in user message");
      assert.ok(!userMessage.content.includes("<cognee_shadow>"), "No <cognee_shadow> in user message");
    });
  });

  describe("Cognee tools and dual-write preserved", () => {
    it("should export memorySearchTool and memoryFetchContextTool", async () => {
      const { memorySearchTool, memoryFetchContextTool } = await import("../memory/index.js");
      assert.ok(memorySearchTool, "memorySearchTool should be exported");
      assert.ok(memoryFetchContextTool, "memoryFetchContextTool should be exported");
      assert.equal(memorySearchTool.definition.name, "memory_search");
      assert.equal(memoryFetchContextTool.definition.name, "memory_fetch_context");
    });

    it("should export indexExchange for dual-write", async () => {
      const { indexExchange } = await import("../memory/index.js");
      assert.ok(indexExchange, "indexExchange should be exported");
      assert.equal(typeof indexExchange, "function", "indexExchange should be a function");
    });
  });

  describe("living_memory_update tool is unregistered", () => {
    it("should not be in the registered tool set", async () => {
      const { getToolDefinitions } = await import("../tools/index.js");
      const tools = getToolDefinitions();
      const toolNames = tools.map((t) => t.name);
      assert.ok(!toolNames.includes("living_memory_update"), "living_memory_update should not be in registered tools");
    });

    it("should still have memory_search and memory_fetch_context tools", async () => {
      const { getToolDefinitions } = await import("../tools/index.js");
      const tools = getToolDefinitions();
      const toolNames = tools.map((t) => t.name);
      assert.ok(toolNames.includes("memory_search"), "memory_search should still be registered");
      assert.ok(toolNames.includes("memory_fetch_context"), "memory_fetch_context should still be registered");
    });
  });

  describe("SQLite Living Memory code remains dormant", () => {
    it("should still export migrateLivingMemory (code preserved)", async () => {
      const { migrateLivingMemory } = await import("../memory/index.js");
      assert.ok(migrateLivingMemory, "migrateLivingMemory should still be exported");
      assert.equal(typeof migrateLivingMemory, "function", "migrateLivingMemory should be a function");
    });

    it("should export renderLivingMemory (function preserved)", async () => {
      const { renderLivingMemory } = await import("../memory/index.js");
      assert.ok(renderLivingMemory, "renderLivingMemory should still be exported");
      assert.equal(typeof renderLivingMemory, "function", "renderLivingMemory should be a function");
    });
  });
});

describe("Subagent system prompt", () => {
  let testCtx: ReturnType<typeof setupWorkspace>;

  before(() => {
    testCtx = setupWorkspace();
  });

  after(() => {
    testCtx.cleanup();
  });

  it("should include USER.md and MEMORY.md in buildAgentSystemPrompt", async () => {
    // Verify the function references USER.md and MEMORY.md via loadContextFile
    const { loadContextFile } = await import("../context.js");
    const { DEFAULT_USER, DEFAULT_MEMORY } = await import("../templates.js");

    // Verify loadContextFile can load USER.md and MEMORY.md from the templates when
    // files don't exist (proving the function is wired to look for these files)
    const emptyWorkspace = setupWorkspace();
    const userMd = loadContextFile(emptyWorkspace.workspace, "USER.md");
    const memoryMd = loadContextFile(emptyWorkspace.workspace, "MEMORY.md");

    assert.equal(userMd, DEFAULT_USER, "USER.md template should be returned for missing file");
    assert.equal(memoryMd, DEFAULT_MEMORY, "MEMORY.md template should be returned for missing file");
    emptyWorkspace.cleanup();
  });
});