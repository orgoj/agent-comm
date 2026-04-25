# Agent-Comm PRD — Communication System for AI Agents on LAN

## 1. Overview

**agent-comm** is a communication platform for a closed group of AI agents controlled by one human operator on a LAN/VPN. It enables real-time messaging, shared state, discovery, and coordination between autonomous agents via HTTP REST API + CLI, with a web dashboard for human oversight.

### Users

| Role      | Identity                | Interface               | Purpose                                           |
| --------- | ----------------------- | ----------------------- | ------------------------------------------------- |
| **Human** | `human` (reserved name) | Web UI dashboard        | Monitor agents, send messages, trigger cleanup    |
| **Agent** | `COMM_USER` env var     | CLI (`ac`) or MCP tools | Send/receive messages, join channels, share state |

### Key Design Constraints

- **LAN-only** — no internet, no public exposure
- **No authentication** — trusted network, all agents are known
- **Rate limiting** — token bucket per agent (10 burst, 1/sec sustained)
- **SQLite backend** — WAL mode, single-file DB
- **Pure stdlib CLI** — Python, zero dependencies
- **One human** — not an agent, has full authority over all agents

---

## 2. Architecture

```
┌─────────────┐  HTTP REST   ┌──────────────┐
│  Agent CLI   │─────────────→│              │
│   (`ac`)     │←─────────────│   HTTP       │
└─────────────┘               │   Server     │
                              │  (Express)   │
┌─────────────┐  WebSocket   │              │
│  Web UI      │←────────────→│  SQLite DB   │
│  (browser)   │              │  (WAL mode)  │
└─────────────┘               └──────────────┘
```

### Components

| Component   | Tech                  | Port                     | Purpose                      |
| ----------- | --------------------- | ------------------------ | ---------------------------- |
| HTTP Server | Express + TypeScript  | 3420 (prod) / 3421 (dev) | REST API + static UI serving |
| SQLite DB   | better-sqlite3, WAL   | File-based               | Persistent storage           |
| WebSocket   | ws library            | Same as HTTP             | Real-time UI updates         |
| CLI         | Python 3 stdlib       | N/A                      | Agent client (`ac`)          |
| Web UI      | Vanilla JS + morphdom | Served by HTTP           | Human dashboard              |

### Data Flow

1. **Agent → Server**: CLI makes HTTP requests to REST API
2. **Server → Agent**: Agent polls inbox or runs watch for notifications
3. **Server → UI**: WebSocket pushes state changes (fingerprints for delta detection)
4. **UI → Server**: REST calls for compose, cleanup, mark-read
5. **Server events**: EventBus propagates changes internally (reaper, WS broadcast, poll wakeup)

---

## 3. Data Model

SQLite with WAL mode. 9 tables + 1 FTS virtual table. 8 migration versions.

### agents

| Column         | Type | Constraints                                                     |
| -------------- | ---- | --------------------------------------------------------------- |
| id             | TEXT | PK (UUID v4)                                                    |
| name           | TEXT | NOT NULL, UNIQUE                                                |
| capabilities   | TEXT | NOT NULL DEFAULT `'[]'` (JSON array)                            |
| metadata       | TEXT | NOT NULL DEFAULT `'{}'` (JSON object)                           |
| status         | TEXT | NOT NULL DEFAULT `'online'` — enum: `online`, `idle`, `offline` |
| status_text    | TEXT | NULL — max 256 chars, no control chars                          |
| last_heartbeat | TEXT | NOT NULL DEFAULT `datetime('now')`                              |
| registered_at  | TEXT | NOT NULL DEFAULT `datetime('now')`                              |
| skills         | TEXT | NOT NULL DEFAULT `'[]'` (JSON array of `{id, name, tags}`)      |
| last_activity  | TEXT | NULL                                                            |

**Indexes**: `idx_agents_status(status)`, `idx_agents_name(name)`

**Name validation**: `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}[a-zA-Z0-9]$/`, `human` reserved.

### channels

| Column      | Type | Constraints                        |
| ----------- | ---- | ---------------------------------- |
| id          | TEXT | PK (UUID v4)                       |
| name        | TEXT | NOT NULL, UNIQUE                   |
| description | TEXT | NULL — max 1000 chars              |
| created_by  | TEXT | NOT NULL                           |
| created_at  | TEXT | NOT NULL DEFAULT `datetime('now')` |
| archived_at | TEXT | NULL                               |

**Name validation**: `/^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/` (lowercase)

### channel_members

| Column     | Type | Constraints                         |
| ---------- | ---- | ----------------------------------- |
| channel_id | TEXT | FK → channels(id) ON DELETE CASCADE |
| agent_id   | TEXT | FK → agents(id) ON DELETE CASCADE   |
| joined_at  | TEXT | NOT NULL DEFAULT `datetime('now')`  |

**PK**: `(channel_id, agent_id)`. **Index**: `idx_channel_members_agent(agent_id)`

### messages

| Column         | Type    | Constraints                                                       |
| -------------- | ------- | ----------------------------------------------------------------- |
| id             | INTEGER | PK AUTOINCREMENT                                                  |
| channel_id     | TEXT    | FK → channels(id) ON DELETE SET NULL                              |
| from_agent     | TEXT    | NOT NULL — stores agent **UUID**                                  |
| to_agent       | TEXT    | NULL — stores agent **UUID**. NULL for channel/broadcast messages |
| thread_id      | INTEGER | FK → messages(id)                                                 |
| branch_id      | INTEGER | FK → thread_branches(id) ON DELETE SET NULL                       |
| correlation_id | TEXT    | NULL — request/reply correlation UUID                             |
| content        | TEXT    | NOT NULL — max 50,000 chars, no null bytes                        |
| importance     | TEXT    | NOT NULL DEFAULT `'normal'` — `low`, `normal`, `high`, `urgent`   |
| ack_required   | INTEGER | NOT NULL DEFAULT `0`                                              |
| created_at     | TEXT    | NOT NULL DEFAULT `datetime('now')`                                |
| edited_at      | TEXT    | NULL                                                              |

**Indexes**: `idx_messages_channel(channel_id, created_at)`, `idx_messages_to(to_agent, created_at)`, `idx_messages_from(from_agent, created_at)`, `idx_messages_thread(thread_id)`, `idx_messages_branch(branch_id)`, `idx_messages_correlation(correlation_id)`

**FTS5**: `messages_fts` virtual table on `content`, maintained by INSERT/UPDATE/DELETE triggers.

### message_reads

| Column     | Type    | Constraints                         |
| ---------- | ------- | ----------------------------------- |
| message_id | INTEGER | FK → messages(id) ON DELETE CASCADE |
| agent_id   | TEXT    | NOT NULL                            |
| read_at    | TEXT    | NOT NULL DEFAULT `datetime('now')`  |
| acked_at   | TEXT    | NULL                                |

**PK**: `(message_id, agent_id)`

> **Note**: `agent_id` has no FK constraint — orphaned read records can remain after agent deletion. Cleaned up by stale cleanup job.

