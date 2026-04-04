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
  - stable `system` prefix for the main agent
  - message-prefix caching for prior history and tool loops
  - per-task stable prefix for subagents
- When changing token accounting, preserve compaction correctness. Compaction should use total processed input, not only uncached input.

## Session And Compaction
- Preserve the semantics of `messages`, `archived_messages`, and `thread_messages`.
- Do not break `replaceHistory` / compaction behavior.
- When changing history handling, make sure replayed history remains valid for Anthropic's API.
- Avoid changes that can orphan `tool_result` blocks across history loads or compaction boundaries.

## Memory
- Auto-recall is transient current-turn context, not persisted conversation text.
- `MEMORY.md` is for curated durable facts, not temporary notes.
- Avoid writing noisy or ephemeral data into memory.

## Subagents
- Subagents are workspace-defined only via `agents/<name>/SUBAGENT.md`.
- Do not assume built-in specialist agents.
- Preserve the snapshot model for spawned tasks: a running task should keep its snapped agent definition and thread snapshot even if workspace files change later.

## Code Changes
- Do not add dependencies unless they materially simplify the design.
- Use comments to describe the intent clearly. Only comment on what's not immediately clear from scanning the code.

## Git Hygiene
- Do not rewrite history unless explicitly asked.
