import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { initSession, loadHistory, saveMessage, replaceHistory, archiveMessages } from "./session.js";
import { initThread, appendToThread, loadThread, formatThreadForContext } from "./thread.js";
import { runAgent, runAgentStreaming, extractTextFromResponse, type AgentResult } from "./agent.js";
import { DraftStreamer } from "./draft-stream.js";
import { runAgentWithSnapshot } from "./run-agent.js";
import { getAgentDef } from "./agents.js";
import { compactIfNeeded } from "./compaction.js";
import { markdownToTelegramHtml } from "./format.js";
import { setCurrentChatId, setBot, setSendMediaChatId, setSpawnCallback } from "./tools/index.js";
import { loadRestartState, clearRestartState } from "./tools/self-restart.js";
import { taskManager } from "./task-manager.js";
import { initEmbeddings, initMemoryStore, autoRecall, indexExchange, getChunkCount } from "./memory/index.js";
import type { Message } from "./types.js";

const TELEGRAM_MSG_LIMIT = 4096;

// ---------------------------------------------------------------------------
// Per-chat event queue types
// ---------------------------------------------------------------------------

type ChatEvent =
  | { type: "user_message"; text: string; ctx: import("telegraf").Context }
  | { type: "user_photo"; caption: string; imageBase64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; ctx: import("telegraf").Context }
  | { type: "agent_completion"; taskId: string; agent: string; result: string }
  | { type: "agent_failure"; taskId: string; agent: string; error: string };

interface ChatState {
  queue: ChatEvent[];
  isProcessing: boolean;
}

const chatStates = new Map<string, ChatState>();

