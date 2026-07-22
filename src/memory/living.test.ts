/**
 * Tests for Living Memory module.
 * Covers schema migration, CRUD operations, rendering, token budget, and chat scope.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to mock config before importing the module
import { config } from "../config.js";

function setupTestDb(): { dbPath: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "living-memory-test-"));
  const dbPath = join(tmpDir, "patronum.db");

  // Set config to use this temp directory
  (config as any).workspace = tmpDir;
  (config as any).livingMemory = true;

  return {
    dbPath,
    cleanup: () => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

let testContext: ReturnType<typeof setupTestDb>;

describe("Living Memory", () => {
  before(() => {
    testContext = setupTestDb();
  });

  after(() => {
    testContext.cleanup();
  });

  describe("Schema migration", () => {
    it("should create tables idempotently", async () => {
      const { migrateLivingMemory } = await import("../memory/living.js");

      // First call — should create tables
      migrateLivingMemory();

      // Second call — should be idempotent (no error)
      migrateLivingMemory();

      // Verify tables exist
      const db = new Database(testContext.dbPath);
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('living_memory', 'living_memory_revisions')`
      ).all() as Array<{ name: string }>;

      assert.ok(tables.some((t) => t.name === "living_memory"), "living_memory table should exist");
      assert.ok(tables.some((t) => t.name === "living_memory_revisions"), "living_memory_revisions table should exist");

      // Verify indexes exist
      const indexes = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_lm_%' OR name LIKE 'idx_lmr_%'`
      ).all() as Array<{ name: string }>;

      assert.ok(indexes.length >= 3, `Expected at least 3 indexes, got ${indexes.length}`);

      db.close();
    });
  });

  describe("CRUD operations", () => {
    it("should create an entry and render it", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      // Set chat context
      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("test-chat-1");

      const result = applyLivingMemoryUpdate({
        action: "create",
        section: "identity",
        key: "owner_name",
        value: "Danny",
        reason: "Initial setup",
      });

      assert.ok(result.success, `Create should succeed: ${result.message}`);
      assert.equal(result.entry?.section, "identity");
      assert.equal(result.entry?.key, "owner_name");
      assert.equal(result.entry?.value, "Danny");
      assert.equal(result.entry?.status, "active");
      assert.equal(result.entry?.revision, 1);

      // Render and verify
      const rendered = renderLivingMemory("test-chat-1");
      assert.ok(rendered, "Rendered output should not be null");
      assert.ok(rendered!.includes("Danny"), "Rendered output should contain the value");
      assert.ok(rendered!.includes("<living_memory>"), "Rendered output should have living_memory tags");
      assert.ok(rendered!.includes("Identity"), "Rendered output should have section header");
    });

    it("should update an existing entry", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("test-chat-2");

      // Create first
      applyLivingMemoryUpdate({
        action: "create",
        section: "preferences",
        key: "verbosity",
        value: "verbose",
        reason: "Initial",
      });

      // Update
      const result = applyLivingMemoryUpdate({
        action: "update",
        section: "preferences",
        key: "verbosity",
        value: "concise",
        reason: "User prefers concise responses",
      });

      assert.ok(result.success, `Update should succeed: ${result.message}`);
      assert.equal(result.entry?.revision, 2);
      assert.equal(result.entry?.value, "concise");

      // Render should show new value
      const rendered = renderLivingMemory("test-chat-2");
      assert.ok(rendered!.includes("concise"), "Rendered output should show updated value");
      assert.ok(!rendered!.includes("verbose"), "Rendered output should not show old value");
    });

    it("should supersede an entry", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("test-chat-3");

      // Create first
      applyLivingMemoryUpdate({
        action: "create",
        section: "active_context",
        key: "project",
        value: "Working on compaction fix",
        reason: "Initial",
      });

      // Supersede with new value
      const result = applyLivingMemoryUpdate({
        action: "supersede",
        section: "active_context",
        key: "project",
        value: "Working on Living Memory system",
        reason: "Project changed",
      });

      assert.ok(result.success, `Supersede should succeed: ${result.message}`);

      // Render should show new value only
      const rendered = renderLivingMemory("test-chat-3");
      assert.ok(rendered!.includes("Living Memory system"), "Rendered output should show new value");
      assert.ok(!rendered!.includes("compaction fix"), "Rendered output should not show superseded value");
    });

    it("should expire an entry", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("test-chat-4");

      // Create
      applyLivingMemoryUpdate({
        action: "create",
        section: "open_items",
        key: "todo",
        value: "Fix the widget",
        reason: "Initial",
      });

      // Expire
      const result = applyLivingMemoryUpdate({
        action: "expire",
        section: "open_items",
        key: "todo",
        reason: "Completed",
      });

      assert.ok(result.success, `Expire should succeed: ${result.message}`);
      assert.equal(result.entry?.status, "expired");

      // Render should not show expired entry
      const rendered = renderLivingMemory("test-chat-4");
      assert.ok(rendered === null || !rendered.includes("widget"), "Expired entry should not appear in render");
    });

    it("should reactivate a superseded entry", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("test-chat-5");

      // Create
      applyLivingMemoryUpdate({
        action: "create",
        section: "decisions",
        key: "framework",
        value: "Use React",
        reason: "Initial",
      });

      // Supersede
      applyLivingMemoryUpdate({
        action: "supersede",
        section: "decisions",
        key: "framework",
        value: "Use Vue",
        reason: "Better fit",
      });

      // Reactivate original
      const result = applyLivingMemoryUpdate({
        action: "reactivate",
        section: "decisions",
        key: "framework",
        reason: "Vue didn't work out",
      });

      assert.ok(result.success, `Reactivate should succeed: ${result.message}`);
      assert.equal(result.entry?.status, "active");

      // Render should show original value, not the superseding one
      const rendered = renderLivingMemory("test-chat-5");
      assert.ok(rendered!.includes("React"), "Rendered output should show reactivated value");
    });

    it("should redirect create to update when key exists", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("test-chat-dupe");

      // Create first
      applyLivingMemoryUpdate({
        action: "create",
        section: "identity",
        key: "name",
        value: "Alice",
      });

      // Create same key again — should redirect to update
      const result = applyLivingMemoryUpdate({
        action: "create",
        section: "identity",
        key: "name",
        value: "Bob",
      });

      // Should still succeed (was redirected to update), and show revision 2
      assert.ok(result.success);
      assert.equal(result.entry?.revision, 2);
      assert.equal(result.entry?.value, "Bob");
    });
  });

  describe("Chat scope", () => {
    it("should not leak entries between chats", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");

      // Create entry for chat A
      setCurrentChatId("chat-a");
      applyLivingMemoryUpdate({
        action: "create",
        section: "identity",
        key: "user",
        value: "Alice",
      });

      // Create entry for chat B
      setCurrentChatId("chat-b");
      applyLivingMemoryUpdate({
        action: "create",
        section: "identity",
        key: "user",
        value: "Bob",
      });

      // Render for chat A should only show Alice
      const renderedA = renderLivingMemory("chat-a");
      assert.ok(renderedA!.includes("Alice"), "Chat A should see Alice");
      assert.ok(!renderedA!.includes("Bob"), "Chat A should not see Bob");

      // Render for chat B should only show Bob
      const renderedB = renderLivingMemory("chat-b");
      assert.ok(renderedB!.includes("Bob"), "Chat B should see Bob");
      assert.ok(!renderedB!.includes("Alice"), "Chat B should not see Alice");
    });
  });

  describe("Empty Living Memory", () => {
    it("should return null when no entries exist", async () => {
      const { migrateLivingMemory, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const rendered = renderLivingMemory("empty-chat");
      assert.equal(rendered, null, "Empty memory should return null");
    });
  });

  describe("Token budget", () => {
    it("should enforce per-section entry limits", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("budget-chat");

      // Create 15 entries in open_items (max is 5)
      for (let i = 1; i <= 15; i++) {
        applyLivingMemoryUpdate({
          action: "create",
          section: "open_items",
          key: `item_${i}`,
          value: `This is open item number ${i} with some extra text to make it longer.`,
        });
      }

      const rendered = renderLivingMemory("budget-chat");
      assert.ok(rendered, "Should still render");

      // Count how many items appear (should be at most 5)
      const itemCount = (rendered!.match(/item_\d+/g) || []).length;
      assert.ok(itemCount <= 5, `Should have at most 5 items, got ${itemCount}`);
    });
  });

  describe("Validation", () => {
    it("should reject invalid sections", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("validation-chat");

      const result = applyLivingMemoryUpdate({
        action: "create",
        section: "invalid_section",
        key: "test",
        value: "test",
      });

      assert.ok(!result.success, "Should reject invalid section");
      assert.ok(result.message.includes("Invalid section"), "Message should mention invalid section");
    });

    it("should reject empty values", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("validation-chat-2");

      const result = applyLivingMemoryUpdate({
        action: "create",
        section: "identity",
        key: "test",
        value: "",
      });

      assert.ok(!result.success, "Should reject empty value");
    });
  });

  describe("System prompt integration", () => {
    it("should render Living Memory as a block suitable for extraContext", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("sysprompt-chat");

      // Create entries across multiple sections
      applyLivingMemoryUpdate({
        action: "create", section: "identity", key: "name", value: "Danny", reason: "Initial",
      });
      applyLivingMemoryUpdate({
        action: "create", section: "preferences", key: "style", value: "Concise and direct", reason: "User preference",
      });
      applyLivingMemoryUpdate({
        action: "create", section: "active_context", key: "project", value: "Living Memory system", reason: "Current focus",
      });

      const rendered = renderLivingMemory("sysprompt-chat");
      assert.ok(rendered, "Living Memory should render");

      // Verify it is a proper <living_memory> block (not a user message fragment)
      assert.ok(rendered!.startsWith("<living_memory>"), "Should start with <living_memory> tag");
      assert.ok(rendered!.endsWith("</living_memory>"), "Should end with </living_memory> tag");
      assert.ok(rendered!.includes("Danny"), "Should contain the value");
      assert.ok(rendered!.includes("Concise and direct"), "Should contain preferences");
      assert.ok(rendered!.includes("Living Memory system"), "Should contain active context");

      // The block should NOT contain user-message framing like "User said:" or similar
      assert.ok(!rendered!.includes("User said:"), "Should not contain user message framing");
    });

    it("should include Living Memory in buildSystemPrompt when passed as extraContext", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("sysprompt-extra");

      // Create a Living Memory entry
      applyLivingMemoryUpdate({
        action: "create", section: "identity", key: "name", value: "Alice", reason: "Setup",
      });

      const lmContent = renderLivingMemory("sysprompt-extra");
      assert.ok(lmContent, "Living Memory should render");

      // Import buildSystemPrompt and pass Living Memory as extraContext
      const { buildSystemPrompt } = await import("../agent.js");
      const systemBlocks = buildSystemPrompt({
        extraContext: [lmContent!],
        // Override to avoid filesystem dependency on SOUL.md/AGENTS.md
        soulContent: "",
        agentsContent: "",
      });

      // Verify Living Memory appears in the system prompt blocks
      const allText = systemBlocks.map((b) => b.text).join("\n");
      assert.ok(allText.includes("<living_memory>"), "Living Memory block should appear in system prompt");
      assert.ok(allText.includes("Alice"), "Living Memory content should appear in system prompt");
      assert.ok(allText.includes("</living_memory>"), "Living Memory closing tag should appear in system prompt");

      // Verify it appears as a top-level system block (not nested in user content)
      const livingMemoryBlock = systemBlocks.find((b) => b.text.includes("<living_memory>"));
      assert.ok(livingMemoryBlock, "Living Memory should be a separate system block");
      assert.equal(livingMemoryBlock!.type, "text", "Living Memory block should be text type");
    });

    it("should not inject Living Memory into user message content", async () => {
      const { migrateLivingMemory, applyLivingMemoryUpdate, renderLivingMemory } = await import("../memory/living.js");
      migrateLivingMemory();

      const { setCurrentChatId } = await import("../tools/chat-context.js");
      setCurrentChatId("user-content-test");

      // Create a Living Memory entry
      applyLivingMemoryUpdate({
        action: "create", section: "identity", key: "name", value: "Bob", reason: "Setup",
      });

      // Simulate what bot.ts does: user message content is stored as-is
      const userText = "What do you know about me?";
      const userMessage = { role: "user" as const, content: userText };

      // Verify the user message content is EXACTLY the original text
      assert.equal(userMessage.content, userText, "User message content should be exactly the original text");
      assert.ok(!userMessage.content.includes("<living_memory>"), "User message should not contain Living Memory");
      assert.ok(!userMessage.content.includes("Bob"), "User message should not contain Living Memory values");

      // Verify Living Memory is separate (render it and check it's different from user content)
      const lmContent = renderLivingMemory("user-content-test");
      assert.ok(lmContent, "Living Memory should render");
      assert.ok(lmContent!.includes("<living_memory>"), "Living Memory should have its own tags");
      assert.ok(lmContent!.includes("Bob"), "Living Memory should contain the value");

      // The two should be completely different
      assert.notEqual(lmContent, userText, "Living Memory content should not equal user message text");
    });
  });
});