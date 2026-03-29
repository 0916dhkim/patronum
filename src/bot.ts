import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { initSession, loadHistory, saveMessage, replaceHistory } from "./session.js";
import { initThread, appendToThread, loadThread, formatThreadForContext, compactThread } from "./thread.js";
import { runAgent, extractTextFromResponse, type AgentResult } from "./agent.js";
import { runAgentWithSnapshot } from "./run-agent.js";
import { compactIfNeeded } from "./compaction.js";
import { markdownToTelegramHtml } from "./format.js";
import { setCurrentChatId, setBot, setSendMediaChatId, setSpawnCallback } from "./tools/index.js";
import { AGENTS } from "./agents.js";
import { taskManager } from "./task-manager.js";
import type { Message } from "./types.js";

const TELEGRAM_MSG_LIMIT = 4096;

// ---------------------------------------------------------------------------
// Per-chat event queue types
// ---------------------------------------------------------------------------

type ChatEvent =
  | { type: "user_message"; text: string; ctx: import("telegraf").Context }
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

export function startBot(): void {
  initSession();
  initThread();

  const bot = new Telegraf(config.telegramBotToken, {
    handlerTimeout: Infinity,
  });
  setBot(bot);
  const linAgent = AGENTS.lin;
  const BOT_START_TIME = Math.floor(Date.now() / 1000);

  // -------------------------------------------------------------------
  // Wire up the spawn callback so spawn_agent tool can trigger bg work
  // -------------------------------------------------------------------
  setSpawnCallback((taskId, agentName, task, chatId) => {
    const agentTask = taskManager.getTask(taskId);
    if (!agentTask) return;

    // Fire-and-forget: run the agent in background
    runAgentWithSnapshot(
      agentName,
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
        processQueue(chatId, bot, linAgent);
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
        processQueue(chatId, bot, linAgent);
      });
  });

  // -------------------------------------------------------------------
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
    processQueue(chatId, bot, linAgent);
  });

  bot.launch({ allowedUpdates: ["message"] });
  console.log("[patronum] Bot started (async multi-agent mode)");

  if (config.ownerChatId) {
    bot.telegram.sendMessage(config.ownerChatId, "🟢 Patronum online (async mode)").catch((err) => {
      console.error("[patronum] Failed to send startup notification:", err);
    });
  }

  // Log on startup that in-memory tasks are cleared
  console.log("[patronum] TaskManager reset — any previously running tasks are lost.");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[patronum] Received ${signal}, shutting down...`);

    // Cancel all running tasks
    for (const [, state] of chatStates) {
      // No need to process completions on shutdown
      state.queue = [];
    }

    if (config.ownerChatId) {
      try {
        await bot.telegram.sendMessage(config.ownerChatId, "🔴 Patronum offline");
      } catch (err) {
        console.error("[patronum] Failed to send shutdown notification:", err);
      }
    }
    bot.stop(signal);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Per-chat queue processor
// ---------------------------------------------------------------------------

async function processQueue(
  chatId: string,
  bot: Telegraf,
  linAgent: { model: string; workspaceDir: string }
): Promise<void> {
  const state = getChatState(chatId);

  // If already processing, the current run will drain the queue when done
  if (state.isProcessing) return;

  state.isProcessing = true;

  try {
    while (state.queue.length > 0) {
      const event = state.queue.shift()!;

      try {
        await handleEvent(event, chatId, bot, linAgent);
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
  linAgent: { model: string; workspaceDir: string }
): Promise<void> {
  // Ensure tools point to correct chat
  setCurrentChatId(chatId);
  setSendMediaChatId(chatId);

  // Show typing indicator
  try {
    await bot.telegram.sendChatAction(chatId, "typing");
  } catch {
    // Non-critical
  }

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

  // Auto-compact thread before running Lin
  try {
    const didCompact = await compactThread(chatId);
    if (didCompact) {
      console.log(`[bot] Thread compacted for chat=${chatId}`);
    }
  } catch (err) {
    console.error(`[bot] Thread compaction failed (continuing):`, err);
  }

  // Load session history and thread
  const history = loadHistory(chatId);

  // For user messages, add to session history
  if (event.type === "user_message") {
    const userMessage: Message = { role: "user", content: event.text };
    history.push(userMessage);
    saveMessage(chatId, userMessage);
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

  // Run Lin
  const agentResult = await runAgent(history, {
    model: linAgent.model,
    workspace: linAgent.workspaceDir,
    extraContext: [threadContext, ...extraContext],
  });

  const { messages: newMessages, inputTokens } = agentResult;

  // Save all new messages to session history
  for (const msg of newMessages) {
    saveMessage(chatId, msg);
  }

  // Token-based compaction
  const model = linAgent.model;
  const { messages: compactedHistory, compacted } = await compactIfNeeded(
    [...history, ...newMessages],
    inputTokens,
    model
  );
  if (compacted) {
    replaceHistory(chatId, compactedHistory);
    history.splice(0, history.length, ...compactedHistory);
  }

  // Extract reply text
  const reply = extractTextFromResponse(newMessages);

  // Append Lin's response to the shared thread
  appendToThread(chatId, "lin", reply);

  // Send to Telegram
  const chunks = splitMessage(reply);
  for (const chunk of chunks) {
    await sendMessageSafe(bot, chatId, chunk);
  }
}
