/**
 * Voice transcription cleanup module.
 * Uses Haiku to correct transcription errors from Whisper,
 * with recent conversation history for disambiguation context.
 * Implements cache-friendly prompt structure to maximize cost efficiency.
 */

import { config } from "./config.js";
import type { Message } from "./types.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const CLEANUP_MODEL = "claude-haiku-4-5-20251001";

const VOICE_CLEANUP_SYSTEM_PROMPT = `You are a transcription cleanup assistant for voice messages in a developer productivity tool.

Your single job: fix transcription errors only. Nothing else.

Rules:
1. Fix obviously misrecognized words (technical terms, proper nouns, domain jargon).
2. Fix homophones that make no sense in context (e.g., "waved through" vs "waived through").
3. Preserve the exact meaning, intent, and informal tone of the speaker.
4. Do NOT rephrase, reword, or "improve" the text.
5. Do NOT add punctuation beyond what was clearly implied.
6. Do NOT change informal speech into formal writing.
7. Do NOT expand abbreviations or shorthand the speaker intentionally used.
8. Do NOT hallucinate content that wasn't spoken.

You are given:
- The raw Whisper transcription
- Recent conversation context (last 4 exchanges) for disambiguation
- A vocabulary list of known technical terms and proper nouns in this domain

Output only the cleaned text, nothing else. If the transcription is already correct, output it unchanged.

Known technical terms and domain vocabulary:
Claude, Anthropic, GPT-4o, Haiku, Sonnet, Opus, TypeScript, Telegram, SearXNG, Patronum, Vaultwarden, TOML, SQLite, API, REST, JSON, Whisper, OpenAI, Visa, Visa Infinite, voice message, GitHub, pull request, code review, commit, fork, repository, branch, merge`;

/**
 * Format recent history messages for the cleanup context.
 * Returns a string with the last N exchanges formatted for readability.
 */
function formatHistoryContext(messages: Message[], windowSize: number = 4): string {
  if (messages.length === 0) {
    return "";
  }

  // Take the last N exchanges (2N messages total: user + assistant pairs)
  const recentCount = Math.min(messages.length, windowSize * 2);
  const recent = messages.slice(-recentCount);

  const formatted = recent
    .map((msg) => {
      const role = msg.role === "user" ? "User" : "Assistant";
      const content = extractTextContent(msg.content);
      // Truncate long content for context brevity
      const truncated = content.length > 300 ? content.slice(0, 300) + "…" : content;
      return `${role}: ${truncated}`;
    })
    .join("\n");

  return formatted ? `Recent conversation context:\n${formatted}` : "";
}

/**
 * Extract plain text from message content (handles both string and content blocks).
 * Images are reduced to a placeholder "[Image]" to preserve context awareness.
 */
function extractTextContent(content: string | any[]): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "image") {
        textParts.push("[Image]");
      }
    }
    return textParts.join(" ");
  }

  return "";
}

/**
 * Clean up a raw Whisper transcription using Haiku.
 * Includes recent conversation history for disambiguation context.
 * Uses cache-friendly prompt structure with static system content
 * and dynamic user content for efficient repeated calls.
 *
 * Returns the cleaned transcript, or the original on error (fail gracefully).
 */
export async function cleanupVoiceTranscript(
  rawTranscript: string,
  recentHistory: Message[]
): Promise<string> {
  try {
    // Format history for context
    const historyContext = formatHistoryContext(recentHistory, 4);

    // Build user message with history + transcript
    const userMessageText = historyContext
      ? `${historyContext}\n\nRaw transcription to clean up:\n"${rawTranscript}"`
      : `Raw transcription to clean up:\n"${rawTranscript}"`;

    // Call Haiku API
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.claudeToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-dangerous-direct-browser-access": "true",
        "user-agent": "claude-cli/2.1.85",
        "x-app": "cli",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        max_tokens: 512, // Short response expected
        system: VOICE_CLEANUP_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: userMessageText,
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      const errorMsg = `Voice cleanup API error ${response.status}: ${body}`;
      console.error(`[voice-cleanup] ${errorMsg}`);
      // Fall back to raw transcript
      return rawTranscript;
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    const cleanedText = data.content
      .find((b) => b.type === "text")
      ?.text?.trim();

    if (!cleanedText) {
      console.warn(`[voice-cleanup] Empty response from Haiku, returning raw transcript`);
      return rawTranscript;
    }

    console.log(
      `[voice-cleanup] Cleaned transcript (${rawTranscript.length} → ${cleanedText.length} chars)`
    );
    return cleanedText;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[voice-cleanup] Error: ${message}`);
    // Graceful fallback — return raw transcript and let it through
    console.log(`[voice-cleanup] Falling back to raw transcript`);
    return rawTranscript;
  }
}
