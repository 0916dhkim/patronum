/**
 * Backfill script: index existing conversation history into vector memory.
 * Run once: npx tsx scripts/backfill-memory.ts
 */

import Database from "better-sqlite3";
import path from "path";
import { initConfig, config } from "../src/config.js";
import { initEmbeddings, embed } from "../src/memory/embeddings.js";
import { initMemoryStore, storeChunk, getChunkCount } from "../src/memory/store.js";

interface Row {
  id: number;
  chat_id: string;
  role: string;
  content_json: string;
  created_at: string;
}

async function main() {
  await initConfig();

  if (!config.voyageApiKey) {
    console.error("Missing config: credentials.voyage_api_key in patronum.toml");
    process.exit(1);
  }

  initEmbeddings(config.voyageApiKey);
  initMemoryStore();

  const existingCount = getChunkCount();
  if (existingCount > 0) {
    console.log(`Already have ${existingCount} chunks. Continuing from where we left off.`);
  }

  const workspaceDbPath = path.join(config.workspace, "patronum.db");
  const db = new Database(workspaceDbPath, { readonly: true });

  // Load all messages ordered by id
  const rows = db
    .prepare(`SELECT id, chat_id, role, content_json, created_at FROM messages ORDER BY id ASC`)
    .all() as Row[];

  console.log(`Found ${rows.length} messages to process`);

  // Pair into user+assistant exchanges
  interface Exchange {
    chatId: string;
    userText: string;
    assistantText: string;
    turnNumber: number;
  }

  const exchanges: Exchange[] = [];
  let turnNum = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.role !== "user") continue;

    // Parse user content
    const content = JSON.parse(row.content_json);
    let userText: string;
    if (typeof content === "string") {
      userText = content;
    } else if (Array.isArray(content)) {
      // Could be tool_result blocks — skip those
      const textParts = content.filter((b: any) => b.type === "text").map((b: any) => b.text);
      if (textParts.length === 0) continue;
      userText = textParts.join("\n");
    } else {
      continue;
    }

    // Skip system/synthetic messages
    if (userText.startsWith("[system]") || userText.startsWith("[Conversation summary")) continue;

    // Find the next assistant message
    let assistantText = "";
    const toolNames: string[] = [];
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].role === "user") break; // next user msg = end of this exchange
      if (rows[j].role === "assistant") {
        const aContent = JSON.parse(rows[j].content_json);
        if (typeof aContent === "string") {
          assistantText += aContent;
        } else if (Array.isArray(aContent)) {
          for (const block of aContent) {
            if (block.type === "text") assistantText += block.text + "\n";
            if (block.type === "tool_use") toolNames.push(block.name);
          }
        }
      }
    }

    if (!assistantText.trim()) continue;

    let chunkText = `User: ${userText}\nAssistant: ${assistantText.trim()}`;
    if (toolNames.length > 0) {
      chunkText += `\n[tools: ${toolNames.join(", ")}]`;
    }

    exchanges.push({
      chatId: row.chat_id,
      userText: chunkText,
      assistantText,
      turnNumber: turnNum++,
    });
  }

  console.log(`Parsed ${exchanges.length} exchanges to index`);

  // Batch embed (Voyage supports up to 128 per request, use batches of 64)
  const BATCH_SIZE = 64;
  let indexed = 0;

  for (let i = 0; i < exchanges.length; i += BATCH_SIZE) {
    const batch = exchanges.slice(i, i + BATCH_SIZE);
    const texts = batch.map((e) => e.userText);

    console.log(`Embedding batch ${Math.floor(i / BATCH_SIZE) + 1} (${texts.length} chunks)...`);

    const embeddings = await embed(texts);

    for (let j = 0; j < batch.length; j++) {
      storeChunk(batch[j].chatId, batch[j].userText, embeddings[j], {
        turnNumber: batch[j].turnNumber,
        chunkType: "conversation",
      });
      indexed++;
    }
  }

  console.log(`Done! Indexed ${indexed} exchanges. Total chunks: ${getChunkCount()}`);
  db.close();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