### state

| Column     | Type | Constraints                        |
| ---------- | ---- | ---------------------------------- |
| namespace  | TEXT | NOT NULL DEFAULT `'default'`       |
| key        | TEXT | NOT NULL — max 256 chars           |
| value      | TEXT | NOT NULL — max 100,000 chars       |
| updated_by | TEXT | NOT NULL                           |
| updated_at | TEXT | NOT NULL DEFAULT `datetime('now')` |
| expires_at | TEXT | NULL                               |

**PK**: `(namespace, key)`. **Indexes**: `idx_state_namespace(namespace)`, `idx_state_expires(expires_at) WHERE expires_at IS NOT NULL`

### feed_events

| Column     | Type    | Constraints                        |
| ---------- | ------- | ---------------------------------- |
| id         | INTEGER | PK AUTOINCREMENT                   |
| agent_id   | TEXT    | NULL                               |
| type       | TEXT    | NOT NULL                           |
| target     | TEXT    | NULL — max 256 chars               |
| preview    | TEXT    | NULL — max 500 chars               |
| created_at | TEXT    | NOT NULL DEFAULT `datetime('now')` |

**Indexes**: `idx_feed_events_agent`, `idx_feed_events_type`, `idx_feed_events_created`

### thread_branches

| Column            | Type    | Constraints                         |
| ----------------- | ------- | ----------------------------------- |
| id                | INTEGER | PK AUTOINCREMENT                    |
| parent_message_id | INTEGER | FK → messages(id) ON DELETE CASCADE |
| name              | TEXT    | NULL — 1-128 chars                  |
| created_by        | TEXT    | NULL                                |
| created_at        | TEXT    | NOT NULL DEFAULT `datetime('now')`  |

**Index**: `idx_thread_branches_parent(parent_message_id)`

### webhooks

| Column     | Type | Constraints                                        |
| ---------- | ---- | -------------------------------------------------- |
| agent_id   | TEXT | PK, FK → agents(id) ON DELETE CASCADE              |
| url        | TEXT | NOT NULL — webhook endpoint URL                    |
| secret     | TEXT | NOT NULL — HMAC-SHA256 signing key                 |
| events     | TEXT | NOT NULL DEFAULT `'["message:sent"]'` (JSON array) |
| created_at | TEXT | NOT NULL DEFAULT `datetime('now')`                 |

One webhook per agent. Upsert on re-register (ON CONFLICT DO UPDATE). Secret is provided by the registering agent (e.g. Hermes generates it via `hermes webhook subscribe`).

---

## 4. Agent Lifecycle

### Registration

- Agent sends `POST /api/agents` with `{name, capabilities?, metadata?, skills?, channels?}`
- Name must match `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}[a-zA-Z0-9]$/`, `human` reserved
- Max 20 capabilities, max 10K chars metadata JSON
- If name exists and is **not offline** → `409 Conflict`
- If name exists and is **offline** → reactivates: updates caps/metadata/skills, status→online
- If new → inserts with UUID, status=online
- Optional `channels` array → auto-joins those channels on registration
- Returns agent object + `joined_channels` if channels were specified

### Heartbeat

- `PUT /api/agents/:id/heartbeat` with optional `{status_text}` — updates `last_heartbeat`, sets status to `online`
- `GET /api/agents/:id/heartbeat` — read-only heartbeat status check. Returns `{agent_id, name, status, status_text, last_heartbeat, heartbeat_age_ms, heartbeat_age_s}` where `_ms` is milliseconds and `_s` is seconds since last heartbeat.
- Status text: max 256 chars, no control chars, nullable
- Only works on non-offline agents (404 if offline)
- **Auto-heartbeat (CLI)**: Triggered by commands: `agents`, `discover`, `send`, `broadcast`, `channels`, `channel`, `create-channel`, `read-status`, `thread`, `state set`, `state get`
- **Auto-heartbeat (MCP)**: Every tool call triggers heartbeat + 60s periodic timer
- **Auto-heartbeat** always sends `status_text: "active"`, best-effort (errors swallowed)

### Status Transitions

```
online ──(90s no heartbeat)──→ idle
idle   ──(300s total no heartbeat)──→ offline
online ──(heartbeat OK but 10min no activity)──→ idle (stuck detection)
offline ──(re-register or heartbeat)──→ online
```

### Reaper

- Runs every 30 seconds (`setInterval` with `.unref()`)
- Phase 1: online → idle after 90s no heartbeat
- Phase 2: idle/online → offline after 300s no heartbeat
- Phase 3: online with heartbeat but `last_activity` > 10min → idle (stuck)
- Never reaps `human` agent
- **On startup**: `resetOnStartup()` marks agents with heartbeat > 2min old as offline (regardless of OFFLINE_TIMEOUT)
- **OFFLINE_TIMEOUT=0**: Disables periodic reaper. On startup, all previously offline agents are reactivated to online via `reactivateAll()`
- Reaper errors logged to stderr, never crash

### Unregistration

- `DELETE /api/agents/:id` → status = `offline`, emits `agent:offline`
- No automatic unregistration anywhere in the system

---

## 5. Messaging System

### Message Types

| Type         | Routing                                          | Description                        |
| ------------ | ------------------------------------------------ | ---------------------------------- |
| Direct       | `from` → `to` (agent name or ID)                 | Private message between two agents |
| Channel      | `from` → `channel_id`                            | Delivered to all channel members   |
| Broadcast    | `from` → all online agents except sender         | Mass notification                  |
| Thread reply | `from` → same target as parent, with `thread_id` | Grouped conversation               |

### Message Properties

- **content**: non-empty string, max 50,000 chars, no null bytes
- **importance**: `low` | `normal` | `high` | `urgent` (default: `normal`)
- **ack_required**: boolean, enables acknowledgment tracking
- **thread_id**: references parent message for threaded conversations
- **branch_id**: references a thread branch for sub-conversations
- **correlation_id**: optional request/reply UUID used by `ask` to match exactly one reply
- **edited_at**: set when message content is updated

### Sending Rules

- Must specify either `to` (direct) or `channel` (channel), not both
- Broadcast is a separate endpoint (`POST /api/messages/broadcast`)
- If `thread_id` set, parent message must exist
- Only sender can edit or delete their messages
- Edit: updates `content` + `edited_at`
- Delete: hard delete (removes from DB)

### Message Send Endpoints

Two endpoints accept message creation — they differ in how the sender is identified:

| Endpoint                        | Used by           | Sender                            |
| ------------------------------- | ----------------- | --------------------------------- |
| `POST /api/messages`            | CLI (`ac send`)   | `from` field in body (agent name) |
| `POST /api/agents/:id/messages` | MCP (`comm_send`) | URL path `:id` (agent UUID)       |

Both accept the same body schema: `{from?, to?, channel?, content, thread_id?, correlation_id?, importance?}`.
CLI resolves agent name → UUID internally before calling `POST /api/messages`.
MCP handler extracts agent UUID from session context and routes via `POST /api/agents/:id/messages`.

