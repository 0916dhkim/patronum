/**
 * Living Memory — structured, version-controlled, always-present context.
 *
 * Replaces Cognee auto-recall injection with a concise, curated document
 * stored in SQLite alongside the existing Patronum session data.
 *
 * Sections: identity, preferences, active_context, decisions, infrastructure, open_items
 * Budget: 1,500 tokens (~6,000 chars) hard cap at render time.
 * Lifecycle: create / update / supersede / expire / reactivate — no deletion ever.
 */

import Database from "better-sqlite3";
import path from "path";
import { config } from "../config.js";
import { getCurrentChatId } from "../tools/chat-context.js";

// ---------------------------------------------------------------------------
// Schema & Constants
// ---------------------------------------------------------------------------

const VALID_SECTIONS = [
  "identity",
  "preferences",
  "active_context",
  "decisions",
  "infrastructure",
  "open_items",
] as const;

type LivingMemorySection = typeof VALID_SECTIONS[number];

// Entry-level limits
const MAX_KEY_LENGTH = 100;
const MAX_VALUE_LENGTH = 2000;

// Token budget
const TOTAL_CHAR_BUDGET = 6000; // ~1,500 tokens at ~4 chars/token

// Per-section max entries (render-time limit)
const SECTION_MAX_ENTRIES: Record<LivingMemorySection, number> = {
  identity: 5,
  preferences: 10,
  active_context: 8,
  decisions: 10,
  infrastructure: 10,
  open_items: 5,
};

// Per-section char budget (for truncation)
const SECTION_CHAR_BUDGETS: Record<LivingMemorySection, number> = {
  identity: 400,
  preferences: 800,
  active_context: 1600,
  decisions: 1200,
  infrastructure: 1200,
  open_items: 800,
};

// Priority order for total budget truncation (last = most protected)
const TRUNCATION_PRIORITY: LivingMemorySection[] = [
  "open_items",
  "active_context",
  "decisions",
  "infrastructure",
  "preferences",
  "identity",
];

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(config.workspace, "patronum.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
  }
  return db;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export function migrateLivingMemory(): void {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS living_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      section TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      source_data_ids TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      superseded_by INTEGER,
      CHECK (status IN ('active', 'superseded', 'expired'))
    )
  `);

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_lm_chat_section
    ON living_memory(chat_id, section, status)
  `);

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_lm_active
    ON living_memory(chat_id, status, updated_at)
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS living_memory_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      old_value TEXT,
      new_value TEXT,
      old_status TEXT,
      new_status TEXT,
      changed_by TEXT NOT NULL,
      change_reason TEXT,
      source_data_ids TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (entry_id) REFERENCES living_memory(id)
    )
  `);

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_lmr_entry
    ON living_memory_revisions(entry_id, revision)
  `);

  console.log("[living-memory] Schema migration complete");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface LivingMemoryRow {
  id: number;
  chat_id: string;
  section: string;
  key: string;
  value: string;
  status: string;
  revision: number;
  source_data_ids: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  superseded_by: number | null;
}

function validateSection(section: string): section is LivingMemorySection {
  return (VALID_SECTIONS as readonly string[]).includes(section);
}

function validateKey(key: string): string | null {
  if (!key || key.trim().length === 0) return "Key must be non-empty";
  if (key.length > MAX_KEY_LENGTH) return `Key must be at most ${MAX_KEY_LENGTH} characters`;
  return null;
}

function validateValue(value: string): string | null {
  if (!value || value.trim().length === 0) return "Value must be non-empty";
  if (value.length > MAX_VALUE_LENGTH) return `Value must be at most ${MAX_VALUE_LENGTH} characters`;
  return null;
}

function recordRevision(
  entryId: number,
  revision: number,
  oldValue: string | null,
  newValue: string | null,
  oldStatus: string | null,
  newStatus: string | null,
  changedBy: string,
  changeReason: string | null,
  sourceDataIds: string | null,
): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO living_memory_revisions
      (entry_id, revision, old_value, new_value, old_status, new_status,
       changed_by, change_reason, source_data_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entryId,
    revision,
    oldValue,
    newValue,
    oldStatus,
    newStatus,
    changedBy,
    changeReason ?? null,
    sourceDataIds ?? null,
  );
}

