import { Telegraf } from "telegraf";
import { config } from "./config.js";
import { initSession, loadHistory, saveMessage, replaceHistory, archiveMessages } from "./session.js";
import { initThread, appendToThread } from "./thread.js";
import { runAgent, extractTextFromResponse, type AgentResult } from "./agent.js";
import { runAgentWithSnapshot } from "./run-agent.js";
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

function buildRecallAugmentedMessage(message: Message, recallContext: string): Message {
  if (message.role !== "user") return message;

  return {
    role: "user",
    content: [
      { type: "text", text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) },
      { type: "text", text: recallContext },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main bot setup
// ---------------------------------------------------------------------------

export function startBot(): void {
  initSession();
  initThread();

  // Initialize memory system (vector search)
  if (config.voyageApiKey) {
    initEmbeddings(config.voyageApiKey);
    initMemoryStore();
    console.log(`[patronum] Memory system initialized (${getChunkCount()} chunks indexed)`);
  } else {
    console.warn("[patronum] credentials.voyage_api_key not set in patronum.toml — memory system disabled");
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
    runAgentWithSnapshot(
      agentTask.agentDef,
      chatId,
      task,
      agentTask.threadSnapshot,
      agentTask.abortController.signal
    )
      .then((result) => {
        taskManager.complete(taskId, result);

        // Append result to the live thread
        appendToThread(chatId, agentName, result);

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

        // Don't treat cancellation as a failure that needs reporting to the main agent
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

  bot.launch({ allowedUpdates: ["message"] });
  console.log("[patronum] Bot started (async multi-agent mode)");

  // Check for restart resume state
  const restartState = loadRestartState();
  if (restartState && restartState.chatId) {
    console.log(`[patronum] Resuming after restart: ${restartState.reason}`);

    // Send "back online" notification and clear state (resume succeeded)
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
      }, 2000); // small delay to let Telegram settle
    }
  } else if (config.ownerChatId) {
    bot.telegram.sendMessage(config.ownerChatId, "🟢 Patronum online").catch((err) => {
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

  // Load session history
  const history = loadHistory(chatId);
  const completedPrefixLength = history.length;

  // For user messages, add to session history
  if (event.type === "user_message") {
    const userMessage: Message = { role: "user", content: event.text };
    history.push(userMessage);
    saveMessage(chatId, userMessage);
  } else {
    // For agent events, inject a synthetic user message so the main agent can respond
    const systemText =
      event.type === "agent_completion"
        ? `[system] Background task completed: ${event.agent} (${event.taskId})\nResult: ${event.result.slice(0, 2000)}`
        : `[system] Background task failed: ${event.agent} (${event.taskId})\nError: ${event.error}`;

    const syntheticMessage: Message = { role: "user", content: systemText };
    history.push(syntheticMessage);
    saveMessage(chatId, syntheticMessage);
  }

  const agentHistory = [...history];

  // Auto-recall: attach relevant past context to the current user turn only.
  if (config.voyageApiKey && event.type === "user_message") {
    try {
      const recallContext = await autoRecall(event.text);
      if (recallContext) {
        const currentMessage = agentHistory[agentHistory.length - 1];
        if (currentMessage) {
          agentHistory[agentHistory.length - 1] = buildRecallAugmentedMessage(
            currentMessage,
            recallContext
          );
          console.log(`[bot] Auto-recall attached to current turn for chat=${chatId}`);
        }
      }
    } catch (err) {
      console.error(`[bot] Auto-recall failed (continuing):`, err);
    }
  }

  // Run the main agent
  const agentResult = await runAgent(agentHistory, {
    model: config.claudeModel,
    workspace: config.workspace,
    completedPrefixLength,
  });

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

  // Append the main agent's response to the shared thread
  appendToThread(chatId, "main", reply);

  // Post-turn: index this exchange into vector memory
  if (config.voyageApiKey && event.type === "user_message") {
    // Fire-and-forget — don't block the reply
    indexExchange(chatId, event.text, newMessages).catch((err) => {
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
