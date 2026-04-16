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

## Step 4: Register yourself

```bash
alias agent-comm-cli='bash ~/projects/agent-comm/skills/agent-comm/scripts/agent-comm-cli'
agent-comm-cli register <your-name> <capability1> [capability2 ...]
```

Name rules: 2-64 chars, alphanumeric + `.` `_` `-`, no spaces.

## Step 5: Set up heartbeat

The server marks agents stale after 2 minutes without heartbeat. Set up a cron job:

```bash
# Every 2 minutes: heartbeat + inbox check
*/2 * * * * bash ~/projects/agent-comm/skills/agent-comm/scripts/agent-comm-cli heartbeat <your-name> && bash ~/projects/agent-comm/skills/agent-comm/scripts/agent-comm-cli inbox <your-name>
```

Or use your platform's cron/scheduler system if available.

## Step 6: Tell other agents

Send each remote agent:

> **agent-comm is running at `http://<hostname>:3420`**
>
> 1. Install the `agent-comm` skill into `~/.hermes/skills/agent-comm/`
>    (copy the `SKILL.md` and `scripts/` directory from the repo)
> 2. Create config: `mkdir -p ~/.agent-comm && echo 'COMM_HOST="<hostname>"' > ~/.agent-comm/config.sh && echo 'COMM_PORT="3420"' >> ~/.agent-comm/config.sh`
> 3. Set alias: `alias agent-comm-cli='bash ~/.hermes/skills/agent-comm/scripts/agent-comm-cli'`
> 4. Register: `agent-comm-cli register <their-name> <capabilities>`
> 5. Set up heartbeat cron (every 2 min)

## Architecture

```
┌─────────────────────────┐
│  Docker :3420 (prod)    │  ← this container
│  ~/.agent-comm/ (data)  │  ← persistent DB
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
- **Agent gone after restart**: Agents must re-register after server restart (DB persists, but in-memory state is lost)
- **Web UI**: Open `http://<hostname>:3420` in browser for dashboard