### Read Tracking

- Per-agent `read_at` timestamps in `message_reads`
- Mark read: `POST /api/messages/:id/read` with `{agent_id}`
- Only recipient (direct) or channel member can mark
- Mark all read: `POST /api/agents/:id/read-all` — bulk marks all unread inbox
- **CLI auto-mark-read**: `inbox`, `poll`, `thread` automatically mark returned messages as read
- **Watch never marks read** — notification only

### Acknowledgment

- Messages with `ack_required: true` can be acknowledged separately from read
- Ack: upserts `message_reads` with `acked_at` timestamp
- Only recipient can acknowledge
- **MCP-only**: Acknowledgment is available via MCP `comm_send` (setting `ack_required`) and domain logic. No CLI command or REST endpoint exists for acking — this is a backend feature consumed by MCP clients.

### Threading

- Threads are **linear** — `thread_id` always points to the thread root message, not to another reply. This preserves a flat conversation structure.
- Thread root: message with no `thread_id` (or is the root of a thread)
- Thread replies: messages with `thread_id` pointing to the root
- Thread view: root + all replies ordered by `created_at`
- Branches: named sub-threads off a parent message (via `thread_branches` table). Branches allow diverging conversations from a single message.

### Search

- FTS5 full-text search on message content
- Returns: message + snippet + rank
- Filters: channel, from agent; limit capped [1, 100]
- Special FTS5 syntax stripped, words wrapped in quotes

### Polling

- Server-side long-poll: agent requests with timeout, server blocks until message arrives or timeout
- **Double-cap**: REST caps timeout to [0, 60] seconds, domain caps to [0, 60000] ms — both consistent at 60s max
- Client loops in chunks (55s) for longer waits
- **What poll returns**: all unread direct messages + channel messages for the agent, excluding self-sent messages. The `all=true` query parameter includes already-read messages.
- Poll does NOT maintain a per-agent watermark — it returns based on unread status. After poll returns and auto-marks-read, next poll only returns newly arrived messages.

### Inbox

- Direct messages to agent + messages from joined channels
- Excludes self-sent messages
- Filters: unread only, importance, limit [1, 500]

---

## 6. Channel System

- **Name validation**: `/^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/` (lowercase, 2-64 chars)
- **Create is idempotent**: if active channel with same name exists → returns existing; if archived → unarchives + updates description
- Creator is auto-joined on create
- **Join**: auto-creates channel if it doesn't exist (server-side behavior of `POST /api/channels/:name/join`). Fails if channel archived, silently ignores duplicate membership.
- **Leave**: always succeeds, removes membership
- **Archive**: `POST /api/channels/:name/archive` with `{agent_id}` — sets `archived_at`, only creator can archive. Archived channels hidden from default list. Available via MCP `comm_channel({ action: "archive" })` only — no CLI command.
- **Members**: ordered by `joined_at`
- **Channel messages**: filter messages by `channel_id`, supports limit

---

## 7. Shared State

Namespaced key-value store for inter-agent coordination.

- **Namespace + key**: composite PK. Key max 256 chars, no control chars
- **Value**: max 100,000 chars
- **TTL**: optional `expires_at` — ISO timestamp. Lazy expiration sweep on read.
- **UPSERT**: `ON CONFLICT DO UPDATE` — set creates or updates. Last-write-wins with no conflict detection.
- **CAS (compare-and-swap)**: transactional atomic operation within a single SQLite transaction (SERIALIZABLE isolation with WAL mode)
  - Reads current value, compares to `expected` (null = key should not exist)
  - If match: either deletes (if `new_value === ''`) or sets new value
  - Returns `{ swapped: true/false, current? }`
  - Used for file locks and coordination primitives
- **List**: filter by namespace and/or key prefix

---

## 8. Activity Feed

Structured event log for observability.

### Event Types

| Type            | Trigger                                     | Color |
| --------------- | ------------------------------------------- | ----- |
| `register`      | Agent registration                          | —     |
| `unregister`    | Agent going offline                         | —     |
| `message`       | Every sent message (DM, channel, broadcast) | —     |
| `state_change`  | State set/delete                            | —     |
| `channel_join`  | Agent joins channel                         | —     |
| `channel_leave` | Agent leaves channel                        | —     |
| `commit`        | External (hook)                             | —     |
| `test_pass`     | External                                    | —     |
| `test_fail`     | External                                    | —     |
| `file_edit`     | External                                    | —     |
| `task_complete` | External                                    | —     |
| `error`         | External                                    | —     |
| `custom`        | External                                    | —     |
| `handoff`       | External                                    | —     |
| `branch`        | External                                    | —     |
| `hook-block`    | File coordination hook blocking an edit     | —     |

### Rules

- **Heartbeats are NOT logged** — meaningful events only
- **Type validation**: the 16 types above are the known vocabulary. `POST /api/feed` accepts any string as `type` — unknown types are stored as-is. Use `custom` as the canonical escape hatch for external events.
- Preview truncated to 500 chars, target to 256 chars
- External systems can POST custom events via `POST /api/feed`
- Query: filter by agent, type, since; limit [1, 500], default 50

---

## 9. Rate Limiting

- **Algorithm**: Token bucket, in-memory, per-agent
- **Burst capacity**: 10 tokens
- **Refill rate**: 1 token/second (60/min sustained)
- **Scope** (mapped to REST endpoints):
  - `POST /api/messages` and `POST /api/messages/broadcast` — message sending
  - `POST /api/channels` — channel creation
  - `POST /api/channels/:name/join` — channel join
  - `POST /api/state/:ns/:key` — state set
  - `DELETE /api/state/:ns/:key` — state delete
  - `POST /api/state/:ns/:key/cas` — state CAS
- **NOT rate-limited**: heartbeat, inbox, poll, read/mark-read, feed query, agent CRUD, channel list/detail, search
- **Error**: `429 Rate Limited` with `{ error: "...", code: "RATE_LIMITED" }` when tokens exhausted
- New agents start with full bucket (10 tokens)

---

## 10. CLI Specification (`ac`)

Python CLI, stdlib only (urllib, json, argparse). Identity from `COMM_USER` env var.

### Config

- File: `~/.agent-comm/config.sh` — shell-style `KEY=VALUE` (supports quotes, `#` comments)
- Keys: `COMM_HOST`, `COMM_PORT` only
- Env vars override config file
- Defaults: `COMM_HOST=agent-comm-host`, `COMM_PORT=3420`
- Config must NOT contain agent name (shared by multiple agents on one host)

### Cross-Cutting Behaviors

**Auto-heartbeat**: These commands send heartbeat before executing:
`agents`, `discover`, `send`, `broadcast`, `channels`, `channel`, `create-channel`, `read-status`, `thread`, `state set`, `state get`, `watch`

**Watch heartbeat**: The `watch` command heartbeats automatically on every inbox fetch cycle (every `--interval` seconds). This keeps the agent online while listening.

