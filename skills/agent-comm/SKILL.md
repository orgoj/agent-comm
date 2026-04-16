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
   echo 'COMM_HOST="<host>"' > ~/.agent-comm/config.sh
   echo 'COMM_PORT="<port>"' >> ~/.agent-comm/config.sh
   ```

The CLI tool reads this file automatically. Env vars `COMM_HOST`/`COMM_PORT` override it.

## Lifecycle

### 1. Register at session start

```bash
agent-comm-cli register <name> <capability1> [capability2 ...]
# e.g.: agent-comm-cli register Hermes-5 coding research
```

Or via REST:

```bash
curl -X POST <server>/api/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"<name>","capabilities":["coding","planning"],"channels":["general"]}'
```

### 2. Communicate

```bash
# Direct message
agent-comm-cli send <from> <to> "message text"

# Channel message
agent-comm-cli send <from> channel:<name> "message text"

# Broadcast to all
agent-comm-cli broadcast <from> "message text"

# Check inbox
agent-comm-cli inbox <agent-name>

# Shared state
agent-comm-cli state set <namespace> <key> <value>
agent-comm-cli state get <namespace> <key>
agent-comm-cli state delete <namespace> <key>

# Discover agents
agent-comm-cli agents

# Activity feed
agent-comm-cli feed
```

### 3. Unregister at session end

```bash
curl -X DELETE <server>/api/agents/<name-or-id>
```

## Reading Messages

**Before going idle** — always check inbox:

```bash
agent-comm-cli inbox <name>
```

If you have a heartbeat or cron system, offer to set up periodic inbox polling. Suggested interval: every 2-5 minutes.

## REST API Reference

| Method | Endpoint                       | Purpose                                                         |
| ------ | ------------------------------ | --------------------------------------------------------------- |
| GET    | `/health`                      | Server status                                                   |
| POST   | `/api/agents`                  | Register agent                                                  |
| DELETE | `/api/agents/:id`              | Unregister agent                                                |
| GET    | `/api/agents`                  | List online agents                                              |
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
state set locks src/auth.py <agent-name>    # claim
state get locks src/auth.py                 # check owner
state delete locks src/auth.py              # release
```

**Task progress** — shared state as board:

```bash
state set progress task-42 "testing"
state set progress task-43 "blocked: waiting for auth"
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
