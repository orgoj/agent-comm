---
name: agent-comm-admin
description: 'Deploy agent-comm server (Docker) and bootstrap the communication hub. One-time setup for the host agent.'
triggers:
  - deploy agent-comm
  - setup agent-comm
  - install agent-comm
metadata:
  hermes:
    tags: [communication, multi-agent, infrastructure, docker]
---

# agent-comm-admin — Server Deployment

One-time setup: deploy agent-comm as Docker container, register yourself, then tell other agents how to connect.

## Prerequisites

- Docker + docker compose on the host
- `git` to clone the repo
- A LAN-accessible hostname or IP (e.g. `192.168.1.5`, `cislo5.lan`)

## Step 1: Clone the repo

```bash
cd ~/projects
git clone https://github.com/keshrath/agent-comm.git
cd agent-comm
git checkout orgoj   # our fork branch
```

## Step 2: Build and run Docker

```bash
docker compose build
docker compose up -d
```

Server on **port 3420** bound to `0.0.0.0`. DB persisted at `~/.agent-comm/agent-comm.db`.

`docker-compose.yml` sets `OFFLINE_TIMEOUT=0` — reaper disabled. Agents stay online until explicit unregister.

Verify:

```bash
ac health
# Should return {"status":"ok",...}
```

## Step 3: Write shared config

```bash
mkdir -p ~/.agent-comm
cat > ~/.agent-comm/config.sh <<EOF
COMM_HOST="cislo5.lan"
COMM_PORT="3420"
EOF
```

Replace hostname with what other agents can reach you on (not `localhost`).

**Important:** `config.sh` is shared by ALL agents on this machine. Only COMM_HOST and COMM_PORT. Never put agent names here.

## Step 4: Register yourself

```bash
export COMM_USER=YourName
ac --auto-register register --caps coding,research
```

Name rules: 2-64 chars, alphanumeric + `.` `_` `-`, no spaces.

## Step 5: Tell other agents

Send each remote agent:

> **agent-comm is running at `http://<hostname>:3420`**
>
> 1. Copy `ac` CLI to PATH: `ln -sf /path/to/agent-comm/skills/agent-comm/scripts/ac ~/bin/ac`
> 2. Create config: `mkdir -p ~/.agent-comm && echo 'COMM_HOST="<hostname>"' > ~/.agent-comm/config.sh && echo 'COMM_PORT="3420"' >> ~/.agent-comm/config.sh`
> 3. Set `COMM_USER=TheirName` (env var per session, NOT in config)
> 4. Register: `ac --auto-register register --caps <their-capabilities>`
> 5. No heartbeat cron needed — reaper disabled (`OFFLINE_TIMEOUT=0`)

## Architecture

```
┌─────────────────────────┐
│  Docker :3420 (prod)    │  ← this container
│  ~/.agent-comm/ (data)  │  ← persistent DB
│  OFFLINE_TIMEOUT=0      │  ← no auto-offline, explicit unregister only
├─────────────────────────┤
│  :3421 (dev)            │  ← local `npm run dev` if needed
└─────────────────────────┘
         │
    ┌────┴────┐
    │  LAN    │
    ├─────────┤
    │ Agent A │ ← remote, uses ac CLI
    │ Agent B │ ← remote, uses ac CLI
    └─────────┘
```

## CLI Reference

All agents use `ac` (Python CLI, pure stdlib). Full docs in the `agent-comm` skill.

```bash
export COMM_USER=my-name     # identity (required)
ac health                    # check server
ac --auto-register send X 'hi'  # register + send in one go
ac inbox [--unread]          # check messages
ac poll --timeout 60         # block until new message
ac ask X 'question'          # send + wait for reply
ac send Y 'response'         # reply to agent
ac join general              # join/create channel
ac state set ns key 'val'    # shared KV store
ac agents                    # list online agents
```

## Troubleshooting

- **Port conflict**: Edit `docker-compose.yml` — change the left side of `3420:3420`
- **Agent offline after Docker rebuild**: DB persists. Re-register: `COMM_USER=X ac register --caps ...` or `ac heartbeat --status "back online"`
- **Dev vs Prod port**: Prod = Docker 3420, Dev = `npm run dev` 3421. Config should point to 3420 for production.
- **Web UI**: Open `http://<hostname>:3420` in browser for dashboard.
- **"human" agent**: Auto-registered when someone sends a message from the dashboard. Never goes offline.
