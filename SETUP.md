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
sudo git clone git@github.com:0916dhkim/patronum.git /var/lib/patronum/source
```

---

## 2. Install dependencies and build

```bash
cd /var/lib/patronum/source
npm install
npm run build
```

---

## 3. Create the workspace

The workspace holds runtime config, memory files, and the SQLite database.
It lives at `/var/lib/patronum` — outside the source tree so it survives updates.

```bash
sudo mkdir -p /var/lib/patronum/agents
sudo mkdir -p /var/lib/patronum/skills
```

Copy and edit the config:

```bash
sudo cp /var/lib/patronum/source/scripts/patronum.toml.example /var/lib/patronum/patronum.toml
sudo editor /var/lib/patronum/patronum.toml
```

---

## 4. Create the `patronum` system user

Patronum runs as a dedicated system user with no login shell and no home directory.
This user owns the workspace and has passwordless sudo for service control only.

```bash
# Create the system user
sudo useradd --system --no-create-home --shell /sbin/nologin patronum

# Grant passwordless sudo for service control only
echo "patronum ALL=(ALL) NOPASSWD: /bin/systemctl stop patronum, /bin/systemctl start patronum, /bin/systemctl restart patronum" \
  | sudo tee /etc/sudoers.d/patronum

# Transfer workspace and source ownership to patronum
sudo chown -R patronum:patronum /var/lib/patronum
```

---

## 5. Install the systemd service

```bash
sudo cp /var/lib/patronum/source/scripts/patronum.service /etc/systemd/system/patronum.service
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

No manual intervention needed for code updates — just ask the bot to restart itself.

---

## Updating

```bash
cd /var/lib/patronum/source
git pull
npm run build
sudo systemctl restart patronum
```

Or ask the bot directly — it will pull, build, and restart itself.

---

## File layout

```
/var/lib/patronum/                  ← workspace root (owned by patronum)
├── patronum.toml                   ← runtime config and credentials
├── patronum.db                     ← SQLite database (messages, memory, threads)
├── SOUL.md                         ← bot personality (editable)
├── AGENTS.md                       ← bot rules (editable)
├── MEMORY.md                       ← curated persistent facts (bot-editable)
├── agents/                         ← workspace-defined subagents
│   └── <name>/SUBAGENT.md
├── skills/                         ← skill definitions
│   └── <name>/SKILL.md
└── source/                         ← source repo
    ├── src/                        ← TypeScript source
    ├── dist/                       ← compiled output
    └── scripts/
        ├── restart.sh              ← used by self_restart tool
        └── patronum.service        ← systemd unit file
```
