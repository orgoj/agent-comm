# HXA Connect — Evaluation & Migration Decision

> Decision date: 2026-04-24
> Status: **APPROVED — migrate to HXA Connect with custom `ac-hxa` CLI**

---

## Context

Agent-comm is a custom-built inter-agent messaging server developed in-house. It works, but it's a solo-maintained project that reimplements what mature open-source tools already do. HXA Connect (v1.7.3, coco-xyz) is a self-hosted bot-to-bot messaging hub with significantly more features. This document evaluates whether to replace agent-comm with HXA Connect.

---

## Decision

**Replace agent-comm with HXA Connect. Write a custom `ac-hxa` CLI script** that provides the same watch/poll/ask notification workflow against HXA Connect's API.

What gets replaced:

- Agent-comm server → HXA Connect server
- Agent-comm REST/WebSocket API → HXA Connect REST/WebSocket API
- Agent-comm web dashboard → HXA Connect Next.js dashboard

What gets carried forward (rewritten):

- The `ac` CLI script → new `ac-hxa` script that talks to HXA Connect API

What gets dropped:

- MCP transport (not needed — agents use CLI, not MCP)
- File-coord hook (not needed for current use case)
- Bash guard hook (not needed for current use case)

---

## Reasoning

### Why replace agent-comm at all?

Agent-comm works for basic DM and channel messaging. But it lacks features that are standard in any serious messaging system:

- No thread-based collaboration
- No structured artifacts
- No rich content (only plain text)
- No multi-tenancy
- No production database support (SQLite only)
- No Docker deployment
- No SDK, no framework plugins

HXA Connect has all of these, plus active development (v1.7.3, 30+ issues resolved).

### Why keep a custom CLI script?

Most bot-to-bot systems (HXA Connect included) assume agents are always-on processes with persistent connections. Real agents — Claude Code, Hermes — are CLI tools. They start, do work, and stop. The notification problem is:

**How does a CLI agent discover it has a new message?**

HXA Connect's built-in mechanisms don't solve this for CLI agents:

1. **WebSocket** — requires persistent connection. CLI agents don't maintain one.
2. **Webhooks** — HTTP POST to agent's endpoint. SSRF protection blocks private IPs (10.x, 192.168.x), so **unusable on LAN**.
3. **Catchup API** — `GET /api/me/catchup?since=<ts>`. Pull-only, no blocking. Needs a client-side loop.

None of these work out-of-the-box for "run in background, output JSON Lines notifications, survive restarts". That's what `ac watch` does, and why we need a custom `ac-hxa` script.

### Why client-side polling is better than server-side blocking

Agent-comm's `ac poll` uses server-side blocking (server holds the connection until a message arrives). This is actually a fragile design:

- **Server restart** kills all blocking connections instantly
- **Network outage** drops the TCP connection, client must reconnect
- **Server state leak** — every blocking connection consumes resources
- The client must handle reconnection anyway, so the "blocking" benefit is illusory

Client-side polling (check every N seconds) is more robust:

- Server down? Next cycle retries automatically
- Network glitch? Next cycle retries automatically
- No server-side state to manage
- Simple, predictable behavior

HXA Connect's catchup API (`GET /api/me/catchup/count?since=<ts>`) is perfect for client-side polling. The `ac-hxa` script will poll this endpoint, and when `total > 0`, fetch the actual events.

### Why drop MCP transport?

MCP was a nice feature (7 native tools via stdio) but:

- Agents primarily use the CLI script (`ac`), not MCP
- HXA Connect doesn't support MCP, and adding it would require a custom MCP server wrapper
- The CLI script achieves the same result with less complexity

### Why drop file-coord and bash-guard hooks?

These are multi-agent coordination features (file locking, git commit protection). Not needed for the current messaging use case. If coordination becomes needed later, they can be ported to work with HXA Connect's API.

---

## Feature Comparison

### Messaging

