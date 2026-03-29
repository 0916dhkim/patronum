# AGENTS.md — Patronum Self-Reference

You are Patronum, a personal AI agent. This file describes your own codebase.
**You can read, edit, and improve your own source code.**

## Project Structure

```
patronum/
├── src/
│   ├── index.ts          # Entry point
│   ├── bot.ts            # Telegram bot, message handling, event queue
│   ├── agent.ts          # Claude API calls, system prompt, tool loop
│   ├── config.ts         # Environment config (loaded from .env)
│   ├── session.ts        # SQLite message history (per-chat)
│   ├── thread.ts         # Shared thread context across agents
│   ├── compaction.ts     # Token-based context compaction
│   ├── context.ts        # Loads SOUL.md, AGENTS.md, MEMORY.md into system prompt
│   ├── format.ts         # Markdown → Telegram HTML conversion
│   ├── types.ts          # TypeScript types for Claude API
│   ├── agents.ts         # Agent definitions (lin, alex, iris, quill)
│   ├── run-agent.ts      # Run agent with thread snapshot
│   ├── task-manager.ts   # Background task tracking
│   ├── secrets.ts        # Secret Party integration
│   ├── memory/
│   │   ├── embeddings.ts # Voyage AI embedding client
│   │   ├── store.ts      # sqlite-vec vector storage + search
│   │   ├── recall.ts     # Auto-recall orchestration
│   │   ├── tools.ts      # memory_search + memory_write tools
│   │   └── index.ts      # Memory module exports
│   └── tools/
│       ├── index.ts      # Tool registry
│       ├── exec.ts       # Shell command execution
│       ├── read.ts       # File reading
│       ├── write.ts      # File writing
│       ├── edit.ts       # Find and replace
│       ├── send-media.ts # Send images/files via Telegram
│       ├── spawn-agent.ts    # Spawn background agent tasks
│       ├── cancel-agent.ts   # Cancel running tasks
│       ├── list-tasks.ts     # List active tasks
│       ├── self-restart.ts   # Build + restart self
│       └── chat-context.ts   # Current chat ID tracking
├── SOUL.md               # Your personality and core behavior
├── AGENTS.md             # This file — project knowledge
├── MEMORY.md             # Curated persistent facts (you can edit this)
├── patronum.db           # SQLite database (messages, memory, threads)
├── .env                  # Environment config (tokens, model, etc.)
├── package.json
└── tsconfig.json
```

## Building & Running

```bash
npm run build          # TypeScript → dist/
npm run dev            # Development with tsx watch
node dist/index.js     # Production run
```

## Self-Editing Workflow

When you want to change your own code:

1. **Read** the relevant source file(s) first — understand what you're changing
2. **Edit** using the `edit` tool (find and replace) or `write` for new files
3. **Build** — use `self_restart` tool which runs `npm run build` first
   - If build fails, you get the error and can fix it. No restart happens.
   - If build succeeds, the process restarts automatically.
4. **Git** — commit your changes with a descriptive message:
   ```bash
   git add -A && git commit -m "feat: description of change"
   ```
   Never force-push. Never rewrite history.

## Key Architecture Details

- **One DB** — `patronum.db` in the workspace holds everything: messages, archived messages, threads, memory chunks, and vector embeddings.
- **Auto-recall** — every user message is embedded and searched against past context. Top matches are injected into the system prompt.
- **Post-turn indexing** — after each exchange, the conversation is embedded and stored for future recall.
- **Compaction** — when context reaches 70% of the model's window, older messages are summarized and replaced.
- **OAuth auth** — uses Claude OAuth bearer tokens (not API keys). Requires the Claude Code identity header.

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

## Rules

- Be resourceful — read code and figure things out before asking
- Keep responses concise unless depth is needed
- When editing your own code, make sure you understand the context first
- Always build-test before restarting — `self_restart` handles this
- Commit meaningful changes to git so nothing is lost
