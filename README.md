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

# 4. Create your .env
cp source/.env.example .env
# Edit .env with your tokens

# 5. Run
node source/dist/index.js
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram Bot API token from @BotFather |
| `CLAUDE_TOKEN` | Yes | Claude OAuth token (`oat01-...` from `claude setup-token`) |
| `CLAUDE_MODEL` | No | Claude model to use (default: `claude-sonnet-4-6`) |
| `WORKSPACE` | No | Working directory (default: current directory) |
| `OWNER_CHAT_ID` | No | Your Telegram chat ID (for startup/shutdown notifications) |
| `VOYAGE_API_KEY` | No | Voyage AI API key (enables vector memory search) |

## Workspace Structure

```
my-workspace/
├── source/           # Cloned repo (TypeScript source)
├── SOUL.md           # Bot personality (auto-created from template if missing)
├── AGENTS.md         # Bot rules and preferences (auto-created if missing)
├── MEMORY.md         # Persistent facts (created by the bot)
├── patronum.db       # SQLite database (messages, memory, threads)
└── .env              # Your tokens and config
```

## Features

- **Conversation memory** — SQLite-backed message history with token-based compaction
- **Vector memory** — Voyage AI embeddings + sqlite-vec for semantic recall over past conversations
- **Auto-recall** — relevant past context automatically injected on each message
- **Self-editing** — the bot can read, edit, and rebuild its own source code
- **Multi-agent** — spawn background agent tasks with different models
- **Tools** — exec, read, write, edit, send media, memory search/write, self-restart

## Tools Available

- `exec` — run shell commands (30s timeout)
- `read` — read file contents
- `write` — create/overwrite files
- `edit` — find and replace in files
- `send_media` — send images/files via Telegram
- `spawn_agent` — run background agent tasks
- `cancel_agent` — cancel running tasks
- `list_tasks` — list active background tasks
- `memory_search` — semantic search over past conversations and curated facts
- `memory_write` — save facts to MEMORY.md + vector index
- `self_restart` — rebuild and restart (use after code changes)

## Development

```bash
# Watch mode
cd source && npm run dev

# Build
cd source && npm run build

# Run from workspace
node source/dist/index.js
```

## Architecture

- `telegraf` for Telegram bot
- Raw `fetch` for Anthropic API (OAuth bearer token auth)
- `better-sqlite3` + `sqlite-vec` for storage and vector search
- `voyage-3-large` for embeddings
- TypeScript throughout
