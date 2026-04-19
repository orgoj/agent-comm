---
name: agent-comm-decisions
description: Design decisions and project rules for agent-comm. Read this before making changes.
version: 1.0.0
category: agent-comm
---

# Agent-Comm Project Decisions

## Project Goal

Communication platform for **closed group of AI agents** controlled by **one human operator** on LAN/VPN. v1 target.

- All repo content in English (GitHub)
- Primary comms = HTTP via CLI wrapper (`ac`) + Web UI
- Agents: Hermes, Claude Code, Codex, Gemini, OpenCode, Pi Mono

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
- `ac wait-replies --count N` for gathering N responses
- `ac --auto-register` flag for first-use convenience

## Fork Rules

- This is a fork — **never remove** existing features, only add
- KISS — no unnecessary complexity

## Agent Onboarding

- Onboarding skill is self-contained, no references to other skills
- Agent receives address + name from human in chat
- Agent creates config, registers, joins channels, enters poll loop
- One long-running session, poll loop inside it — NOT new session per message