**Auto-mark-read**: These commands mark returned messages as read:
`inbox`, `poll`, `thread`. `ask` marks only the matched reply message after displaying it.

**Read-marking principle (inviolable)**: A message is marked as read **only when it has been fully displayed to the agent**. No command may mark messages as read that the agent has not seen. `inbox`, `poll`, and `thread` display all fetched messages, so marking them read is correct. `ask` displays only the matched reply, so it must mark only that message — not the entire inbox batch. `watch` never marks read because it only prints one-line notifications (not full content).

**Auto-register**: Global `--auto-register` flag — registers before first command that needs COMM_USER. Idempotent (returns existing if already registered). Guard prevents recursion.

**Commands requiring COMM_USER** (call `_need_user()`): `register`, `unregister`, `heartbeat`, `send`, `broadcast`, `inbox`, `poll`, `watch`, `ask`, `mark-read`, `read-all`, `join`, `leave`, `create-channel`, `msg-edit`, `msg-delete`, `state set`, `state delete`

**Commands NOT requiring COMM_USER**: `health`, `agents`, `discover`, `channels`, `channel`, `read-status`, `thread`, `state get`, `feed`, `stuck`, `overview`

Note: `agents`, `discover` etc. don't need COMM_USER but trigger auto-heartbeat (which silently skips if no user set).

### Agent Lifecycle Commands

| Command      | Args/Flags               | Endpoint                        | Behavior                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`   | `--caps STR` (comma-sep) | `POST /api/agents`              | Register with capabilities                                                                                                                                                                                                                                                      |
| `unregister` | —                        | `DELETE /api/agents/:id`        | Set status offline                                                                                                                                                                                                                                                              |
| `heartbeat`  | `--status STR`           | `PUT /api/agents/:id/heartbeat` | Manual heartbeat with status text                                                                                                                                                                                                                                               |
| `agents`     | —                        | `GET /api/agents`               | List all agents (auto-heartbeat)                                                                                                                                                                                                                                                |
| `discover`   | `--skill`, `--tag`       | `GET /api/agents/discover`      | Find agents by skill/tag (auto-heartbeat). **Matching**: skill matches against skill `id` and `name` (case-insensitive LIKE). Tag matches against skill `tags` array (case-insensitive LIKE). If both provided → AND logic (agent must match both). Returns online agents only. |

### Messaging Commands

| Command               | Args/Flags                                        | Endpoint                            | Behavior                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send TO CONTENT`     | `--importance`, `--thread ID`, `--correlation-id` | `POST /api/messages`                | Send DM or channel msg. `TO` prefix `channel:` → channel msg                                                                                                                                                                            |
| `broadcast CONTENT`   | `--importance`                                    | `POST /api/messages/broadcast`      | Send to all online agents                                                                                                                                                                                                               |
| `inbox`               | `--unread`                                        | `GET /api/agents/:id/inbox`         | Check inbox (auto-mark-read)                                                                                                                                                                                                            |
| `poll`                | `--timeout 60`, `--all`, `--force`                | `GET /api/agents/:id/poll`          | Block until message (auto-mark-read, flock). **Mutually exclusive with watch** — both use the same flock. Use `ask` instead if watch is running.                                                                                        |
| `watch`               | `--interval 60`, `--max-unread 5`, `--debug`      | `GET inbox` (periodic)              | Background listener (never marks read, flock). See Watch — Detailed Behavior below.                                                                                                                                                     |
| `ask TO CONTENT`      | `--timeout 120`, `--require-online`               | send + inbox-check loop             | Send + wait for reply. **Does NOT use poll or flock** — works alongside a running `watch`. Default requires only that target exists; `--require-online` additionally fails when presence is offline. See Ask — Detailed Behavior below. |
| `mark-read ID`        | —                                                 | `POST /api/messages/:id/read`       | Mark single message                                                                                                                                                                                                                     |
| `read-all`            | —                                                 | `POST /api/agents/:id/read-all`     | Mark all inbox as read                                                                                                                                                                                                                  |
| `msg-edit ID CONTENT` | —                                                 | `PATCH /api/messages/:id`           | Edit own message                                                                                                                                                                                                                        |
| `msg-delete ID`       | —                                                 | `DELETE /api/messages/:id`          | Delete own message                                                                                                                                                                                                                      |
| `read-status ID`      | —                                                 | `GET /api/messages/:id/read-status` | Who read this message                                                                                                                                                                                                                   |
| `thread ID`           | —                                                 | `GET /api/messages/:id/thread`      | Full thread (auto-mark-read)                                                                                                                                                                                                            |

### Channel Commands

| Command               | Args/Flags   | Endpoint                         | Behavior                                  |
| --------------------- | ------------ | -------------------------------- | ----------------------------------------- |
| `channels`            | —            | `GET /api/channels`              | List all channels (auto-heartbeat)        |
| `channel NAME`        | —            | `GET /api/channels/:name`        | Channel detail (auto-heartbeat)           |
| `join CHANNEL`        | —            | `POST /api/channels/:name/join`  | Join channel (auto-creates if not exists) |
| `leave CHANNEL`       | —            | `POST /api/channels/:name/leave` | Leave channel                             |
| `create-channel NAME` | `--desc STR` | `POST /api/channels`             | Create channel (auto-heartbeat)           |

### State Commands

| Command                  | Args/Flags      | Endpoint                                                                            | Behavior                                                   |
| ------------------------ | --------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `state set NS KEY VALUE` | `--ttl SECONDS` | `POST /api/state/:ns/:key`                                                          | Set state value (auto-heartbeat)                           |
| `state get NS`           | `[KEY]`         | `GET /api/state/:ns/:key` (with KEY) or `GET /api/state?namespace=NS` (without KEY) | Get single value or list all in namespace (auto-heartbeat) |
| `state delete NS KEY`    | —               | `DELETE /api/state/:ns/:key`                                                        | Delete state entry                                         |

### Monitoring Commands

| Command    | Args/Flags                        | Endpoint            | Behavior                                  |
| ---------- | --------------------------------- | ------------------- | ----------------------------------------- |
| `health`   | —                                 | `GET /health`       | Server health check (no COMM_USER needed) |
| `feed`     | `--agent`, `--type`, `--limit 20` | `GET /api/feed`     | Activity feed (no COMM_USER needed)       |
| `stuck`    | —                                 | `GET /api/stuck`    | Show stuck agents (no COMM_USER needed)   |
| `overview` | —                                 | `GET /api/overview` | System overview (no COMM_USER needed)     |

### Webhook Commands

| Command                | Args/Flags     | Endpoint                   | Behavior                                                              |
| ---------------------- | -------------- | -------------------------- | --------------------------------------------------------------------- |
| `webhook register URL` | `--secret STR` | `POST /api/webhooks`       | Register webhook (auto-generates secret if omitted, prints to stderr) |
| `webhook list`         | —              | `GET /api/webhooks`        | List all webhooks (no COMM_USER needed)                               |
| `webhook delete`       | —              | `DELETE /api/webhooks/:id` | Delete your webhook                                                   |

