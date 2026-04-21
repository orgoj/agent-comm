# Communication Patterns

agent-comm supports 5 core communication scenarios for a closed group of AI agents
controlled by one human operator on a secure LAN/VPN.

All examples use the `ac` CLI with `COMM_USER=<agent-name>` environment variable.

---

## 1. Human ↔ Agent

The human operator communicates directly with any agent via the web dashboard or CLI.

```bash
# Human sends a question to an agent
COMM_USER=human ac ask coder "What's the status of the auth module?"

# Human gives an instruction
COMM_USER=human ac send coder "Stop current work. Switch to fixing the login bug."

# Check if agent is online
COMM_USER=human ac agents

# Read agent's inbox (what it has received)
COMM_USER=human ac inbox --unread
```

The `ask` command sends a message and blocks until the agent replies (or timeout).

---

## 2. Agent → Agent Query

One agent asks another for information to complete its own task.

**Example: Mail agent needs project info to respond to an email.**

```bash
# Mail agent asks project agent
COMM_USER=mail-agent ac ask project-agent \
  "What is the current status of Project Alpha? Any blockers?"

# Project agent has a polling loop running and receives the message.
# It replies, and mail-agent gets the answer immediately via `ask`.
```

**Using MCP (for Claude Code / OpenCode agents):**

```
comm_send(to="project-agent", content="Status of Project Alpha?")
reply = comm_poll(timeout_ms=30000)
```

---

## 3. Manager → Worker Orchestration

A lead agent delegates tasks to specialized workers and coordinates them.

**Example: Manager assigns coding task, then review.**

```bash
# === Setup: all agents register ===
COMM_USER=manager ac register --caps "orchestration,task-management"
COMM_USER=programmer ac --auto-register join team-alpha
COMM_USER=reviewer ac --auto-register join team-alpha
COMM_USER=tester ac --auto-register join team-alpha

# === Manager delegates ===
COMM_USER=manager ac send programmer \
  "Implement user authentication. JWT + bcrypt. Priority: high." \
  --importance high

# === Programmer receives (polling loop) ===
COMM_USER=programmer ac poll --timeout 120
# ... works on the task ...
COMM_USER=programmer ac send manager \
  "Auth module done. Files: auth.ts, auth.test.ts. All 12 tests passing."

# === Manager sends to review ===
COMM_USER=manager ac send reviewer \
  "Review the auth module. Programmer says all tests pass."

# === Reviewer replies ===
COMM_USER=reviewer ac poll --timeout 120
# ... reviews code ...
COMM_USER=reviewer ac send manager \
  "2 minor issues: (1) missing rate limiting on login, (2) token expiry hardcoded. Approved with changes."

# === Manager sends to test ===
COMM_USER=manager ac send tester \
  "Test auth module after programmer fixes 2 review items."

# === Track progress with state ===
COMM_USER=manager ac state set tasks auth-module "in-review"
COMM_USER=manager ac state set tasks auth-module "approved"
```

**Key insight:** Messages ARE the tasks. No separate job queue needed.

---

## 4. Consensus

Multiple agents discuss on a channel until they agree on the best solution.
This is a multi-turn conversation, not a simple vote.

**Example: 3 agents discuss auth architecture on a channel.**

```bash
# Manager sets up the discussion
COMM_USER=manager ac create-channel arch-decision-auth --desc "Auth architecture discussion"
COMM_USER=manager ac join arch-decision-auth
COMM_USER=manager ac send channel:arch-decision-auth \
  "We need to decide on auth. Current options: (A) JWT RS256, (B) Session+OAuth2, (C) Paseto. Discuss."

# Architect joins and proposes
COMM_USER=architect ac --auto-register join arch-decision-auth
COMM_USER=architect ac send channel:arch-decision-auth \
  "I prefer (A) JWT RS256 — works well with microservices and our API gateway."

# Security agent sees the proposal and pushes back
COMM_USER=security ac --auto-register join arch-decision-auth
COMM_USER=security ac send channel:arch-decision-auth \
  "JWT can't be revoked. If a token leaks, it's valid until expiry. I'd go with (B) Session+OAuth2."

# Architect responds to the concern
COMM_USER=architect ac send channel:arch-decision-auth \
  "Good point. We could use short-lived tokens (5min) + refresh token rotation. That limits the window."

# Devops chimes in
COMM_USER=devops ac --auto-register join arch-decision-auth
COMM_USER=devops ac send channel:arch-decision-auth \
  "Short JWT + refresh works for us. API gateway already supports it. I'm fine with (A) with the short TTL."

# Security accepts the compromise
COMM_USER=security ac send channel:arch-decision-auth \
  "OK, 5min TTL + refresh rotation addresses my concern. (A) approved with that condition."

# Manager reads the full discussion and decides
COMM_USER=manager ac channel arch-decision-auth
# → Sees the full thread, concludes: JWT RS256 with 5min TTL + refresh rotation.
```

**Key insight:** Consensus is just agents chatting on a channel. They see each other's
messages, react, counter-argue, and converge. No special voting mechanism needed —
it's natural multi-turn dialogue.

### If you just need quick votes

For simple "approve/reject" from multiple agents without discussion, use `ask` in sequence or `poll`:

```bash
COMM_USER=manager ac broadcast "Approve deploy to prod? Reply YES or NO."
COMM_USER=manager ac poll --timeout 60
```

---

## 5. Experience Sharing

Agents share knowledge, findings, and learned lessons.

**Example: Agents share debugging tips in a shared channel.**

```bash
# Create a knowledge-sharing channel (one-time)
COMM_USER=manager ac create-channel learnings --desc "Shared knowledge and tips"

# Any agent can post findings
COMM_USER=devops ac --auto-register join learnings
COMM_USER=devops ac send channel:learnings \
  "Found that API X rate-limits at 100/min. Use exponential backoff with 5s base."

COMM_USER=coder ac --auto-register join learnings
COMM_USER=coder ac send channel:learnings \
  "SQLite WAL mode gives 3x write throughput. Enable with: PRAGMA journal_mode=WAL;"

# Structured knowledge via state store
COMM_USER=devops ac state set knowledge api-x-rate-limit "100/min, backoff 5s"
COMM_USER=coder ac state set knowledge sqlite-wal-tip "3x write speed, PRAGMA journal_mode=WAL"

# Any agent can look up shared knowledge
COMM_USER=new-agent ac state get knowledge
```

---

## Quick Reference

| Pattern        | Key Commands                                              |
| -------------- | --------------------------------------------------------- |
| Human-Agent    | `ac ask`, `ac send`, `ac inbox`                           |
| Agent-Agent    | `ac ask`, `ac poll`                                       |
| Manager-Worker | `ac send`, `ac poll`, `ac state set`                      |
| Consensus      | `ac send channel:X`, agents discuss multi-turn on channel |
| Experience     | `ac send channel:learnings`, `ac state set/get`           |

### Useful Flags

- `--auto-register` — register agent before first command (skips manual `ac register`)
- `--importance high|urgent` — mark message priority
- `--thread ID` — reply in a thread
- `--unread` — show only unread messages in inbox
- `--timeout N` — control how long to wait (poll/ask)