// ---------------------------------------------------------------------------
// Public API: CRUD operations
// ---------------------------------------------------------------------------

interface LivingMemoryUpdateInput {
  action: "create" | "update" | "supersede" | "expire" | "reactivate" | "list";
  section: string;
  key: string;
  value?: string;
  source_data_ids?: string[];
  expires_at?: string | null;
  reason?: string;
  chat_id?: string; // defaults to current chat
}

interface LivingMemoryUpdateResult {
  success: boolean;
  message: string;
  entry?: {
    id: number;
    section: string;
    key: string;
    value: string;
    status: string;
    revision: number;
  };
}

/**
 * Apply a Living Memory mutation atomically.
 * Validates all inputs before making changes.
 */
export function applyLivingMemoryUpdate(input: LivingMemoryUpdateInput): LivingMemoryUpdateResult {
  const chatId = input.chat_id || getCurrentChatId();
  if (!chatId) {
    return { success: false, message: "No chat context — cannot determine chat_id" };
  }

  const section = input.section;
  const key = input.key;

  // Validate section
  if (!validateSection(section)) {
    return {
      success: false,
      message: `Invalid section "${section}". Must be one of: ${VALID_SECTIONS.join(", ")}`,
    };
  }

  // Validate key
  const keyError = validateKey(key);
  if (keyError) {
    return { success: false, message: keyError };
  }

  const d = getDb();

  try {
    switch (input.action) {
      case "create":
        return doCreate(d, chatId, section, key, input);
      case "update":
        return doUpdate(d, chatId, section, key, input);
      case "supersede":
        return doSupersede(d, chatId, section, key, input);
      case "expire":
        return doExpire(d, chatId, section, key, input);
      case "reactivate":
        return doReactivate(d, chatId, section, key, input);
      case "list":
        return doList(d, chatId, section, key);
      default:
        return { success: false, message: `Unknown action: ${input.action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[living-memory] Mutation failed:`, msg);
    return { success: false, message: `Database error: ${msg}` };
  }
}

function doCreate(
  d: Database.Database,
  chatId: string,
  section: string,
  key: string,
  input: LivingMemoryUpdateInput,
): LivingMemoryUpdateResult {
  // Validate value
  if (!input.value) {
    return { success: false, message: "Value is required for create" };
  }
  const valueError = validateValue(input.value);
  if (valueError) {
    return { success: false, message: valueError };
  }

  // Check if active entry with same (chat_id, section, key) exists — redirect to update
  const existing = d.prepare(`
    SELECT id, section, key, value, revision FROM living_memory
    WHERE chat_id = ? AND section = ? AND key = ? AND status = 'active'
  `).get(chatId, section, key) as LivingMemoryRow | undefined;

  if (existing) {
    // Redirect to update
    return doUpdateInternal(d, chatId, existing, input.value!, input.source_data_ids, input.reason);
  }

  const sourceIds = input.source_data_ids ? JSON.stringify(input.source_data_ids) : null;
  const expiresAt = input.expires_at || null;
  const changedBy = "agent";
  const reason = input.reason || null;

  const result = d.prepare(`
    INSERT INTO living_memory (chat_id, section, key, value, status, revision, source_data_ids, expires_at)
    VALUES (?, ?, ?, ?, 'active', 1, ?, ?)
  `).run(chatId, section, key, input.value, sourceIds, expiresAt);

  const entryId = Number(result.lastInsertRowid);

  recordRevision(entryId, 1, null, input.value, null, "active", changedBy, reason, sourceIds);

  console.log(`[living-memory] Created ${section}.${key} (id=${entryId}) for chat=${chatId}`);

  return {
    success: true,
    message: `Created "${section}.${key}"`,
    entry: { id: entryId, section, key, value: input.value, status: "active", revision: 1 },
  };
}

function doUpdate(
  d: Database.Database,
  chatId: string,
  section: string,
  key: string,
  input: LivingMemoryUpdateInput,
): LivingMemoryUpdateResult {
  if (!input.value) {
    return { success: false, message: "Value is required for update" };
  }
  const valueError = validateValue(input.value);
  if (valueError) {
    return { success: false, message: valueError };
  }

  const existing = d.prepare(`
    SELECT id, section, key, value, revision FROM living_memory
    WHERE chat_id = ? AND section = ? AND key = ? AND status = 'active'
  `).get(chatId, section, key) as LivingMemoryRow | undefined;

  if (!existing) {
    return { success: false, message: `No active entry found for "${section}.${key}"` };
  }

  // No-op if value is the same
  if (existing.value === input.value) {
    return {
      success: true,
      message: `No change — "${section}.${key}" already has that value`,
      entry: { id: existing.id, section, key, value: existing.value, status: "active", revision: existing.revision },
    };
  }

  return doUpdateInternal(d, chatId, existing, input.value!, input.source_data_ids, input.reason);
}

function doUpdateInternal(
  d: Database.Database,
  chatId: string,
  existing: LivingMemoryRow,
  newValue: string,
  sourceDataIds: string[] | undefined,
  reason: string | undefined,
): LivingMemoryUpdateResult {
  const newRevision = existing.revision + 1;
  const changedBy = "agent";
  const reasonStr = reason || null;

  // Merge source_data_ids
  let newSourceIds: string | null = existing.source_data_ids;
  if (sourceDataIds && sourceDataIds.length > 0) {
    const existingIds: string[] = existing.source_data_ids
      ? JSON.parse(existing.source_data_ids)
      : [];
    const merged = [...new Set([...existingIds, ...sourceDataIds])];
    newSourceIds = JSON.stringify(merged);
  }

  d.prepare(`
    UPDATE living_memory
    SET value = ?, revision = ?, updated_at = datetime('now'), source_data_ids = ?
    WHERE id = ?
  `).run(newValue, newRevision, newSourceIds, existing.id);

  recordRevision(
    existing.id, newRevision,
    existing.value, newValue,
    "active", "active",
    changedBy, reasonStr, newSourceIds,
  );

  console.log(`[living-memory] Updated ${existing.section}.${existing.key} (rev ${newRevision}) for chat=${chatId}`);

  return {
    success: true,
    message: `Updated "${existing.section}.${existing.key}" (rev ${newRevision})`,
    entry: {
      id: existing.id,
      section: existing.section,
      key: existing.key,
      value: newValue,
      status: "active",
      revision: newRevision,
    },
  };
}

function doSupersede(
  d: Database.Database,
  chatId: string,
  section: string,
  key: string,
  input: LivingMemoryUpdateInput,
): LivingMemoryUpdateResult {
  if (!input.value) {
    return { success: false, message: "Value is required for supersede" };
  }
  const valueError = validateValue(input.value);
  if (valueError) {
    return { success: false, message: valueError };
  }

  const existing = d.prepare(`
    SELECT id, section, key, value, revision, source_data_ids FROM living_memory
    WHERE chat_id = ? AND section = ? AND key = ? AND status = 'active'
  `).get(chatId, section, key) as LivingMemoryRow | undefined;

  if (!existing) {
    return { success: false, message: `No active entry found for "${section}.${key}"` };
  }

  const changedBy = "agent";
  const reason = input.reason || null;
  const sourceIds = input.source_data_ids ? JSON.stringify(input.source_data_ids) : null;

  // Transaction: mark old as superseded, create new entry
  const transaction = d.transaction(() => {
    // Mark old as superseded
    d.prepare(`
      UPDATE living_memory SET status = 'superseded', updated_at = datetime('now')
      WHERE id = ?
    `).run(existing.id);

    recordRevision(
      existing.id, existing.revision,
      existing.value, input.value ?? null,
      "active", "superseded",
      changedBy, reason, existing.source_data_ids,
    );

    // Create new entry
    const newResult = d.prepare(`
      INSERT INTO living_memory (chat_id, section, key, value, status, revision, source_data_ids)
      VALUES (?, ?, ?, ?, 'active', 1, ?)
    `).run(chatId, section, key, input.value, sourceIds);

    const newEntryId = Number(newResult.lastInsertRowid);

    // Link old entry to new
    d.prepare(`UPDATE living_memory SET superseded_by = ? WHERE id = ?`).run(newEntryId, existing.id);

    recordRevision(
      newEntryId, 1,
      null, input.value ?? null,
      null, "active",
      changedBy, reason, sourceIds,
    );

    return newEntryId;
  });

  const newEntryId = transaction();

  console.log(`[living-memory] Superseded ${section}.${key} (id=${existing.id} → ${newEntryId}) for chat=${chatId}`);

  return {
    success: true,
    message: `Superseded "${section}.${key}" with new entry (id=${newEntryId})`,
    entry: { id: newEntryId, section, key, value: input.value, status: "active", revision: 1 },
  };
}

function doExpire(
  d: Database.Database,
  chatId: string,
  section: string,
  key: string,
  input: LivingMemoryUpdateInput,
): LivingMemoryUpdateResult {
  const existing = d.prepare(`
    SELECT id, value, revision, status FROM living_memory
    WHERE chat_id = ? AND section = ? AND key = ? AND status = 'active'
  `).get(chatId, section, key) as LivingMemoryRow | undefined;

  if (!existing) {
    return { success: false, message: `No active entry found for "${section}.${key}"` };
  }

  const changedBy = "agent";
  const reason = input.reason || null;

  d.prepare(`
    UPDATE living_memory SET status = 'expired', updated_at = datetime('now')
    WHERE id = ?
  `).run(existing.id);

  recordRevision(
    existing.id, existing.revision,
    existing.value, existing.value,
    "active", "expired",
    changedBy, reason, null,
  );

  console.log(`[living-memory] Expired ${section}.${key} (id=${existing.id}) for chat=${chatId}`);

  return {
    success: true,
    message: `Expired "${section}.${key}"`,
    entry: { id: existing.id, section, key, value: existing.value, status: "expired", revision: existing.revision },
  };
}

function doReactivate(
  d: Database.Database,
  chatId: string,
  section: string,
  key: string,
  input: LivingMemoryUpdateInput,
): LivingMemoryUpdateResult {
  // Find the entry in superseded or expired status
  const existing = d.prepare(`
    SELECT id, value, revision, status, superseded_by FROM living_memory
    WHERE chat_id = ? AND section = ? AND key = ? AND status IN ('superseded', 'expired')
    ORDER BY updated_at DESC LIMIT 1
  `).get(chatId, section, key) as LivingMemoryRow | undefined;

  if (!existing) {
    return { success: false, message: `No superseded/expired entry found for "${section}.${key}"` };
  }

  const changedBy = "agent";
  const reason = input.reason || null;

  const transaction = d.transaction(() => {
    // If superseded_by points to an active entry, expire that one first
    if (existing.superseded_by) {
      const superseding = d.prepare(`
        SELECT id, status FROM living_memory WHERE id = ?
      `).get(existing.superseded_by) as LivingMemoryRow | undefined;

      if (superseding && superseding.status === "active") {
        d.prepare(`UPDATE living_memory SET status = 'expired', updated_at = datetime('now') WHERE id = ?`)
          .run(superseding.id);
        recordRevision(
          superseding.id, 1,
          null, null,
          "active", "expired",
          changedBy, "Entry superseded by reactivation of original", null,
        );
      }
    }

    // Reactivate the target entry
    const newRevision = existing.revision + 1;
    d.prepare(`
      UPDATE living_memory SET status = 'active', revision = ?, updated_at = datetime('now'), superseded_by = NULL
      WHERE id = ?
    `).run(newRevision, existing.id);

    recordRevision(
      existing.id, newRevision,
      existing.value, existing.value,
      existing.status, "active",
      changedBy, reason, null,
    );
  });

  transaction();

  console.log(`[living-memory] Reactivated ${section}.${key} (id=${existing.id}) for chat=${chatId}`);

  return {
    success: true,
    message: `Reactivated "${section}.${key}" (rev ${existing.revision + 1})`,
    entry: {
      id: existing.id,
      section,
      key,
      value: existing.value,
      status: "active",
      revision: existing.revision + 1,
    },
  };
}

function doList(
  d: Database.Database,
  chatId: string,
  section: string,
  _key: string,
): LivingMemoryUpdateResult {
  const rows = d.prepare(`
    SELECT id, section, key, value, status, revision, created_at, updated_at, expires_at
    FROM living_memory
    WHERE chat_id = ? AND section = ?
    ORDER BY status ASC, updated_at DESC
  `).all(chatId, section) as LivingMemoryRow[];

  if (rows.length === 0) {
    return { success: true, message: `No entries in section "${section}"` };
  }

  const lines = rows.map((r) => {
    const expiry = r.expires_at ? ` (expires: ${r.expires_at})` : "";
    return `  [${r.status}] ${r.key} (rev ${r.revision}, id=${r.id})${expiry}: ${r.value.slice(0, 100)}`;
  });

  return {
    success: true,
    message: `Entries in "${section}":\n${lines.join("\n")}`,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface LivingMemoryEntry {
  id: number;
  section: string;
  key: string;
  value: string;
  status: string;
  revision: number;
  source_data_ids: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

/**
 * Render Living Memory for a given chat as a structured text block.
 * Returns null if no entries exist or the chat has no Living Memory.
 */
export function renderLivingMemory(chatId: string): string | null {
  const d = getDb();

  // Fetch all active entries for this chat, ordered by section then recency
  const rows = d.prepare(`
    SELECT id, section, key, value, status, revision, source_data_ids,
           created_at, updated_at, expires_at
    FROM living_memory
    WHERE chat_id = ? AND status = 'active'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY section ASC, updated_at DESC
  `).all(chatId) as LivingMemoryEntry[];

  if (rows.length === 0) return null;

  // Group by section
  const grouped = new Map<string, LivingMemoryEntry[]>();
  for (const row of rows) {
    const sec = row.section;
    if (!grouped.has(sec)) grouped.set(sec, []);
    grouped.get(sec)!.push(row);
  }

  // Build rendered sections, applying per-section entry limits and char budgets
  const sections: string[] = [];
  let totalChars = 0;

  // Determine the latest revision timestamp
  const latestUpdated = rows.reduce((latest, r) => r.updated_at > latest ? r.updated_at : latest, rows[0].updated_at);
  const latestRevision = rows.reduce((max, r) => r.revision > max ? r.revision : max, 0);

  // Section display names
  const sectionTitles: Record<string, string> = {
    identity: "Identity",
    preferences: "Preferences",
    active_context: "Active Context",
    decisions: "Decisions",
    infrastructure: "Infrastructure",
    open_items: "Open Items",
  };

  // Only render sections that have entries
  for (const section of VALID_SECTIONS) {
    const entries = grouped.get(section);
    if (!entries || entries.length === 0) continue;

    const title = sectionTitles[section] || section;
    let sectionLines: string[] = [`## ${title}`];

    const sectionBudget = SECTION_CHAR_BUDGETS[section];
    const maxEntries = SECTION_MAX_ENTRIES[section];

    // Apply per-section entry limit (keep most recent)
    const limited = entries.slice(0, maxEntries);

    for (const entry of limited) {
      const line = `- ${entry.key}: ${entry.value}`;
      sectionLines.push(line);
    }

    let sectionText = sectionLines.join("\n");

    // Enforce per-section char budget (drop oldest entries if over)
    if (sectionText.length > sectionBudget) {
      // Try dropping entries one by one from the end (oldest first within limit)
      while (limited.length > 1 && sectionText.length > sectionBudget) {
        limited.pop();
        sectionLines = [`## ${title}`];
        for (const entry of limited) {
          sectionLines.push(`- ${entry.key}: ${entry.value}`);
        }
        sectionText = sectionLines.join("\n");
      }
    }

    // Even if still over budget, truncate the value text as last resort
    if (sectionText.length > sectionBudget) {
      sectionText = sectionText.slice(0, sectionBudget - 3) + "...";
    }

    sections.push(sectionText);
    totalChars += sectionText.length;
  }

  if (sections.length === 0) return null;

  let fullText = `<living_memory>\n# Living Memory (rev ${latestRevision}, updated ${latestUpdated})\n\n`;
  fullText += sections.join("\n\n");
  fullText += `\n</living_memory>`;

  // Enforce total char budget by dropping sections in reverse priority
  if (fullText.length > TOTAL_CHAR_BUDGET) {
    // Rebuild, dropping lowest-priority sections first
    const priorityOrder = [...TRUNCATION_PRIORITY].reverse();
    const keptSections: string[] = [];

    for (const section of priorityOrder) {
      const entries = grouped.get(section);
      if (!entries || entries.length === 0) continue;

      const title = sectionTitles[section] || section;
      let sectionLines: string[] = [`## ${title}`];
      const maxEntries = SECTION_MAX_ENTRIES[section];
      const limited = entries.slice(0, maxEntries);

      for (const entry of limited) {
        sectionLines.push(`- ${entry.key}: ${entry.value}`);
      }
      let sectionText = sectionLines.join("\n");

      // Apply per-section budget
      const sectionBudget = SECTION_CHAR_BUDGETS[section];
      if (sectionText.length > sectionBudget) {
        while (limited.length > 1 && sectionText.length > sectionBudget) {
          limited.pop();
          sectionLines = [`## ${title}`];
          for (const entry of limited) {
            sectionLines.push(`- ${entry.key}: ${entry.value}`);
          }
          sectionText = sectionLines.join("\n");
        }
      }

      keptSections.push(sectionText);
    }

    // Now rebuild full text with only kept sections
    const keptText = `<living_memory>\n# Living Memory (rev ${latestRevision}, updated ${latestUpdated})\n\n`;
    fullText = keptText + keptSections.join("\n\n") + `\n</living_memory>`;

    // Final safety: if still over budget, hard truncate
    if (fullText.length > TOTAL_CHAR_BUDGET) {
      fullText = fullText.slice(0, TOTAL_CHAR_BUDGET - 3) + "...";
    }
  }

  return fullText;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

interface LivingMemoryStats {
  totalEntries: number;
  activeEntries: number;
  supersededEntries: number;
  expiredEntries: number;
  revisionCount: number;
  sections: Record<string, number>;
}

export function getLivingMemoryStats(chatId?: string): LivingMemoryStats {
  const d = getDb();
  const chatFilter = chatId ? "WHERE chat_id = ?" : "WHERE 1=1";
  const chatParams = chatId ? [chatId] : [];

  const total = d.prepare(`SELECT COUNT(*) as c FROM living_memory ${chatFilter}`).get(...chatParams) as { c: number };
  const active = d.prepare(`SELECT COUNT(*) as c FROM living_memory ${chatFilter} AND status = 'active'`).get(...chatParams) as { c: number };
  const superseded = d.prepare(`SELECT COUNT(*) as c FROM living_memory ${chatFilter} AND status = 'superseded'`).get(...chatParams) as { c: number };
  const expired = d.prepare(`SELECT COUNT(*) as c FROM living_memory ${chatFilter} AND status = 'expired'`).get(...chatParams) as { c: number };
  const revisions = d.prepare(`SELECT COUNT(*) as c FROM living_memory_revisions`).get() as { c: number };

  const sections: Record<string, number> = {};
  const rows = d.prepare(`
    SELECT section, COUNT(*) as c FROM living_memory
    ${chatFilter} AND status = 'active'
    GROUP BY section
  `).all(...chatParams) as Array<{ section: string; c: number }>;

  for (const row of rows) {
    sections[row.section] = row.c;
  }

  return {
    totalEntries: total.c,
    activeEntries: active.c,
    supersededEntries: superseded.c,
    expiredEntries: expired.c,
    revisionCount: revisions.c,
    sections,
  };
}
