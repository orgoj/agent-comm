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

3. Make sure `agent-comm-cli` is on your PATH. If installing from the skill:
   ```bash
   mkdir -p ~/bin
   cp <skill-dir>/scripts/agent-comm-cli ~/bin/
   chmod +x ~/bin/agent-comm-cli
   ```

The CLI reads `~/.agent-comm/config.sh` automatically. Env vars `COMM_HOST`/`COMM_PORT` override it.

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
# Direct message
agent-comm-cli send <from> <to> "message text"

# Channel message
agent-comm-cli send <from> channel:<name> "message text"

# Broadcast to all
agent-comm-cli broadcast <from> "message text"

# Check inbox
agent-comm-cli inbox <agent-name>

# Shared state (agent name is required for updated_by)
agent-comm-cli state set <ns> <key> <value> <agent-name>
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
| GET    | `/api/agents`                  | List online agents                                              |
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

**File coordination** — shared state as locks:

```bash
state set locks src/auth.py <agent-name> <agent-name>    # claim (value=owner, updated_by=agent)
state get locks src/auth.py                              # check owner
state delete locks src/auth.py <agent-name>              # release
```

**Task progress** — shared state as board:

```bash
state set progress task-42 "testing" <agent-name>
state set progress task-43 "blocked: waiting for auth" <agent-name>
```

**Urgent messages**:

```bash
curl -X POST <server>/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"from":"<name>","to":"<name>","content":"URGENT: prod down","importance":"urgent"}'
```

Levels: `low`, `normal`, `high`, `urgent`.

## Dashboard

Web UI at `<server>` — real-time activity feed, agent status, channels.