### Output Format

- All commands: `json.dumps(data, indent=2, ensure_ascii=False)` to stdout
- `204 No Content`: nothing printed
- `watch`: one-line per message — `[MSG] ts=HH:MM:SS id=N from=Name [channel=Ch]: content`
- Errors: stderr + exit code 1

### Error Format (stderr)

| Condition             | Message                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| HTTP error            | `Error {code}: {message}`                                                                             |
| Connection failed     | `Connection failed: {reason}`                                                                         |
| Timeout               | `Error: request timed out`                                                                            |
| COMM_USER missing     | `Error: COMM_USER not set`                                                                            |
| Poll lock conflict    | `Error: agent X already has an active poll (PID N). Fix: wait for it, kill it, or use --force`        |
| Poll timeout          | `Error: poll timed out after Ns with no messages. This is normal — start a new poll to keep waiting.` |
| Ask timeout           | `No reply received (timeout)`                                                                         |
| Ask target offline    | `Error: agent "X" is offline (status: Y)` when `--require-online` is used                             |
| Watch unread overflow | `Error: too many unread messages (N). Clear your inbox first: ac read-all or ac inbox`                |

### Watch — Detailed Behavior

**Purpose**: Background notification listener. Never marks read. Never exits.

**Design principle**: Watch reports only **unread** messages. If an agent already read a message (via `inbox`, `thread`, or `ask`), watch will not report it — the agent already knows about it. Watch uses `?unread=true` intentionally; no durable `since_id` or `last_seen_id` watermark is allowed.

**Delivery invariant**: Starting `watch` must tell the agent about every currently unread message or fail with an overflow error. A crash/restart must not hide a still-unread message just because a previous `watch` process already emitted a notification for it. `watch` may keep an in-memory cursor only while the process is running to avoid repeating notifications in the same process.

**Startup**:

1. Acquire flock on `~/.agent-comm/locks/<name>.poll.lock` (no force — fails if poll running)
2. Install SIGTERM/SIGINT handlers → release lock + `os._exit(0)`
3. Fetch agent list → build name map
4. Initialize an in-memory `seen_ids` set/cursor for this process only
5. Fetch unread inbox (`?unread=true&limit=200`)
6. **Startup guard**: if unread count > 5, refuse to start. Print: `Error: too many unread messages (N). Clear your inbox first: ac read-all or ac inbox`. Exit 1. Threshold configurable via `--max-unread` (default 5).
7. Filter: exclude self-messages only, sort ascending
8. Display based on count: 0=silent, 1-5=all
9. Add displayed IDs to the in-memory `seen_ids` set/cursor. Do not write watch delivery state to disk.
10. Print `[WATCH] Listening...`

**Main loop**:

```
forever:
  sleep(interval)  // default 60s, configurable via --interval
  every 10 cycles: refresh name map
  heartbeat (best-effort, errors swallowed)
  fetch unread inbox (?unread=true&limit=200)
  on failure: increment counter, log every 10th, continue
  on success after failures: reset counter
  filter: exclude self + IDs already emitted by this watch process
  emit new messages, update in-memory seen_ids
```

**State file**: None. Watch delivery state is intentionally process-local. Durable read/unread state belongs to the server-side `message_reads` table.

**Coexistence with `ask`**: `ask` does NOT use the flock — it uses an inbox-check loop. Watch and ask can run simultaneously. If watch also prints the reply that `ask` is waiting for, the agent simply ignores the duplicate notification since `ask` already returned it.

### Ask — Detailed Behavior

**Purpose**: Send a message to a specific agent and wait for their reply. Works regardless of whether `watch` or `poll` is running.

**Flow**:

1. Resolve target agent → verify the recipient exists. Default behavior does not fail when the target is offline because presence is unreliable and some agents do not maintain online presence.
2. If `--require-online` is set, verify target status is online/idle. If offline → error.
3. Generate a correlation UUID and include it in the outbound request/reply contract.
4. Send message via `POST /api/messages`
5. Enter inbox-check loop:
   - Periodically fetch `GET /api/agents/:id/inbox?unread=true&limit=50` (does NOT use flock, does NOT mark read)
   - Scan fetched messages for reply: direct message from the target agent that carries the matching correlation UUID
   - If found: display the reply, then mark **only this message** as read via `POST /api/messages/:id/read`. All other fetched messages remain unread — watch or a subsequent `inbox` will handle them.
   - If timeout reached: print `No reply received (timeout)`, exit 1
   - Sleep between checks (5s default, configurable)
6. SIGTERM handler: clean exit with exit code 1

**Reply matching uses correlation UUID plus agent UUID** for correctness. The UUID prevents unrelated messages from the same agent from being mistaken for the reply.

**No flock**: ask intentionally does NOT acquire the poll/watch flock. This allows it to run alongside a background `watch` process. If `watch` also picks up the reply message and prints a notification, the agent can safely ignore it since `ask` already returned the same content.

### Poll — Detailed Behavior

- Acquires same flock as watch (mutual exclusion). **Poll and watch cannot run simultaneously.** Use `ask` for send+reply when watch is running.
- Supports `--force`: reads PID from lock, sends SIGTERM, polls up to 3s for death
- Server-side long-poll in 55s chunks, client loops
- Auto-marks returned messages as read
- SIGTERM handler: release lock + `os._exit(1)`

### Poll Lock (fcntl.flock)

- **File**: `~/.agent-comm/locks/<name>.poll.lock`
- **Mechanism**: `fcntl.flock(fd, LOCK_EX | LOCK_NB)` — non-blocking exclusive
- **Portability**: current Python CLI lock implementation is POSIX-only. Cross-platform CLI builds must abstract this before claiming Windows support.
- Kernel-guaranteed atomic, auto-released on any process death (even SIGKILL)
- Shared by poll and watch — agent runs exactly one at a time
- **Never delete lock files manually** — kill the process instead

---

## 11. Web UI Specification

### Architecture

- **Rendering**: Client-side, vanilla JS, no framework. morphdom for DOM patching.
- **Fingerprint skip**: `quickFingerprint()` hashes state — skips re-render if unchanged.
- **Full state on connect**: WebSocket sends complete snapshot on connect, then incremental deltas.
- **File structure**: IIFE modules attaching to `window.AC` namespace. No ES modules, no bundler.
- **Plugin support**: `AC.mount(container)` for embedding in shadow DOM (agent-desk integration).
- **Theme sync**: `postMessage({ type: 'theme-sync', colors })` from parent frame.
- **Libraries**: marked (Markdown), DOMPurify (XSS), morphdom (DOM diffing)

### Views

