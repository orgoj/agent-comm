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

Hub-and-spoke inter-agent communication. REST API on `COMM_HOST:COMM_PORT` (default `localhost:3420`).

## Connection

```bash
# CLI tool
agent-comm-cli health

# Direct curl
curl http://localhost:3420/health
```

## Lifecycle

### 1. Register at session start

```bash
agent-comm-cli register <name> <capability1> [capability2 ...]
# e.g.: agent-comm-cli register hermes-terminal coding research
```

### 2. Work — message, coordinate, share state

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
agent-comm-cli discover <skill>
```

### 3. Cleanup at session end

```bash
# Unregister (agent goes offline)
curl -X DELETE http://localhost:3420/api/agents/<agent-id>
```

## REST API Quick Reference

Base URL: `http://$COMM_HOST:$COMM_PORT`

| Method | Endpoint                       | Purpose             |
| ------ | ------------------------------ | ------------------- |
| GET    | `/health`                      | Server status       |
| GET    | `/api/agents`                  | List online agents  |
| GET    | `/api/channels`                | List channels       |
| GET    | `/api/channels/:name/messages` | Channel messages    |
| GET    | `/api/messages?to=<agent>`     | Agent inbox         |
| GET    | `/api/messages?from=<agent>`   | Sent messages       |
| POST   | `/api/messages`                | Send message        |
| GET    | `/api/state/:ns/:key`          | Get state           |
| POST   | `/api/state/:ns/:key`          | Set state           |
| DELETE | `/api/state/:ns/:key`          | Delete state        |
| GET    | `/api/feed`                    | Activity feed       |
| GET    | `/api/stuck`                   | Detect stuck agents |
| GET    | `/api/overview`                | Full snapshot       |

## Patterns

**File coordination** — use shared state as locks:

```
state set locks src/auth.py <agent-id>     # claim
state get locks src/auth.py                # check owner
state delete locks src/auth.py             # release
```

**Task progress** — use shared state as status board:

```
state set progress task-42 "testing"
state set progress task-43 "blocked: waiting for auth module"
```

**Important messages** — set importance level:

```bash
curl -X POST http://localhost:3420/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"from":"<id>","to":"<id>","content":"URGENT: production down","importance":"urgent"}'
```

Levels: `low`, `normal`, `high`, `urgent`.

## Dashboard

Web UI at `http://$COMM_HOST:$COMM_PORT` — real-time activity feed, agent status, channels.
