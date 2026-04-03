# patronum

Personal AI agent harness — Telegram bot + Claude + tools + vector memory.

## Quick Start

```bash
# 1. Create a workspace directory
mkdir my-workspace && cd my-workspace

# 2. Clone the repo as the source directory
git clone https://github.com/YOUR_USER/patronum.git source

# 3. Install dependencies and build
cd source && npm install && npm run build && cd ..

# 4. Create patronum.toml in the workspace root
cat > patronum.toml <<'EOF'
[patronum]
model = "claude-sonnet-4-6"
# owner_chat_id = "123456789"

[credentials]
claude_token = "oat01-..."
telegram_bot_token = "123456:ABC..."
# voyage_api_key = "..."
EOF

# 5. Run
node source/dist/index.js
```

## Configuration

Patronum requires a `patronum.toml` file in the workspace root. The process searches upward from the current working directory until it finds that file.

```toml
[patronum]
model = "claude-sonnet-4-6"
owner_chat_id = "123456789"

[credentials]
claude_token = "oat01-..."
telegram_bot_token = "123456:ABC..."
voyage_api_key = "..."
```

Required keys:

- `credentials.claude_token` — Claude OAuth token from `claude setup-token`
- `credentials.telegram_bot_token` — Telegram Bot API token from @BotFather

Optional keys:

- `patronum.model` — Claude model to use, defaults to `claude-sonnet-4-6`
- `patronum.owner_chat_id` — Telegram chat ID for startup and shutdown notifications
- `credentials.voyage_api_key` — enables vector memory search and auto-recall

Startup fails fast if the file is missing, a required section/key is missing, a value has the wrong type, or a configured string is empty.

## Workspace Structure

```
my-workspace/
├── source/           # Cloned repo (TypeScript source)
├── patronum.toml     # Required runtime config and credentials
├── agents/           # Optional workspace-defined subagents
├── SOUL.md           # Bot personality (auto-created from template if missing)
├── AGENTS.md         # Bot rules and preferences (auto-created if missing)
├── MEMORY.md         # Persistent facts (created by the bot)
├── patronum.db       # SQLite database (messages, memory, threads)
```

## Features

- **Conversation memory** — SQLite-backed message history with token-based compaction
- **Vector memory** — Voyage AI embeddings + sqlite-vec for semantic recall over past conversations
- **Auto-recall** — relevant past context automatically injected on each message
- **Self-editing** — the bot can read, edit, and rebuild its own source code
- **Dynamic subagents** — spawn background specialist agents defined in your workspace
- **Tools** — exec, read, write, edit, send media, memory search/write, self-restart

## Tools Available

- `exec` — run shell commands (30s timeout)
- `read` — read file contents
- `write` — create/overwrite files
- `edit` — find and replace in files
- `send_media` — send images/files via Telegram
- `spawn_agent` — run a configured workspace subagent in the background
- `cancel_agent` — cancel running tasks
- `list_tasks` — list active background tasks
- `memory_search` — semantic search over past conversations and curated facts
- `memory_write` — save facts to MEMORY.md + vector index
- `self_restart` — rebuild and restart (use after code changes)

## Subagents

Subagents are optional and live in the workspace, not in the repo. Patronum loads them from `agents/<folder>/SUBAGENT.md` each time it needs to list or spawn them, so changes take effect without restarting.

Example:

```text
my-workspace/
├── agents/
│   └── reviewer/
│       └── SUBAGENT.md
```

```md
---
name: reviewer
description: Reviews code changes for bugs and regressions
model: claude-sonnet-4-6
---

You are a careful code review specialist.
Focus on bugs, regressions, and missing tests.
```

Rules:

- `description` is required
- `name` is optional; if omitted, the folder name becomes the spawn name
- `model` is optional; if omitted, Patronum uses the main configured model
- Agent names must be unique after loading

If no subagents are configured, Patronum still starts, but `spawn_agent` returns a setup error that points to the expected workspace path and file format.

## Development

```bash
# Watch mode
cd source && npm run dev

# Build
cd source && npm run build

# Run from workspace
node source/dist/index.js
```

Helper scripts also use `patronum.toml` from the workspace root:

```bash
cd source
npx tsx scripts/migrate-db.ts
npx tsx scripts/backfill-memory.ts
```

## Architecture

- `telegraf` for Telegram bot
- Raw `fetch` for Anthropic API (OAuth bearer token auth)
- `better-sqlite3` + `sqlite-vec` for storage and vector search
- `voyage-3-large` for embeddings
- TypeScript throughout