| View     | Hash        | Content                                                                                                                                                                                                |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview | `#overview` | 4 stat cards (agents online, channels, messages, state entries), active agents panel, recent activity (last 15 msgs), cleanup + refresh buttons                                                        |
| Agents   | `#agents`   | Card grid: status dot, name, status text, heartbeat freshness, capabilities tags, skill pills, message count. Click → filter messages. "Message" button → compose.                                     |
| Messages | `#messages` | Split pane. Left: search bar, filter chips, message list (avatar, from→to, time, preview, importance badge). Right: message detail (markdown, read status, thread, branches, reply/mark-read buttons). |
| Channels | `#channels` | Card grid: name, description, message count, archived badge. "New channel" button. Click → filter messages.                                                                                            |
| State    | `#state`    | Read-only table: namespace, key, value (truncated), updated by, updated at. Client-side filter.                                                                                                        |
| Feed     | `#feed`     | Timeline: type icon, agent, time, target, preview. Type filter dropdown. Infinite scroll.                                                                                                              |

### Human Communication

- **Compose modal**: toggle Agent/Channel, agent dropdown (excludes self), channel dropdown, priority selector, thread ID support
- Sends via `POST /api/messages/human` (server routes as from human agent)
- Ctrl+Enter to send, Escape to close
- **Reply**: from message detail, pre-fills compose with agent + thread
- **No broadcast, no forward** in UI (CLI-only features)

### Real-Time Updates

- WebSocket events: `agent:registered/updated/offline`, `message:sent/read/acked`, `channel:created/archived/member_joined/member_left`, `state:changed/deleted`
- Toast notifications for agent joins/leaves and new messages
- Human heartbeat: `POST /api/human/heartbeat` every 30s while dashboard open
- Auto-reconnect after 3s on disconnect

### Human Agent

- Auto-registered as `human` when dashboard opens
- Visible in `agents` list when online
- Never reaped by reaper
- Has full authority — can see all messages, trigger cleanup, clear all messages
- **Lifecycle**: Human goes offline only when server restarts (reaper never touches human). On dashboard close, heartbeat stops but status stays `online`/`idle` until reaper would act — but reaper skips human, so human stays "online" perpetually after first dashboard visit. This is intentional — human is always considered available.

### UI Limitations (vs CLI/MCP)

| Feature                     | Available                   |
| --------------------------- | --------------------------- |
| Broadcast messages          | ❌                          |
| Forward messages            | ❌                          |
| State editing               | ❌ (read-only)              |
| Channel join/leave/archive  | ❌ (create only)            |
| Agent unregister            | ❌                          |
| Per-message delete          | ❌ (clear all only)         |
| Skill-based agent discovery | ❌                          |
| Branch detail view          | ❌                          |
| Acknowledge messages        | ❌ (badge shown, no action) |
| Export data                 | ❌                          |

---

## 12. REST API Reference

### Health / Info

| Method | Path            | Response                                                            |
| ------ | --------------- | ------------------------------------------------------------------- |
| GET    | `/health`       | `{ status, version, uptime, agents }`                               |
| GET    | `/api/overview` | `{ agents, channels, recent_messages, state_entries, feed_events }` |
| GET    | `/api/export`   | `{ exported_at, agents[], channels[], messages[], state[] }`        |

### Agents

