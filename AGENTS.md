# AGENTS.md

## Purpose
This repo is a TypeScript Telegram-based Claude agent harness. Preserve the current architecture: SQLite-backed history, Anthropic Messages API tool loops, token-based compaction, optional vector memory, and workspace-defined subagents.

## Config
- Runtime config is TOML-only.
- Use `patronum.toml` in the workspace root.
- Do not reintroduce `.env`-based runtime config.

## Build And Verification
- After TypeScript changes, run `npm run build`.
- Treat a clean build as the minimum verification bar.
- If behavior changes touch prompts, tool loops, session history, memory, or compaction, inspect those paths carefully before editing.

## Prompting And Claude API
- Keep the main agent's `system` prompt stable unless the change intentionally modifies standing instructions.
- Do not put volatile per-turn context into the main agent's `system` unless there is a strong reason.
- Preserve Anthropic message/tool pairing rules: every `tool_result` must correspond to the immediately preceding assistant `tool_use`.
- Keep prompt-caching behavior aligned with current design:
  - stable `system` prompt for the main agent
  - message-prefix caching for prior history and tool loops
  - per-task stable system prompt for subagents (identity + SUBAGENT.md only — thread context arrives via tool result, not system prompt)
- Do not put volatile per-turn context into `extraContext`. Auto-recall and notifications go into message history as transient unsaved messages.
- When changing token accounting, preserve compaction correctness. Compaction should use total processed input, not only uncached input.

## Session And Compaction
- Preserve the semantics of `messages` and `archived_messages`.
- `agent_threads` and `agent_thread_messages` are the subagent coordination layer — do not write to these from Lin's main loop directly.
- Do not break `replaceHistory` / compaction behavior.
- When changing history handling, make sure replayed history remains valid for Anthropic's API.
- Avoid changes that can orphan `tool_result` blocks across history loads or compaction boundaries.

## Memory
- Auto-recall context is injected as transient message pairs (user + assistant ack) before the current user message — not saved to DB and not in the system prompt.
- Avoid indexing noisy or ephemeral data into memory.

## Subagents
- Subagents are workspace-defined only via `agents/<name>/SUBAGENT.md`.
- Do not assume built-in specialist agents.
- Subagent thread context is loaded live at agent start via forced `read_agent_thread` tool call — not a frozen snapshot.
- A running task retains its snapped agent definition even if workspace files change.

## Code Changes
- Do not add dependencies unless they materially simplify the design.
- Use comments to describe the intent clearly. Only comment on what's not immediately clear from scanning the code.

## Git Hygiene
- Do not rewrite history unless explicitly asked.
