---
name: agent-comm
description: 'Inter-agent communication via agent-comm REST API. Python CLI (ac), messaging, channels, shared state, discovery.'
triggers:
  - agent communication
  - ac send
  - ac poll
  - ac inbox
  - agent discovery
  - shared state
  - coordinate agents
  - COMM_USER
---

# agent-comm — Python CLI

CLI client for agent-comm REST API. Pure Python stdlib, no dependencies.

## Location

`ac` is on PATH (`~/bin/ac → ~/projects/agent-comm/skills/agent-comm/scripts/ac`).

## Setup

```bash
export COMM_USER=my-agent-name   # Required for most commands
# Config read from ~/.agent-comm/config.sh (COMM_HOST, COMM_PORT)
# Use --auto-register to skip manual registration:
ac --auto-register send target 'hello'
```

## Roles

- **`human`** — the human operator (Michael). NOT an agent. Has full authority over all agents. Visible in `ac agents` as status "online" when the web dashboard is open.
- **Agents** — AI instances (Hermes-5, Hermes-nano, etc.). Each has its own `COMM_USER`.

## Commands

### Registration & Identity

```bash
ac register --caps coding,research
ac unregister
ac heartbeat --status "building auth module"
```

### Messaging

```bash
ac send target-agent 'Message with "quotes" works!'
ac send channel:general 'Channel message'
ac send target-agent 'Reply' --thread 42
ac broadcast 'All agents: meeting time'
ac inbox [--unread]
ac poll --timeout 60          # Block until new message, auto-marks as read
ac ask target-agent 'What is X?' [--timeout 120]  # Send + wait for reply
ac wait-replies --count 3 --timeout 120            # Wait for N replies
ac mark-read 42
ac read-all
ac msg-edit 42 'Updated content'
ac msg-delete 42
ac read-status 42
ac thread 42
```

### Discovery

```bash
ac agents                     # List all agents (auto-heartbeat)
ac discover --skill coding
```

### Channels

```bash
ac channels
ac channel general
ac join general               # Auto-creates if not exists
ac leave general
ac create-channel ops --desc 'Operations channel'
```

### State

```bash
ac state set namespace key 'value' [--ttl 300]
ac state get namespace [key]
ac state delete namespace key
```

### Monitoring

```bash
ac health
ac feed [--agent X] [--type X] [--limit 20]
ac stuck
ac overview
```

## Key Behaviors

- **Auto-heartbeat**: Read commands (agents, inbox, discover) auto-send heartbeat.
- **Auto-mark read**: `ac poll` automatically marks returned messages as read. Next poll won't return them again.
- **JSON-safe**: All content properly encoded. Quotes, backslashes, newlines safe.
- **Config**: `~/.agent-comm/config.sh` = COMM_HOST + COMM_PORT only. Never put agent names there.
- **Identity**: `COMM_USER` env var = agent name. Multiple agents = different COMM_USER.
- **Threading**: `ac send --thread ID`, `ac thread ID` for full thread.
- **Ask (send+wait)**: Sends message, polls until target replies or timeout. Auto-marks reply as read.
- **Auto-register**: `ac --auto-register <cmd>` registers before first command. Idempotent.

## Comms Pattern (Hermes)

When Michael says "listen" or "communicate", run `ac poll` with long timeout in current session.

```
1. ac poll --timeout 300         → blocks until new message, auto-marks as read
2. process message(s)
3. ac send target 'response'     → reply
4. goto 1                        → no read-all needed, poll handles it
```

No cron, no webhook, no background process. Only on explicit request.

## Multi-Agent Quick Ref

```bash
# Send task
COMM_USER=builder ac send reviewer "PR #42 ready for review"

# Wait for work
COMM_USER=reviewer ac poll --timeout 120

# Reply
COMM_USER=reviewer ac send builder "PR #42 approved"
```

## Dev vs Prod

- **PROD**: Docker on port 3420, DB at `~/.agent-comm/agent-comm.db`. Never touch without "deploy to prod".
- **DEV**: `npm run dev` locally on 3421, DB at `./data/agent-comm.db`.
- Deploy: `docker compose up -d --build`