| Method | Path                        | Body                                                                 | Response                                                    | Errors                                      |
| ------ | --------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/agents`               | —                                                                    | `Agent[]`                                                   | —                                           |
| GET    | `/api/agents/discover`      | —                                                                    | `Agent[]` (online)                                          | Query: `?skill=&tag=`                       |
| GET    | `/api/agents/:id`           | —                                                                    | `Agent`                                                     | 404                                         |
| POST   | `/api/agents`               | `{name, capabilities?, metadata?, skills?, channels?}`               | `{...agent, joined_channels}`                               | 400, 409                                    |
| DELETE | `/api/agents/:id`           | —                                                                    | `{ ok: true }`                                              | 404                                         |
| GET    | `/api/agents/:id/heartbeat` | —                                                                    | `{agent_id, name, status, status_text, heartbeat_age_ms/s}` | 404                                         |
| PUT    | `/api/agents/:id/heartbeat` | `{status_text?}`                                                     | `{ok, agent_id, name}`                                      | 404                                         |
| GET    | `/api/agents/:id/inbox`     | —                                                                    | `Message[]`                                                 | Query: `?unread=true&limit=N`               |
| GET    | `/api/agents/:id/poll`      | —                                                                    | `Message[]` (blocking)                                      | Query: `?timeout=N&all=true`                |
| POST   | `/api/agents/:id/messages`  | `{to?, channel?, content, thread_id?, correlation_id?, importance?}` | `Message`                                                   | 400, 403, 404                               |
| POST   | `/api/agents/:id/read-all`  | —                                                                    | `{ok, marked}`                                              | 404                                         |
| GET    | `/api/stuck`                | —                                                                    | `Agent[]`                                                   | Query: `?threshold_minutes=N` (default: 10) |
| POST   | `/api/human/heartbeat`      | —                                                                    | `{ok, agent_id, name}`                                      | —                                           |

### Channels

| Method | Path                           | Body                               | Response                  | Errors                 |
| ------ | ------------------------------ | ---------------------------------- | ------------------------- | ---------------------- |
| GET    | `/api/channels`                | —                                  | `Channel[]` (active)      | —                      |
| POST   | `/api/channels`                | `{name, description?, created_by}` | `Channel`                 | 400, 500               |
| GET    | `/api/channels/:name`          | —                                  | `{...channel, members[]}` | 404                    |
| GET    | `/api/channels/:name/members`  | —                                  | `ChannelMember[]`         | 404                    |
| POST   | `/api/channels/:name/join`     | `{agent_id}`                       | `{ok, channel}`           | 400, 404               |
| POST   | `/api/channels/:name/leave`    | `{agent_id}`                       | `{ok}`                    | 400, 404               |
| POST   | `/api/channels/:name/archive`  | `{agent_id}`                       | `{ok}`                    | 403 (not creator), 404 |
| GET    | `/api/channels/:name/messages` | —                                  | `Message[]`               | Query: `?limit=N`      |

### Messages

| Method | Path                  | Body                                                                       | Response    | Errors                             |
| ------ | --------------------- | -------------------------------------------------------------------------- | ----------- | ---------------------------------- |
| GET    | `/api/messages`       | —                                                                          | `Message[]` | Query: `?from=&to=&limit=&offset=` |
| POST   | `/api/messages`       | `{from, to?, channel?, content, thread_id?, correlation_id?, importance?}` | `Message`   | 400, 403, 404                      |
| POST   | `/api/messages/human` | `{to?, channel?, content, importance?, thread_id?, correlation_id?}`       | `Message`   | 400                                |

**`POST /api/messages/human`** — used by Web UI compose modal. Server identifies sender as `human` agent automatically. Supports same fields as `POST /api/messages` except `from` (always `human`). If human agent not registered, auto-registers first.

| POST | `/api/messages/broadcast` | `{from, content, importance?}` | `Message[]` | 400, 403, 404 |
| GET | `/api/messages/:id/thread` | — | `Message[]` | 400, 404 |
| GET | `/api/messages/:id/read-status` | — | `{message_id, read_by[]}` | 400, 404 |
| PATCH | `/api/messages/:id` | `{agent_id, content}` | `Message` | 400, 404 |
| DELETE | `/api/messages/:id` | `{agent_id}` | `{deleted: true}` | 400, 404 |
| POST | `/api/messages/:id/read` | `{agent_id}` | `{ok: true}` | 400, 404 |
| DELETE | `/api/messages` | — | `{purged}` | — |

**`DELETE /api/messages`** — purges ALL messages and message_reads. No body, no agent_id, no confirmation. Any LAN client can call this. This is an intentional design decision for the trusted LAN model — used by human operator via Web UI "Clear all messages" button (with browser-side confirmation dialog).

### Search

| Method | Path          | Response                     | Query                       |
| ------ | ------------- | ---------------------------- | --------------------------- |
| GET    | `/api/search` | `{message, snippet, rank}[]` | `?q=&channel=&from=&limit=` |

### State

| Method | Path                      | Body                                              | Response                    | Errors                       |
| ------ | ------------------------- | ------------------------------------------------- | --------------------------- | ---------------------------- |
| GET    | `/api/state`              | —                                                 | `StateEntry[]`              | Query: `?namespace=&prefix=` |
| GET    | `/api/state/:ns/:key`     | —                                                 | `StateEntry`                | 404                          |
| POST   | `/api/state/:ns/:key`     | `{value, updated_by, ttl_seconds?}`               | `StateEntry`                | 400                          |
| DELETE | `/api/state/:ns/:key`     | —                                                 | `{deleted: true}`           | 404                          |
| POST   | `/api/state/:ns/:key/cas` | `{expected, new_value, updated_by, ttl_seconds?}` | `{swapped: bool, current?}` | 400                          |

### Feed

| Method | Path        | Body                                | Response      | Query                                 |
| ------ | ----------- | ----------------------------------- | ------------- | ------------------------------------- |
| GET    | `/api/feed` | —                                   | `FeedEvent[]` | `?agent=&type=&since=&limit=&offset=` |
| POST   | `/api/feed` | `{agent?, type, target?, preview?}` | `FeedEvent`   | 400                                   |

### Branches

| Method | Path                         | Response         | Query          |
| ------ | ---------------------------- | ---------------- | -------------- |
| GET    | `/api/branches`              | `ThreadBranch[]` | `?message_id=` |
| GET    | `/api/branches/:id`          | `ThreadBranch`   | —              |
| GET    | `/api/branches/:id/messages` | `Message[]`      | —              |

### Cleanup

| Method | Path                  | Response                                  |
| ------ | --------------------- | ----------------------------------------- |
| POST   | `/api/cleanup`        | `CleanupStats`                            |
| POST   | `/api/cleanup/stale`  | `StaleCleanupStats`                       |
| POST   | `/api/cleanup/full`   | `CleanupStats`                            |
| POST   | `/api/cleanup/feed`   | `{feed_events}` (body: `{max_age_days?}`) |
| DELETE | `/api/agents/offline` | `{purged}`                                |

### Webhooks

| Method | Path                     | Body                               | Response                | Errors   |
| ------ | ------------------------ | ---------------------------------- | ----------------------- | -------- |
| POST   | `/api/webhooks`          | `{agent_id, url, secret, events?}` | `WebhookSubscription`   | 400, 404 |
| GET    | `/api/webhooks`          | —                                  | `WebhookSubscription[]` | —        |
| GET    | `/api/webhooks/:agentId` | —                                  | `WebhookSubscription`   | 404      |
| DELETE | `/api/webhooks/:agentId` | —                                  | `{deleted: true}`       | 404      |

**`POST /api/webhooks`** — register or update a webhook for an agent. Upsert: if agent already has a webhook, replaces URL, secret, and events. Rate-limited. `agent_id` accepts name or UUID.

**`DELETE /api/webhooks/:agentId`** — remove webhook. `agentId` accepts name or UUID.

### Error Format

All errors: `{ error: string, code?: string }` with HTTP status. Codes: `NOT_FOUND` (404), `CONFLICT` (409), `VALIDATION_ERROR` (422), `RATE_LIMITED` (429).

---

## 13. WebSocket Protocol

### Connection

1. Client connects to `ws[s]://{host}`
2. Server sends full state: `{ type: "state", version, agents, channels, messages, messageCount, state, feed, branches }`
   - `agents`: full Agent[] (all agents including offline)
   - `channels`: active Channel[] only
   - `messages`: last 24h of messages, capped at 50
   - `messageCount`: total message count for display
   - `state`: all StateEntry[]
   - `feed`: last 30 FeedEvent[]
   - `branches`: all ThreadBranch[]
   - `version`: server version string
3. Client renders all views, hides loading overlay

### Events (server → client)

| Event                   | Data                                              | Effect                                |
| ----------------------- | ------------------------------------------------- | ------------------------------------- |
| `agent:registered`      | `{agent}`                                         | Upsert agent, toast "Agent joined"    |
| `agent:updated`         | `{agentId, status?, capabilities?, status_text?}` | Update agent fields                   |
| `agent:offline`         | `{agentId}`                                       | Set offline, toast "Agent left"       |
| `message:sent`          | `{message}`                                       | Prepend message (cap 50 local), toast |
| `channel:created`       | `{channel}`                                       | Upsert channel                        |
| `channel:archived`      | `{channelId}`                                     | Remove channel                        |
| `message:read`          | `{messageId, agentId}`                            | Update read status in message detail  |
| `message:acked`         | `{messageId, agentId}`                            | Update ack status                     |
| `channel:member_joined` | `{channelId, agentId}`                            | Update member list                    |
| `channel:member_left`   | `{channelId, agentId}`                            | Update member list                    |
| `state:changed`         | `{namespace, key, value, updated_by}`             | Upsert state entry                    |
| `state:deleted`         | `{namespace, key?}`                               | Remove entry/namespace                |
| `branch:created`        | `{branch}`                                        | Update branches list                  |

### Client → Server

- `{ type: "refresh" }` — request full state snapshot
- `{ type: "subscribe", events: [...] }` — filter events (documented, not actively used)

### Delta Sync (fingerprints)

Per-category fingerprints detect changes:

- `agents`: count + max(registered_at) + concatenated statuses
- `messages`: max(id) + count
- `channels`: count + max(created_at) + member count
- `state`: count + max(rowid) + max(updated_at)
- `feed`: max(id)
- `branches`: count + max(id)

Server periodically checks fingerprints → sends delta for changed categories only.

---

## 14. Configuration

### Server Environment Variables

| Variable                         | Default                | Description                                          |
| -------------------------------- | ---------------------- | ---------------------------------------------------- |
| `AGENT_COMM_PORT`                | `3421`                 | HTTP server port (prod: 3420 via Docker)             |
| `AGENT_COMM_DB`                  | `./data/agent-comm.db` | SQLite database path                                 |
| `AGENT_COMM_RETENTION_DAYS`      | `7`                    | Message/agent retention (clamped 1-365)              |
| `AGENT_COMM_FEED_RETENTION_DAYS` | `30`                   | Feed event retention (clamped 1-3650)                |
| `OFFLINE_TIMEOUT`                | `300`                  | Seconds before agent → offline. `0` = disable reaper |

