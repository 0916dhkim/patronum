# Patronum — Setup Guide

How to deploy Patronum as a systemd service on a Linux host.

---

## Prerequisites

- Node.js 20+
- A Telegram bot token (from @BotFather)
- An Anthropic API key (OAuth bearer token)
- Voyage AI API key (optional — for vector memory)

---

## 1. Clone the repo

```bash
git clone git@github.com:0916dhkim/patronum.git /home/danny/.openclaw/workspace/patronum
```

---

## 2. Install dependencies and build

```bash
cd /home/danny/.openclaw/workspace/patronum
npm install
npm run build
```

---

## 3. Create the workspace

The workspace holds runtime config, memory files, and the SQLite database.
It lives outside the source repo so it survives updates.

```bash
mkdir -p /home/danny/patronum-workspace/agents
mkdir -p /home/danny/patronum-workspace/skills
```

Copy the workspace files from the repo:

```bash
cp scripts/patronum.toml.example /home/danny/patronum-workspace/patronum.toml
```

Edit `patronum.toml` with your credentials (see comments inside the file).

---

## 4. Create the `patronum` system user

Patronum runs as a dedicated system user with no login shell and no home directory.
This user needs write access to the workspace and passwordless sudo for service control only.

```bash
# Create the system user
sudo useradd --system --no-create-home --shell /sbin/nologin patronum

# Grant passwordless sudo for service control only
echo "patronum ALL=(ALL) NOPASSWD: /bin/systemctl stop patronum, /bin/systemctl start patronum, /bin/systemctl restart patronum" \
  | sudo tee /etc/sudoers.d/patronum

# Transfer workspace and source ownership to patronum
sudo chown -R patronum:patronum /home/danny/patronum-workspace
sudo chown -R patronum:patronum /home/danny/.openclaw/workspace/patronum
```

---

## 5. Install the systemd service

```bash
sudo cp /home/danny/.openclaw/workspace/patronum/scripts/patronum.service /etc/systemd/system/patronum.service
sudo systemctl daemon-reload
sudo systemctl enable patronum
sudo systemctl start patronum
```

Check it's running:

```bash
systemctl status patronum
journalctl -u patronum -f
```

---

## 6. Self-restart

Patronum can rebuild and restart itself via the `self_restart` tool. This works because:
- The service runs as `patronum`
- The `patronum` user has passwordless sudo for `systemctl stop/start patronum`
- The restart script (`scripts/restart.sh`) stops the service, waits 3s, then starts it

No manual intervention needed for code updates — just ask the bot to restart itself after making changes.

---

## Updating

```bash
cd /home/danny/.openclaw/workspace/patronum
git pull
npm run build
sudo systemctl restart patronum
```

Or ask the bot directly: it will pull, build, and restart itself.

---

## File layout

```
/home/danny/patronum-workspace/     ← workspace root (owned by patronum)
├── patronum.toml                   ← runtime config and credentials
├── patronum.db                     ← SQLite database (messages, memory, threads)
├── SOUL.md                         ← bot personality (editable)
├── AGENTS.md                       ← bot rules (editable)
├── MEMORY.md                       ← curated persistent facts (bot-editable)
├── agents/                         ← workspace-defined subagents
│   └── <name>/SUBAGENT.md
├── skills/                         ← skill definitions
│   └── <name>/SKILL.md
└── source -> /home/danny/.openclaw/workspace/patronum   ← symlink to source

/home/danny/.openclaw/workspace/patronum/   ← source repo (owned by patronum)
├── src/                            ← TypeScript source
├── dist/                           ← compiled output
├── scripts/
│   ├── restart.sh                  ← used by self_restart tool
│   └── patronum.service            ← systemd unit file
└── patronum.toml.example           ← config template
```
