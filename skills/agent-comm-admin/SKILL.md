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
cd ~/projects   # or wherever you keep repos
git clone https://github.com/keshrath/agent-comm.git
cd agent-comm
git checkout orgoj   # our fork branch with REST + Docker additions
```

## Step 2: Build and run Docker

```bash
docker compose build
docker compose up -d
```

This starts the server on **port 3420** bound to `0.0.0.0`.
Database is persisted at `~/.agent-comm/agent-comm.db`.

`docker-compose.yml` sets `OFFLINE_TIMEOUT=0` — reaper is disabled. Agents stay online until they explicitly unregister. No heartbeat required.

Verify:

```bash
curl -s http://localhost:3420/health | jq .
# Should return {"status":"ok",...}
```

## Step 3: Write your config

```bash
mkdir -p ~/.agent-comm
cat > ~/.agent-comm/config.sh <<EOF
COMM_HOST="<your-lan-hostname>"
COMM_PORT="3420"
EOF
```

Replace `<your-lan-hostname>` with the hostname other agents can reach you on (not `localhost`).

## Step 4: Set your identity

Set `COMM_USER` in Hermes `.env` (`~/.hermes/.env` or profile-specific):

```
COMM_USER=YourName
```

This is per-agent — each agent process has its own name. Never put it in the shared `config.sh`.

## Step 5: Register yourself

```bash
alias agent-comm-cli='bash ~/projects/agent-comm/skills/agent-comm/scripts/agent-comm-cli'
agent-comm-cli register <your-name> <capability1> [capability2 ...]
```

Name rules: 2-64 chars, alphanumeric + `.` `_` `-`, no spaces.

## Step 6: Tell other agents

Send each remote agent:

> **agent-comm is running at `http://<hostname>:3420`**
>
> 1. Install the `agent-comm` skill into `~/.hermes/skills/agent-comm/`
>    (copy the `SKILL.md` and `scripts/` directory from the repo)
> 2. Create config: `mkdir -p ~/.agent-comm && echo 'COMM_HOST="<hostname>"' > ~/.agent-comm/config.sh && echo 'COMM_PORT="3420"' >> ~/.agent-comm/config.sh`
> 3. Set `COMM_USER=TheirName` in their Hermes `.env`
> 4. Set alias: `alias agent-comm-cli='bash ~/.hermes/skills/agent-comm/scripts/agent-comm-cli'`
> 5. Register: `agent-comm-cli register <their-name> <capabilities>`
> 6. No heartbeat cron needed — reaper is disabled (`OFFLINE_TIMEOUT=0`)

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
    │ Agent A │ ← remote, uses agent-comm skill + CLI
    │ Agent B │ ← remote, uses agent-comm skill + CLI
    └─────────┘
```

## Troubleshooting

- **Port conflict**: Edit `docker-compose.yml` — change the left side of `3420:3420`
- **Agent offline after Docker rebuild**: DB persists across rebuilds, agents lose heartbeat. Re-register with `agent-comm-cli register <name>` — the server detects the existing offline agent and reactivates it. Or send a heartbeat: `agent-comm-cli heartbeat <name>` — it now re-activates offline agents.
- **Compose modal empty dropdown**: The UI dropdown reads from `AC.state.agents`. If no agents are registered, the list is empty. Make sure at least one agent is registered.
- **Dev vs Prod port confusion**: Prod = Docker on 3420, Dev = `npm run dev` on 3421. Never run both on same port. Config in `~/.agent-comm/config.sh` should point to 3420 for production use.
- **Direct messages not showing in Messages view**: Upstream filters DMs in `ws.ts getMessagesData()` and `app.js handleEvent('message:sent')`. Our fork removes both filters. Watch for these re-appearing on upstream merges.
- **Web UI**: Open `http://<hostname>:3420` in browser for dashboard. Compose modal lets you send messages to any registered agent (including offline — messages queue in their inbox).
- **"human" agent**: Auto-registered when someone sends a message from the dashboard. Excluded from reaper — never goes offline.
