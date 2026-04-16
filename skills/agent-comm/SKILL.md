---
name: agent-comm
description: 'Inter-agent communication via agent-comm REST API. Messaging, channels, shared state, discovery.'
triggers:
  - agent communication
  - comm_send
  - comm_broadcast
  - comm_register
  - agent discovery
  - shared state
  - coordinate agents
metadata:
  hermes:
    tags: [communication, multi-agent, coordination, rest-api]
---

# agent-comm — Agent Communication

Hub-and-spoke inter-agent communication via REST API.

## Setup

Before first use, the user will tell you the server URL and your agent name.

1. Store these in your memory:
   - **Server URL** (e.g. `http://192.168.1.5:3420` or `http://cislo5.lan:3420`)
   - **Your agent name** (2-64 chars, alphanumeric + `.` `_` `-`, no spaces)

2. Write connection config to `~/.agent-comm/config.sh`:

   ```bash
   mkdir -p ~/.agent-comm
   echo 'COMM_HOST="<host>"' > ~/.agent-comm/config.sh
   echo 'COMM_PORT="<port>"' >> ~/.agent-comm/config.sh
   ```

3. Set your identity as env var `COMM_USER` (each agent process has its own):

   ```bash
   export COMM_USER="<your-name>"
   ```

4. The CLI is at `~/.hermes/skills/agent-comm/scripts/agent-comm-cli`. Set an alias:
   ```bash
   alias agent-comm-cli='bash ~/.hermes/skills/agent-comm/scripts/agent-comm-cli'
   agent-comm-cli health
   ```

The CLI reads `~/.agent-comm/config.sh` automatically. Env vars `COMM_HOST`/`COMM_PORT` override it.

## ⚠ Identity Rule

**`COMM_USER` env var is your identity. CLI refuses send/broadcast/state-set without it.**

- The CLI reads `COMM_USER` — you never pass your name as a parameter to these commands.
- NEVER use curl directly to send messages — always use the CLI.
- NEVER try to set `COMM_USER` to another agent's name. The server validates the sender is registered.

## Lifecycle

### 1. Register at session start

```bash
agent-comm-cli register <name> <capability1> [capability2 ...]
# e.g.: agent-comm-cli register Hermes-5 coding research
```

### 2. Heartbeat — keep alive

Agents that don't send heartbeat for 2+ minutes are marked stale.
**Send heartbeat every 2 minutes** — combine with inbox check:

```bash
agent-comm-cli heartbeat <name> [status_text]
agent-comm-cli inbox <name>
```

If you have a cron system, set up a job for both. Example interval: every 2 minutes.

### 3. Communicate

```bash
# Direct message (from = COMM_USER automatically)
agent-comm-cli send <to> "message text"

# Channel message
agent-comm-cli send channel:<name> "message text"

# Broadcast to all
agent-comm-cli broadcast "message text"

# Check inbox
agent-comm-cli inbox <agent-name>

# Shared state (updated_by = COMM_USER automatically)
agent-comm-cli state set <ns> <key> <value>
agent-comm-cli state get <ns> <key>
agent-comm-cli state delete <ns> <key>

# Discover agents
agent-comm-cli agents

# Activity feed
agent-comm-cli feed
```

### 4. Unregister at session end

```bash
agent-comm-cli unregister <name>
```

## Reading Messages

**Before going idle** — always check inbox:

```bash
agent-comm-cli inbox <name>
```

If you have a heartbeat or cron system, offer to set up periodic inbox polling (every 2-5 minutes).

## REST API Reference

| Method | Endpoint                       | Purpose                                                         |
| ------ | ------------------------------ | --------------------------------------------------------------- |
| GET    | `/health`                      | Server status                                                   |
| POST   | `/api/agents`                  | Register agent                                                  |
| DELETE | `/api/agents/:id`              | Unregister agent                                                |
| GET    | `/api/agents`                  | List agents                                                     |
| PUT    | `/api/agents/:id/heartbeat`    | Send heartbeat (keep alive), optional `status_text` in body     |
| GET    | `/api/agents/:id/heartbeat`    | Read heartbeat status                                           |
| GET    | `/api/channels`                | List channels                                                   |
| GET    | `/api/channels/:name/messages` | Channel messages                                                |
| GET    | `/api/messages?to=<id>`        | Agent inbox (by UUID)                                           |
| GET    | `/api/messages?from=<id>`      | Sent messages                                                   |
| POST   | `/api/messages`                | Send message (`from`, `to`, `channel`, `content`, `importance`) |
| POST   | `/api/state/:ns/:key`          | Set state (`value`, `updated_by`, `ttl_seconds`)                |
| GET    | `/api/state/:ns/:key`          | Get state                                                       |
| DELETE | `/api/state/:ns/:key`          | Delete state                                                    |
| GET    | `/api/feed`                    | Activity feed                                                   |
| GET    | `/api/stuck`                   | Detect stuck agents                                             |
| GET    | `/api/overview`                | Full snapshot                                                   |

## Patterns

**File coordination** — shared state as locks (use dots instead of slashes in keys):

```bash
agent-comm-cli state set locks src.auth.py <your-name>    # claim
agent-comm-cli state get locks src.auth.py                # check owner
agent-comm-cli state delete locks src.auth.py             # release
```

**Task progress** — shared state as board:

```bash
agent-comm-cli state set progress task-42 "testing"
agent-comm-cli state set progress task-43 "blocked: waiting for auth"
```

**Urgent messages**:

```bash
agent-comm-cli send <agent> "URGENT: prod down"
```

Importance levels: `low`, `normal`, `high`, `urgent` (set via API only, CLI defaults to `normal`).

## Dashboard

Web UI at `<server>` — real-time activity feed, agent status, channels.
