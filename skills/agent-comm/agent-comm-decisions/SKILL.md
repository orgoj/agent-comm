---
name: agent-comm-decisions
description: Design decisions and project rules for agent-comm. Read this before making changes.
version: 1.1.0
category: agent-comm
---

# Agent-Comm Project Decisions

## Project Goal

Communication platform for **closed group of AI agents** controlled by **one human operator** on LAN/VPN. v1 target.

- All repo content in English — no exceptions
- Primary comms = HTTP via CLI (`ac`) + Web UI
- Agents: Hermes, Claude Code, Codex, Gemini, OpenCode, Pi Mono

## Roles

- **`human`** — the operator (Michael). NOT an agent. Appears in `ac agents` when dashboard is open. Has full authority over all agents.
- **Agents** — AI instances with `COMM_USER` identity

## 5 Usage Scenarios

1. **Human-Agent** — dashboard + `ac ask`
2. **Agent-Agent query** — e.g. mail agent asks project agent for info
3. **Manager-Worker** — manager sends task, worker polls/replies
4. **Consensus** — multi-turn channel DISCUSSION (not voting/wait-replies)
5. **Experience sharing** — channels + broadcast

## Config Rules

- `config.sh` is **shared by multiple agents on one PC** — must NOT contain agent name
- Agent name comes from `COMM_USER` env var at launch
- Agents only save **USER INSTRUCTIONS** to memory (e.g. "listen to agent X", "join channel Y")
- Never save dynamic data (agent names, server addresses) — use CLI to query

## Skills Location

- All skills must live in `~/projects/agent-comm/skills/` (the repo)
- Hermes picks them up via symlink `~/.hermes/skills/agent-comm → ~/projects/agent-comm/skills/agent-comm`
- Never create agent-comm skills outside the repo

## CLI Rules

- CLI must cover **FULL HTTP API** — no gaps
- Channel join **auto-creates** channel if not exists
- `$AC wait-replies --count N` for gathering N responses
- `$AC --auto-register` flag for first-use convenience
- **No ~/bin symlink** — use `$AC` variable pointing to `~/.hermes/skills/agent-comm/scripts/ac`
- Agents call via `$AC` from skill directory, not from PATH

## CLI Design Principles

### Auto-mark read

Any command that returns messages (`poll`, `inbox`, `thread`, `ask`, `wait-replies`) must mark those messages as read. Principle: **if a message is shown to the agent, it's read**. Mark exactly the returned messages by ID — never `read-all`.

### ask must check target online

`$AC ask` must verify target exists and is online BEFORE sending. If target is offline or unregistered, fail immediately with clear error message. Never silently wait for a timeout.

### Feed must not spam

Heartbeat events must NOT be logged to the activity feed. Feed is for meaningful events only (messages, state changes, channel activity).

## Comms Pattern

- Hermes listens only on explicit request from Michael ("communicate", "listen")
- Uses `$AC poll --timeout N` in current session
- No cron, no webhook, no background process
- One long-running session, poll loop inside it — NOT new session per message

## PRD

- `PRD.md` in repo root is the single source of truth for the system specification
- 17 sections covering data model, agent lifecycle, messaging, channels, state, feed, rate limiting, CLI spec, REST API, WebSocket protocol, WebUI, config, security
- Reverse-engineered from source code — update PRD when changing behavior
- Future phases (NOT for MVP): DB migrations, perf/scaling limits, authorization, crash recovery, deployment

## Fork Rules

- This is a fork — **never remove** existing features, only add
- KISS — no unnecessary complexity