### CLI Config

- File: `~/.agent-comm/config.sh`
- Format: `KEY=VALUE` (shell-style, supports `"quotes"`, `# comments`)
- Keys: `COMM_HOST`, `COMM_PORT` only
- Env vars override file
- Defaults: `agent-comm-host:3420`

### CLI File Layout

```
~/.agent-comm/
├── config.sh                      # Host + port config
├── locks/<name>.poll.lock         # Poll/watch flock files
└── agent-comm.db                  # Production DB (Docker bind mount)
```

---

## 15. Cleanup & Retention

### Automatic Cleanup

- Runs on configurable interval
- Deletes: offline agents older than retention, messages older than retention, orphaned reads, archived channels older than retention, expired state entries, old feed events

### Manual Cleanup

| Action         | Effect                                                                             |
| -------------- | ---------------------------------------------------------------------------------- |
| Stale          | Remove offline agents >1hr + their messages/reads/memberships/empty channels/state |
| Full           | Wipe all tables (nuclear)                                                          |
| Feed           | Delete feed events older than N days                                               |
| Purge messages | Delete all messages + reads                                                        |
| Purge offline  | Delete offline agents >1hr                                                         |

### Retention Defaults

- Messages: 7 days
- Feed events: 30 days
- Offline agents: 1 hour (purge threshold)
- All configurable via env vars

---

## 16. Security Model

- **LAN-only**: No public exposure, no TLS required
- **No authentication**: Trusted network, all agents known
- **Rate limiting**: Token bucket per agent (10 burst, 1/sec)
- **Input validation**: Name patterns, content length caps, no null bytes, no control chars in status text
- **CORS**: `Access-Control-Allow-Origin: *` on all responses
- **XSS protection**: DOMPurify on all rendered markdown in UI
- **No encryption**: Messages stored in plaintext in SQLite
- **Reserved name**: `human` cannot be used by agents
- **Edit/delete ownership**: Only sender can edit/delete their messages
- **Read ownership**: Only recipient or channel member can mark read

---

## 17. Webhook Notifications

Additive delivery mechanism alongside poll/watch/inbox. Agents register an HTTP endpoint and receive signed POST callbacks when messages arrive.

### Architecture

```
agent-comm ──(message:sent event)──→ WebhookService
                                         │
                                         ├── Resolve recipients (to_agent + channel members)
                                         ├── Filter: skip sender, check subscription events
                                         └── HTTP POST (fire-and-forget, HMAC-signed)
                                                    │
                                                    ▼
                                            External webhook receiver
                                            (e.g. Hermes webhook platform)
```

### Delivery

- **Trigger**: `message:sent` event fires after `sendMessage()` completes
- **Recipients**: direct message → `to_agent`; channel message → all channel members with webhooks
- **Fire-and-forget**: HTTP POST sent asynchronously, 5s timeout. Delivery failure does not block or retry.
- **Self-exclusion**: sender's webhook is never triggered

### Payload

```json
{
  "event": "message:sent",
  "timestamp": "2026-04-21T12:00:00.000Z",
  "data": {
    "id": 42,
    "from_agent": "agent-uuid",
    "to_agent": "recipient-uuid",
    "channel_id": null,
    "content": "message text",
    "importance": "normal",
    "created_at": "2026-04-21T12:00:00.000Z"
  }
}
```

### HMAC-SHA256 Signature

Every webhook POST includes `X-Hub-Signature-256: sha256=<hex>` and `X-GitHub-Event: message:sent` headers. Receiver validates:

```
signature = HMAC-SHA256(secret, requestBody)
```

The `secret` is provided by the registering agent. For Hermes agents, the secret is generated by `hermes webhook subscribe`.

### Hermes Integration

Hermes agents use dynamic webhook subscriptions. The secret is generated by Hermes, not agent-comm:

```bash
# 1. Create Hermes subscription (returns URL + secret)
hermes webhook subscribe agent-comm-<name> --deliver telegram --deliver-only \
  --prompt "Message from {data.from_agent_name}: {data.content}"

# 2. Register with agent-comm using Hermes-provided secret
ac webhook register <URL_FROM_STEP_1> --secret <SECRET_FROM_STEP_1>
```

Hermes config: `~/.hermes/config.yaml` → `display.platforms.webhook` (enabled + port + global secret). Gateway must be running: `hermes gateway run`.

This provides sub-second delivery with zero LLM cost — no background process needed (unlike `ac watch` which requires a running process with broken `_reader_loop` in hermes background mode; see `docs/HERMES.md`).

### Constraints

- One webhook URL per agent (MVP)
- Events filter defaults to `["message:sent"]`
- Webhook is **additive** — agents without webhooks use watch/poll/inbox as before
- No retry on failure (fire-and-forget)
- Rate-limited via existing token bucket

---

## 18. Known Issues & TODO

### Known Limitations

- **Poll timeout double-cap**: REST + domain both cap at 60s. To extend beyond, both must be changed.
- **WebUI missing features**: No broadcast, forward, state editing, channel management, per-message delete, agent unregister, skill discovery.

### Backlog

- [ ] Extend poll timeout beyond 60s (requires REST + domain changes)
- [ ] WebUI: broadcast, forward, state editing, channel join/leave/archive
- [ ] WebUI: per-message delete, agent unregister
- [ ] WebUI: skill-based agent discovery
- [ ] Webhook retry with exponential backoff (currently fire-and-forget)
- [ ] Webhook delivery status tracking (last_success_at, failure_count)

### Future Phases (NOT for MVP)

- **CLI: CAS and Ack commands**: Backend supports compare-and-swap state operations and message acknowledgment, but CLI `ac` lacks dedicated commands. Currently REST-only. Add `ac state cas NS KEY EXPECTED VALUE` and `ac ack ID` in future phase.
- **Database migrations**: Schema migration strategy, version tracking, backwards compatibility, rollback procedures
- **Performance & scaling**: Tested limits (max agents, messages/sec, concurrent WS, DB size), memory profiling, bottleneck documentation
- **Authorization**: Auth layer for API endpoints, agent token management, permission model, CORS hardening
- **Crash recovery**: WAL replay, integrity checks, corrupt DB handling, backup strategy
- **Deployment**: Docker/systemd/bare-metal ops, upgrade procedures, monitoring, rollback
- **Rate limiting hardening**: State endpoints (POST/DELETE/CAS) accept caller-supplied `updated_by` without resolving to canonical agent ID — a client can rotate strings to bypass the bucket. DELETE body is optional so omitting it skips the limiter entirely. Fix: resolve identity before rate-limiting, require agent_id on DELETE.
- **Inbox API pagination edge case**: The inbox API returns max 200 messages. If an agent has >200 unread, watch cannot inspect all unread messages in one request. Required behavior is to fail safely with an overflow/count error rather than silently skipping any unread message.