| Feature              |            HXA Connect            |   Agent-Comm    | Migration impact            |
| -------------------- | :-------------------------------: | :-------------: | --------------------------- |
| Direct messages      |                Yes                |       Yes       | Direct replacement          |
| Channel messages     |                Yes                |       Yes       | Direct replacement          |
| Rich content (parts) | text, markdown, code, image, link | Plain text only | **Upgrade**                 |
| Message metadata     |       Yes (arbitrary JSON)        |       No        | **New capability**          |
| Mentions (@bot)      |          Yes (with @all)          |       No        | **New capability**          |
| Reply threading      |         Yes (`reply_to`)          |       No        | **New capability**          |
| Message search       |       Thread search (LIKE)        | FTS5 full-text  | Different scope, acceptable |

### Collaboration (Threads) — entirely new

| Feature                |                         HXA Connect                         | Notes                                                 |
| ---------------------- | :---------------------------------------------------------: | ----------------------------------------------------- |
| Collaboration threads  |                             Yes                             | Structured workflows with topic, status, participants |
| Thread lifecycle       | 5 states (active → blocked → reviewing → resolved → closed) | Full state machine                                    |
| Thread artifacts       |     Yes — versioned (text, md, code, json, file, link)      | Work products attached to threads                     |
| Thread participants    |         Yes — join/leave/invite/remove with labels          |                                                       |
| Thread permissions     |      Yes — visibility, join policy, write/manage roles      |                                                       |
| Thread tags            |                             Yes                             |                                                       |
| Optimistic concurrency |                Yes — ETag/revision on PATCH                 | Prevents lost updates                                 |

### Multi-Tenancy — entirely new

| Feature               |                HXA Connect                 | Notes |
| --------------------- | :----------------------------------------: | ----- |
| Organizations         |         Yes — full data isolation          |       |
| Org admin dashboard   |                    Yes                     |       |
| Bot approval workflow |       Yes (pending/active/rejected)        |       |
| Scoped tokens         | Yes (full, read, thread, message, profile) |       |
| Audit log             |                    Yes                     |       |

### Notification (custom `ac-hxa` script)

| Mechanism                            |              Current `ac`              |                  Planned `ac-hxa`                   | HXA API used                                                              |
| ------------------------------------ | :------------------------------------: | :-------------------------------------------------: | ------------------------------------------------------------------------- |
| **watch** (background notifications) | Poll `?unread=true`, JSON Lines output | Poll `catchup/count` every N sec, JSON Lines output | `GET /api/me/catchup/count?since=<ts>` + `GET /api/me/catchup?since=<ts>` |
| **poll** (blocking wait)             |   Server-side blocking (60s chunks)    |    Client-side polling loop (2-3 sec intervals)     | Same catchup endpoints                                                    |
| **ask** (send + wait for reply)      |         UUID matching on inbox         |     Same pattern, adapted to HXA message format     | `POST /api/send` + catchup polling                                        |
| **inbox**                            |      `GET /api/agents/:id/inbox`       |             `GET /api/inbox?since=<ts>`             | Direct replacement                                                        |
| **send**                             |          `POST /api/messages`          |                  `POST /api/send`                   | Direct replacement                                                        |

**Read-marking**: HXA uses timestamp-based catchup (server records events per bot), not per-message read/unread. The `ac-hxa` script will track `last_seen_ts` in a state file — simpler and equally effective.

### Web UI

| Feature           |               HXA Connect               | Agent-Comm |
| ----------------- | :-------------------------------------: | :--------: |
| Framework         |             Next.js (React)             | Vanilla JS |
| DM view           |                   Yes                   |    Yes     |
| Thread view       | Yes (artifacts, settings, participants) |     No     |
| Admin dashboard   | Yes (org settings, bot approval, audit) |     No     |
| Multi-language    |         Yes (English, Chinese)          |     No     |
| Real-time updates |                WebSocket                | WebSocket  |

### Deployment

| Feature          |  HXA Connect   | Agent-Comm |
| ---------------- | :------------: | :--------: |
| SQLite           |      Yes       |    Yes     |
| PostgreSQL       |      Yes       |     No     |
| Docker           |      Yes       |     No     |
| One-line install |      Yes       |     No     |
| Reverse proxy    | Yes (sub-path) |     No     |

---

## `ac-hxa` CLI Design

TypeScript + `@coco-xyz/hxa-connect-sdk` (MIT, single dep: `ws`).
Compiled with `bun build --compile` to a single native binary — no runtime needed, cross-platform (Linux, macOS, Windows).

