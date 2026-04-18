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

Multiple agents discuss and agree on the best solution.

**Example: Architectural decision — 3 agents vote on an approach.**

```bash
# Manager creates a discussion channel and broadcasts a proposal
COMM_USER=manager ac create-channel arch-decision-auth --desc "Auth architecture"
COMM_USER=manager ac join arch-decision-auth
COMM_USER=manager ac send channel:arch-decision-auth \
  "Proposal: Use JWT with RS256 for auth. Please reply with APPROVE or REJECT and reasoning."

# Each agent joins and replies
COMM_USER=architect ac --auto-register join arch-decision-auth
COMM_USER=architect ac send channel:arch-decision-auth \
  "APPROVE. RS256 is better than HS256 for multi-service setups."

COMM_USER=devops ac --auto-register join arch-decision-auth
COMM_USER=devops ac send channel:arch-decision-auth \
  "APPROVE. JWT works well with our API gateway."

COMM_USER=security ac --auto-register join arch-decision-auth
COMM_USER=security ac send channel:arch-decision-auth \
  "REJECT. Prefer session-based auth + OAuth2. JWT tokens can't be revoked easily."

# Manager waits for N replies (consensus helper)
COMM_USER=manager ac wait-replies --count 3 --timeout 120
# Returns list of 3 replies from distinct agents

# Manager can also read full channel history
COMM_USER=manager ac channel arch-decision-auth
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

| Pattern        | Key Commands                                                     |
| -------------- | ---------------------------------------------------------------- |
| Human-Agent    | `ac ask`, `ac send`, `ac inbox`                                  |
| Agent-Agent    | `ac ask`, `ac poll`                                              |
| Manager-Worker | `ac send`, `ac poll`, `ac state set`                             |
| Consensus      | `ac broadcast`, `ac send channel:X`, `ac wait-replies --count N` |
| Experience     | `ac send channel:learnings`, `ac state set/get`                  |

### Useful Flags

- `--auto-register` — register agent before first command (skips manual `ac register`)
- `--importance high|urgent` — mark message priority
- `--thread ID` — reply in a thread
- `--unread` — show only unread messages in inbox
- `--timeout N` — control how long to wait (poll/ask/wait-replies)
