/**
 * `living_memory_update` tool — the agent's interface for updating
 * its always-present structured context (Living Memory).
 *
 * All mutations go through this tool: create, update, supersede, expire,
 * reactivate, and list. Every change is validated, atomic, and audited
 * in the living_memory_revisions table.
 */

import type { ToolHandler } from "../types.js";
import { applyLivingMemoryUpdate, getLivingMemoryStats } from "../memory/living.js";
import { getCurrentChatId } from "./chat-context.js";

export const livingMemoryUpdateTool: ToolHandler = {
  definition: {
    name: "living_memory_update",
    description:
      "Update your Living Memory — the always-present structured context " +
      "that summarizes what you know about the user, projects, and current state. " +
      "Use 'create' for new entries, 'update' to modify existing ones, " +
      "'supersede' to replace a stale fact with a new value, " +
      "'expire' to mark an entry as no longer relevant, " +
      "'reactivate' to restore a superseded/expired entry, " +
      "'list' to view all entries in a section.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "supersede", "expire", "reactivate", "list"],
          description: "What to do with the entry",
        },
        section: {
          type: "string",
          description:
            "Section: identity|preferences|active_context|decisions|infrastructure|open_items",
        },
        key: {
          type: "string",
          description: "Entry key within section (e.g. 'owner_name')",
        },
        value: {
          type: "string",
          description: "Entry value content (for create/update/supersede)",
        },
        source_data_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional Cognee data_id references for provenance",
        },
        expires_at: {
          type: "string",
          description: "Optional ISO timestamp for auto-expiry",
        },
        reason: {
          type: "string",
          description: "Why this change is being made (for audit trail)",
        },
      },
      required: ["action", "section", "key"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const action = input.action as string;
    const section = input.section as string;
    const key = input.key as string;
    const value = input.value as string | undefined;
    const sourceDataIds = input.source_data_ids as string[] | undefined;
    const expiresAt = input.expires_at as string | undefined;
    const reason = input.reason as string | undefined;

    const chatId = getCurrentChatId();
    if (!chatId) {
      return "Error: No chat context — cannot determine chat_id. This tool must be called within a conversation.";
    }

    const result = applyLivingMemoryUpdate({
      action: action as any,
      section,
      key,
      value,
      source_data_ids: sourceDataIds,
      expires_at: expiresAt,
      reason,
      chat_id: chatId,
    });

    if (!result.success) {
      return `Error: ${result.message}`;
    }

    // For list action, return the result directly
    if (action === "list") {
      return result.message;
    }

    // Build a friendly confirmation with the entry details
    const entry = result.entry;
    let response = `✅ Living Memory updated: ${result.message}`;

    if (entry) {
      response += `\n\nSection: ${entry.section}\nKey: ${entry.key}\nStatus: ${entry.status}\nRevision: ${entry.revision}`;
      if (entry.value) {
        response += `\nValue: ${entry.value.slice(0, 200)}${entry.value.length > 200 ? "..." : ""}`;
      }
    }

    // Add current stats
    const stats = getLivingMemoryStats(chatId);
    response += `\n\n📊 Living Memory: ${stats.activeEntries} active entries across ${Object.keys(stats.sections).length} sections`;

    return response;
  },
};