The SDK provides a fully typed client (`HxaConnectClient`) with all API methods built-in: `send()`, `inbox()`, `catchup()`, `catchupCount()`, `listPeers()`, `createThread()`, `sendThreadMessage()`, `addArtifact()`, plus `ThreadContext` for buffered @mention delivery with `toPromptContext()` for LLM integration.

### Commands

```
ac-hxa register --org ORG_ID --ticket TICKET --name my-agent
ac-hxa send <to> <content>
ac-hxa inbox [--since TS]
ac-hxa watch [--interval 5] [--max-unread 50]
ac-hxa poll [--timeout 600]
ac-hxa ask <to> <content> [--timeout 120]
ac-hxa threads [--status active]
ac-hxa thread-create <topic> [--participants bot1,bot2]
ac-hxa thread-msg <thread-id> <content>
ac-hxa artifact <thread-id> <key> <content> [--type markdown]
```

### Config

Stored in `~/.agent-comm/config.sh` (same location as current `ac`):

```bash
export AC_HXA_TOKEN="bot_xxx"
export AC_HXA_URL="http://agent-comm-host:4800"
export AC_HXA_ORG="org-id"
```

### State

Watch/poll state in `~/.agent-comm/state/<agent>.watch.state` (last_seen_ts).

### Why TypeScript + Bun instead of Python

1. **Official SDK** — don't reimplement HTTP calls. SDK handles auth, types, reconnection.
2. **Single binary** — `bun build --compile` produces a standalone executable. No Python, no Node, no runtime.
3. **Cross-platform** — same binary works on Linux, macOS, Windows (Bun cross-compiles).
4. **MIT SDK** — no license concerns, can modify freely.
5. **Smaller code** — SDK does the heavy lifting. Estimated ~300-400 lines vs 700 in Python.

---

## Migration Plan

1. **Deploy HXA Connect** — Docker on LAN server, create org, register bots
2. **Write `ac-hxa` CLI** — TypeScript + `@coco-xyz/hxa-connect-sdk`, watch/poll/ask against HXA catchup API
3. **Build binaries** — `bun build --compile` for Linux, macOS, Windows
4. **Update Hermes integration** — point poll loop at `ac-hxa poll`
5. **Update Claude Code integration** — point watch background process at `ac-hxa watch`
6. **Validate** — same notification flow, same JSON Lines output
7. **Decommission agent-comm** — stop server, archive repo

---

## What Gets Dropped (and why it's OK)

| Dropped feature            | Reason                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| MCP transport              | Agents use CLI, not MCP. CLI subprocess is simpler and more portable.                                                 |
| File-coord hook            | Multi-agent file locking not needed for current use case. Can be ported later if needed.                              |
| Bash guard hook            | Same — not needed now, portable later.                                                                                |
| Server-side blocking poll  | Fragile design — server restart or network outage kills all blocking connections. Client-side polling is more robust. |
| LAN-compatible webhooks    | Not needed — `ac-hxa watch` replaces the notification use case entirely.                                              |
| FTS5 full-text search      | HXA has thread search. Per-message FTS not critical.                                                                  |
| Lightweight stack (3 deps) | HXA runs in Docker, deps don't matter. `ac-hxa` uses SDK + Bun = single binary.                                       |

---

## Risks

| Risk                                         | Mitigation                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| HXA Connect abandoned by coco-xyz            | Self-hosted, we have the source. Modified Apache 2.0 license.                                             |
| License restrictions (multi-tenant, logo)    | Single-org self-hosted use is explicitly permitted. Logo only applies to frontend, which we can override. |
| `ac-hxa` script needs maintenance            | ~500 lines Python, simpler than agent-comm server.                                                        |
| Catchup polling generates more HTTP requests | Trivial load for a few agents on LAN. Every 3 sec = ~20 req/min per agent.                                |
| No per-message read/unread                   | Timestamp-based catchup is simpler and sufficient.                                                        |

---

## License

HXA Connect: Modified Apache 2.0 (coco-xyz, 2026).

- Self-hosted and internal commercial use: **permitted**
- Multi-tenant hosted service: **requires commercial license**
- Logo removal from frontend: **not permitted** (frontend only, API usage unaffected)
