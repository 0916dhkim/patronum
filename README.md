# patronum

Minimal personal AI agent harness — Telegram bot + Claude + tools.

## Setup

```bash
npm install
cp .env.example .env
# Fill in your tokens in .env
```

## Environment Variables

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token from @BotFather |
| `CLAUDE_TOKEN` | Claude OAuth token (`oat01-...` from `claude setup-token`) |
| `CLAUDE_MODEL` | Claude model to use (default: `claude-sonnet-4-6`) |
| `WORKSPACE` | Working directory for file tools |

## Usage

```bash
# Development (watch mode)
npm run dev

# Production
npm run build
npm start
```

## Tools

The agent has access to:

- **exec** — run shell commands (30s timeout)
- **read** — read file contents
- **write** — create/overwrite files
- **edit** — find and replace text in files

## Architecture

- `telegraf` for Telegram bot
- Raw `fetch` for Anthropic API (OAuth bearer token auth)
- `better-sqlite3` for session history
- TypeScript throughout