function getChatState(chatId: string): ChatState {
  let state = chatStates.get(chatId);
  if (!state) {
    state = { queue: [], isProcessing: false };
    chatStates.set(chatId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Typing keepalive
// ---------------------------------------------------------------------------

const TYPING_INTERVAL_MS = 4000; // Telegram typing indicator lasts ~5s, refresh every 4s

function startTypingIndicator(bot: Telegraf, chatId: string): () => void {
  // Fire immediately
  bot.telegram.sendChatAction(chatId, "typing").catch(() => {});

  // Then keep refreshing until stopped
  const timer = setInterval(() => {
    bot.telegram.sendChatAction(chatId, "typing").catch(() => {});
  }, TYPING_INTERVAL_MS);

  // Return a stop function
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MSG_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MSG_LIMIT) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MSG_LIMIT);
    if (splitAt < TELEGRAM_MSG_LIMIT * 0.5) {
      splitAt = TELEGRAM_MSG_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}

async function sendMessageSafe(
  bot: Telegraf,
  chatId: number | string,
  text: string
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  try {
    await bot.telegram.sendMessage(chatId, html, {
      parse_mode: "HTML",
    });
  } catch {
    try {
      await bot.telegram.sendMessage(chatId, text);
    } catch (e2) {
      console.error("[send-fallback] Failed to send message:", e2);
    }
  }
}

// ---------------------------------------------------------------------------
// Main bot setup
// ---------------------------------------------------------------------------

export async function startBot(): Promise<void> {
  initSession();
  initThread();

  // Initialize memory system (vector search)
  if (config.voyageApiKey) {
    initEmbeddings(config.voyageApiKey);
    initMemoryStore();
    console.log(`[patronum] Memory system initialized (${getChunkCount()} chunks indexed)`);
  } else {
    console.warn("[patronum] VOYAGE_API_KEY not set — memory system disabled");
  }

  const bot = new Telegraf(config.telegramBotToken, {
    handlerTimeout: Infinity,
  });
  setBot(bot);
  const BOT_START_TIME = Math.floor(Date.now() / 1000);

  // -------------------------------------------------------------------
  // Wire up the spawn callback so spawn_agent tool can trigger bg work
  // -------------------------------------------------------------------
  setSpawnCallback((taskId, agentName, task, chatId) => {
    const agentTask = taskManager.getTask(taskId);
    if (!agentTask) return;

    // Fire-and-forget: run the agent in background
    const agentDef = getAgentDef(agentName);
    if (!agentDef) {
      taskManager.fail(taskId, `Unknown agent: ${agentName}`);
      return;
    }
    runAgentWithSnapshot(
      agentDef,
      chatId,
      task,
      agentTask.threadSnapshot,
      agentTask.abortController.signal
    )
      .then((result) => {
        taskManager.complete(taskId, result);

        // Append result to the live thread
        appendToThread(chatId, agentName as "alex" | "iris" | "quill", result);

        console.log(`[spawn] ${agentName} (${taskId}) completed (${result.length} chars)`);

        // Push completion event and process
        const state = getChatState(chatId);
        state.queue.push({
          type: "agent_completion",
          taskId,
          agent: agentName,
          result,
        });
        processQueue(chatId, bot);
      })
      .catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Don't treat cancellation as a failure that needs reporting to Lin
        if (errorMsg === "Task cancelled") {
          console.log(`[spawn] ${agentName} (${taskId}) cancelled`);
          // taskManager.cancel already set the status
          return;
        }

        taskManager.fail(taskId, errorMsg);

        // Append failure to the live thread
        appendToThread(chatId, "system", `Agent ${agentName} (task ${taskId}) failed: ${errorMsg}`);

        console.error(`[spawn] ${agentName} (${taskId}) failed:`, errorMsg);

        const state = getChatState(chatId);
        state.queue.push({
          type: "agent_failure",
          taskId,
          agent: agentName,
          error: errorMsg,
        });
        processQueue(chatId, bot);
      });
  });

  // -------------------------------------------------------------------
  // Register bot commands with Telegram (shows in "/" autocomplete menu)
  // -------------------------------------------------------------------
  bot.telegram.setMyCommands([
    { command: "status", description: "Show bot status" },
  ]).catch((err) => {
    console.error("[patronum] Failed to register bot commands:", err);
  });

  // -------------------------------------------------------------------
  // Status command handler
  // -------------------------------------------------------------------
  bot.command("status", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const now = Math.floor(Date.now() / 1000);
    const uptimeSeconds = now - BOT_START_TIME;

    // Format uptime as human-readable
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;

    let uptimeStr = "";
    if (days > 0) {
      uptimeStr = `${days}d ${hours}h`;
    } else if (hours > 0) {
      uptimeStr = `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      uptimeStr = `${minutes}m ${seconds}s`;
    } else {
      uptimeStr = `${seconds}s`;
    }

    const chunkCount = getChunkCount();
    const activeTasks = taskManager.countRunning();
    const model = config.claudeModel;

    const statusMsg = `🟢 Patronum Status

⏱ Uptime: ${uptimeStr}
🧠 Memory: ${chunkCount.toLocaleString()} chunks
⚙️ Active tasks: ${activeTasks}
🤖 Model: ${model}`;

    try {
      await bot.telegram.sendMessage(chatId, statusMsg);
    } catch (err) {
      console.error("[status] Failed to send status message:", err);
    }
  });

  // Message handler: enqueue events, don't block
  // -------------------------------------------------------------------
  bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const userText = ctx.message.text;
    const msgTime = ctx.message.date;

    if (msgTime < BOT_START_TIME - 5) {
      console.log(`[msg] dropped stale message (age=${BOT_START_TIME - msgTime}s): ${userText.slice(0, 50)}`);
      return;
    }

    console.log(`[msg] chat=${chatId}: ${userText.slice(0, 100)}`);

    // Set chat ID so tools know the current context
    setCurrentChatId(chatId);
    setSendMediaChatId(chatId);

    // Append to thread immediately
    appendToThread(chatId, "user", userText);

    // Enqueue and process
    const state = getChatState(chatId);
    state.queue.push({ type: "user_message", text: userText, ctx });
    processQueue(chatId, bot);
  });

  // Photo handler: download image, convert to base64, enqueue
  // -------------------------------------------------------------------
  bot.on("photo", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const msgTime = ctx.message.date;

    if (msgTime < BOT_START_TIME - 5) {
      console.log(`[msg] dropped stale photo (age=${BOT_START_TIME - msgTime}s)`);
      return;
    }

    const caption = ctx.message.caption || "[Image]";
    console.log(`[msg] chat=${chatId}: photo (caption: ${caption.slice(0, 100)})`);

    setCurrentChatId(chatId);
    setSendMediaChatId(chatId);

    // Take the largest photo size (last in array)
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];

    try {
      const fileLink = await ctx.telegram.getFileLink(largest.file_id);
      const response = await fetch(fileLink.href);

      if (!response.ok) {
        console.error(`[photo] Failed to download image: ${response.status}`);
        await ctx.reply("Failed to download image.");
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const imageBase64 = buffer.toString("base64");

      // Infer MIME type from URL, default to jpeg
      const url = fileLink.href.toLowerCase();
      let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" = "image/jpeg";
      if (url.includes(".png")) mediaType = "image/png";
      else if (url.includes(".gif")) mediaType = "image/gif";
      else if (url.includes(".webp")) mediaType = "image/webp";

      appendToThread(chatId, "user", caption);

      const state = getChatState(chatId);
      state.queue.push({ type: "user_photo", caption, imageBase64, mediaType, ctx });
      processQueue(chatId, bot);
    } catch (err) {
      console.error(`[photo] Error processing photo:`, err);
      try { await ctx.reply("Failed to process image."); } catch { /* ignore */ }
    }
  });

  // Graceful shutdown — register before launch so it catches signals
  const shutdown = async (signal: string) => {
    console.log(`[patronum] Received ${signal}, shutting down...`);

    // Cancel all running tasks
    for (const [, state] of chatStates) {
      // No need to process completions on shutdown
      state.queue = [];
    }

    // Send offline message BEFORE stopping bot, with 2-second timeout
    if (config.ownerChatId) {
      try {
        await Promise.race([
          bot.telegram.sendMessage(config.ownerChatId, "🔴 Patronum offline"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
        ]);
      } catch (err) {
        console.error("[patronum] Failed to send shutdown notification:", err);
      }
    }
    bot.stop(signal);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // Launch with retry — Telegram sometimes holds polling sessions for 30-60s
  let launchAttempts = 0;
  const maxAttempts = 5;
  let lastError: Error | null = null;

  while (launchAttempts < maxAttempts) {
    try {
      await new Promise<void>((resolve, reject) => {
        bot.launch({ allowedUpdates: ["message"] })
          .then(() => resolve())
          .catch(reject);
      });
      break; // Success
    } catch (err) {
      launchAttempts++;
      lastError = err as Error;
      if (launchAttempts < maxAttempts) {
        const waitMs = Math.min(1500 * Math.pow(2, launchAttempts - 1), 60000);
        if (lastError.message.includes("409")) {
          console.warn(`[patronum] 409 conflict on launch (attempt ${launchAttempts}/${maxAttempts}) — waiting ${waitMs}ms for Telegram session to release`);
        } else {
          console.warn(`[patronum] Launch failed (attempt ${launchAttempts}/${maxAttempts}), retrying in ${waitMs}ms: ${lastError.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  if (launchAttempts >= maxAttempts) {
    console.error(`[patronum] Failed to launch after ${maxAttempts} attempts:`, lastError);
    process.exit(1);
  }

  console.log("[patronum] Bot started (async multi-agent mode)");

  // Check for restart resume state and send notifications BEFORE launch blocking
  const restartState = loadRestartState();
  if (restartState && restartState.chatId) {
    console.log(`[patronum] Resuming after restart: ${restartState.reason}`);

    // Send "back online" notification and clear state (resume succeeded)
    // Give it 3 seconds to settle before injecting resume context
    setTimeout(() => {
      bot.telegram.sendMessage(restartState.chatId, "🟢 Back online!").then(() => {
        clearRestartState();
      }).catch((err) => {
        console.error("[patronum] Failed to send restart notification:", err);
        clearRestartState(); // clear anyway — don't want a Telegram error to cause a loop
      });

      // If there's resume context, inject it as a synthetic message to continue work
      if (restartState.resumeContext) {
        setTimeout(() => {
          const resumeText = `[system] Resumed after restart (${restartState.reason}). Resume context: ${restartState.resumeContext}`;
          const state = getChatState(restartState.chatId);
          // Create a synthetic event to trigger the agent
          const syntheticEvent: ChatEvent = {
            type: "agent_completion",
            taskId: "restart-resume",
            agent: "system",
            result: resumeText,
          };
          state.queue.push(syntheticEvent);
          processQueue(restartState.chatId, bot);
        }, 1000); // small delay after "back online" to let it send
      }
    }, 3000); // 3s delay to let polling connection establish
  } else if (config.ownerChatId) {
    setTimeout(() => {
      bot.telegram.sendMessage(config.ownerChatId, "🟢 Patronum online").catch((err) => {
        console.error("[patronum] Failed to send startup notification:", err);
      });
    }, 3000); // 3s delay to let polling connection establish
  }

  // Log on startup that in-memory tasks are cleared
  console.log("[patronum] TaskManager reset — any previously running tasks are lost.");
}

// ---------------------------------------------------------------------------
// Per-chat queue processor
// ---------------------------------------------------------------------------

async function processQueue(
  chatId: string,
  bot: Telegraf,
): Promise<void> {
  const state = getChatState(chatId);

  // If already processing, the current run will drain the queue when done
  if (state.isProcessing) return;

  state.isProcessing = true;

  try {
    while (state.queue.length > 0) {
      const event = state.queue.shift()!;

      try {
        await handleEvent(event, chatId, bot);
      } catch (err) {
        console.error(`[processQueue] Error handling event in chat=${chatId}:`, err);
        const errMsg = err instanceof Error ? err.message : String(err);

        // Try to notify user of the error
        try {
          await bot.telegram.sendMessage(chatId, `Error: ${errMsg.slice(0, 500)}`);
        } catch {
          console.error(`[processQueue] Failed to send error message to chat=${chatId}`);
        }
      }
    }
  } finally {
    state.isProcessing = false;
  }
}

async function handleEvent(
  event: ChatEvent,
  chatId: string,
  bot: Telegraf,
): Promise<void> {
  // Ensure tools point to correct chat
  setCurrentChatId(chatId);
  setSendMediaChatId(chatId);

  // Show typing indicator — keepalive loop so it persists for long turns
  const stopTyping = startTypingIndicator(bot, chatId);

  try {

  // Build extra context based on event type
  let extraContext: string[] = [];

  if (event.type === "agent_completion") {
    const notification = [
      `[Background Task Completed]`,
      `Agent: ${event.agent} (task ${event.taskId})`,
      `Result:`,
      event.result.slice(0, 5000), // cap what Lin sees in the notification (full result is in thread)
    ].join("\n");
    extraContext = [notification];
  } else if (event.type === "agent_failure") {
    const notification = [
      `[Background Task Failed]`,
      `Agent: ${event.agent} (task ${event.taskId})`,
      `Error: ${event.error}`,
    ].join("\n");
    extraContext = [notification];
  }

  // Load session history and thread
  const history = loadHistory(chatId);

  // For user messages (text or photo), add to session history
  if (event.type === "user_message") {
    const userMessage: Message = { role: "user", content: event.text };
    history.push(userMessage);
    saveMessage(chatId, userMessage);
  } else if (event.type === "user_photo") {
    // Build vision message with image + caption for Claude
    const visionMessage: Message = {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: event.mediaType,
            data: event.imageBase64,
          },
        },
        {
          type: "text",
          text: event.caption,
        },
      ],
    };
    // Push full vision message (with image) to in-memory history for this turn
    history.push(visionMessage);
    // Save only caption text to SQLite — don't persist image bytes
    const storageMessage: Message = { role: "user", content: event.caption };
    saveMessage(chatId, storageMessage);
  } else {
    // For agent events, inject a synthetic user message so Lin can respond
    const systemText =
      event.type === "agent_completion"
        ? `[system] Background task completed: ${event.agent} (${event.taskId})\nResult: ${event.result.slice(0, 2000)}`
        : `[system] Background task failed: ${event.agent} (${event.taskId})\nError: ${event.error}`;

    const syntheticMessage: Message = { role: "user", content: systemText };
    history.push(syntheticMessage);
    saveMessage(chatId, syntheticMessage);
  }

  // Load thread context
  const thread = loadThread(chatId);
  const threadContext = formatThreadForContext(thread);

  // Auto-recall: find relevant past context for user messages
  if (config.voyageApiKey && (event.type === "user_message" || event.type === "user_photo")) {
    try {
      const queryText = event.type === "user_message" ? event.text : event.caption;
      const recallContext = await autoRecall(queryText);
      if (recallContext) {
        extraContext.push(recallContext);
        console.log(`[bot] Auto-recall injected context for chat=${chatId}`);
      }
    } catch (err) {
      console.error(`[bot] Auto-recall failed (continuing):`, err);
    }
  }

  // Run Lin with streaming responses
  const draftStreamer = new DraftStreamer(bot, chatId);

  const agentResult = await runAgentStreaming(
    history,
    {
      onTextDelta: (_delta: string, fullText: string) => {
        draftStreamer.update(fullText);
      },
      onToolStart: (toolName: string) => {
        console.log(`[stream] Tool starting: ${toolName}`);
      },
      onToolEnd: (toolName: string) => {
        console.log(`[stream] Tool completed: ${toolName}`);
      },
    },
    {
      model: config.claudeModel,
      workspace: config.workspace,
      extraContext: [threadContext, ...extraContext],
    }
  );

  // Stop the draft streamer before sending the final message
  draftStreamer.stop();

  const { messages: newMessages, inputTokens } = agentResult;

  // Save all new messages to session history
  for (const msg of newMessages) {
    saveMessage(chatId, msg);
  }

  // Token-based compaction
  const model = config.claudeModel;
  const fullHistory = [...history, ...newMessages];
  const { messages: compactedHistory, compacted } = await compactIfNeeded(
    fullHistory,
    inputTokens,
    model
  );
  if (compacted) {
    // Archive the messages that will be replaced (everything not in the compacted set)
    // The compacted set starts with a summary + ack, so the original messages being
    // summarized are everything before the kept tail in fullHistory.
    // Archive the entire pre-compaction history so nothing is lost.
    archiveMessages(chatId, fullHistory, "70% context window");
    replaceHistory(chatId, compactedHistory);
    history.splice(0, history.length, ...compactedHistory);
  }

  // Extract reply text
  const reply = extractTextFromResponse(newMessages);

  // Append Lin's response to the shared thread
  appendToThread(chatId, "main", reply);

  // Post-turn: index this exchange into vector memory
  if (config.voyageApiKey && (event.type === "user_message" || event.type === "user_photo")) {
    // Fire-and-forget — don't block the reply
    const exchangeText = event.type === "user_message" ? event.text : event.caption;
    indexExchange(chatId, exchangeText, newMessages).catch((err) => {
      console.error(`[bot] Failed to index exchange:`, err);
    });
  }

  // Send to Telegram
  const chunks = splitMessage(reply);
  for (const chunk of chunks) {
    await sendMessageSafe(bot, chatId, chunk);
  }

  } finally {
    stopTyping();
  }
}
