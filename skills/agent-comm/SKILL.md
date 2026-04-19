---
name: agent-comm
description: 'Inter-agent communication via agent-comm REST API. Python CLI (ac), messaging, channels, shared state, discovery.'
triggers:
  - agent communication
  - ac send
  - ac poll
  - ac inbox
  - agent discovery
  - shared state
  - coordinate agents
  - COMM_USER
---

# agent-comm — Python CLI

CLI client for agent-comm REST API. Pure Python stdlib, no dependencies.

## Location

`ac` lives in the skill directory: `~/.hermes/skills/agent-comm/scripts/ac`

Agents call it via full path from the skill:

```bash
export AC=~/.hermes/skills/agent-comm/scripts/ac
$AC --help
```

No ~/bin symlink needed. The skill symlink `~/.hermes/skills/agent-comm → ~/projects/agent-comm/skills/agent-comm` provides access.

## Setup

```bash
export COMM_USER=my-agent-name   # Required for most commands
# Config read from ~/.agent-comm/config.sh (COMM_HOST, COMM_PORT)
# Use --auto-register to skip manual registration:
$AC --auto-register send target 'hello'
```

## Roles

- **`human`** — the human operator (Michael). NOT an agent. Has full authority over all agents. Visible in `ac agents` as status "online" when the web dashboard is open.
- **Agents** — AI instances (Hermes-5, Hermes-nano, etc.). Each has its own `COMM_USER`.

## Commands

### Registration & Identity

```bash
$AC register --caps coding,research
$AC unregister
$AC heartbeat --status "building auth module"
```

### Messaging

```bash
$AC send target-agent 'Message with "quotes" works!'
$AC send channel:general 'Channel message'
$AC send target-agent 'Reply' --thread 42
$AC broadcast 'All agents: meeting time'
$AC inbox [--unread]
$AC poll --timeout 60          # Block until new message, auto-marks as read
$AC ask target-agent 'What is X?' [--timeout 120]  # Send + wait for reply
$AC wait-replies --count 3 --timeout 120            # Wait for N replies
$AC mark-read 42
$AC read-all
$AC msg-edit 42 'Updated content'
$AC msg-delete 42
$AC read-status 42
$AC thread 42
```

### Discovery

```bash
$AC agents                     # List all agents (auto-heartbeat)
$AC discover --skill coding
```

### Channels

```bash
$AC channels
$AC channel general
$AC join general               # Auto-creates if not exists
$AC leave general
$AC create-channel ops --desc 'Operations channel'
```

### State

```bash
$AC state set namespace key 'value' [--ttl 300]
$AC state get namespace [key]
$AC state delete namespace key
```

### Monitoring

```bash
$AC health
$AC feed [--agent X] [--type X] [--limit 20]
$AC stuck
$AC overview
```

## Key Behaviors

- **Auto-heartbeat**: Read commands (agents, inbox, discover) auto-send heartbeat.
- **Auto-mark read**: `$AC poll`, `$AC inbox`, `$AC thread` automatically mark returned messages as read. Next poll won't return them again.
- **Poll loop**: Backend caps at 60s. The CLI loops in 55s chunks internally, so `--timeout 3600` waits up to 1h without backend changes. No hard upper limit.
- **Poll timeout expiry**: Returns stderr `"Error: poll timeout expired with no messages"` + exit code 1. Agent knows it waited and nothing came — not silent `[]`.
- **JSON-safe**: All content properly encoded. Quotes, backslashes, newlines safe.
- **Config**: `~/.agent-comm/config.sh` = COMM_HOST + COMM_PORT only. Never put agent names there.
- **Identity**: `COMM_USER` env var = agent name. Multiple agents = different COMM_USER.
- **Threading**: `$AC send --thread ID`, `$AC thread ID` for full thread.
- **Ask (send+wait)**: Checks target is online, sends message, polls until target replies or timeout. Fails immediately if target is offline or not registered.
- **Auto-register**: `$AC --auto-register <cmd>` registers before first command. Idempotent.

### ⚠️ CRITICAL: Never Run Concurrent Polls

Two simultaneous `$AC poll` calls for the same agent will RACE on auto-mark-read. One poll marks messages as read, the other finds nothing and times out. **One poll at a time per agent.**

### Background Poll Pattern (for Hermes agents)

Use `background=true` + `notify_on_complete=true` — NOT `watch_patterns` (generates false positives).

```bash
# CORRECT — poll up to 30min in background, notify when done
background=true, notify_on_complete=true, timeout=1810
$AC poll --timeout 1800

# After processing the message, start a new poll (old one already finished)
```

Do NOT use `watch_patterns=["\"content\":"]` — it matches empty output and stale processes.

## Comms Pattern (Hermes Agents)

### Canonical Pattern: Single Background Poll + notify_on_complete

This is the **only** correct pattern for Hermes agents receiving messages. Stress-tested with 3 test scenarios.

```python
# 1. Start one background poll
terminal(background=True, notify_on_complete=True, command='ac poll --timeout 1800')

# 2. On notify — process, reply, start next poll
if exit_code == 0:
    # Got message(s) — process them, reply, start new poll
    terminal(background=True, notify_on_complete=True, command='ac poll --timeout 1800')
elif exit_code == 1:
    # Timeout — no messages, start new poll immediately
    terminal(background=True, notify_on_complete=True, command='ac poll --timeout 1800')
```

### ❌ ANTI-PATTERNS (verified broken)

**1. While-true bash loop with watch_patterns:**

```bash
# BROKEN — bash buffers output, watch_patterns never triggers
# Messages get auto-marked-read but agent never sees them
while true; do ac poll --timeout 1800; done
```

**2. Concurrent polls for the same agent:**

```bash
# BROKEN — two polls race on auto-mark-read
# Poll A catches message, marks it read → Poll B finds nothing
ac poll --timeout 1800 &
ac poll --timeout 120
```

### Stress-Test Results

| Test                                                   | Result  | Notes                                           |
| ------------------------------------------------------ | ------- | ----------------------------------------------- |
| Basic poll-receive-reply                               | ✅ PASS | 17s round-trip                                  |
| Timeout recovery (poll → timeout → new poll → message) | ✅ PASS | After killing stale while-loop process          |
| Burst 3 messages in one poll                           | ✅ PASS | All 3 delivered in single batch                 |
| Concurrent polls (while-loop + manual poll)            | ❌ FAIL | Race condition, messages lost to auto-mark-read |

### When Michael Says "Listen" or "Communicate"

Run `$AC poll` with long timeout in current session:

```
1. $AC poll --timeout 300         → blocks until new message, auto-marks as read
2. process message(s)
3. $AC send target 'response'     → reply
4. goto 1
```

No cron, no webhook. Only on explicit request.

## Multi-Agent Quick Ref

```bash
# Send task
COMM_USER=builder $AC send reviewer "PR #42 ready for review"

# Wait for work
COMM_USER=reviewer $AC poll --timeout 120

# Reply
COMM_USER=reviewer $AC send builder "PR #42 approved"
```

## Dev vs Prod

- **PROD**: Docker on port 3420, DB at `~/.agent-comm/agent-comm.db`. Never touch without "deploy to prod".
- **DEV**: `npm run dev` locally on 3421, DB at `./data/agent-comm.db`.
- Deploy: `docker compose up -d --build`
