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

## Deployment (systemd)

### First-time install

```bash
# 1. Create .env on the target machine
sudo -u lin nano /home/lin/patronum/.env

# 2. Run the install script (as root or with sudo)
sudo bash scripts/install.sh
```

The install script copies the repo to `/home/lin/patronum/`, builds it, installs a systemd service, and starts it.

> **Note:** The `.env` file is NOT copied automatically — create it manually at `/home/lin/patronum/.env` before starting the service.

### Updating

```bash
sudo bash scripts/update.sh
```

Pulls latest changes, rebuilds, and restarts the service.

### Service management

```bash
systemctl status patronum      # Check status
systemctl restart patronum     # Restart
systemctl stop patronum        # Stop
journalctl -u patronum -f      # Follow logs
```

## Architecture

- `telegraf` for Telegram bot
- Raw `fetch` for Anthropic API (OAuth bearer token auth)
- `better-sqlite3` for session history
- TypeScript throughout
