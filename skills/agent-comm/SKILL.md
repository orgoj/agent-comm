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

**Deploying to remote agents** (e.g. nanobotnb.lan): `scp` both files:

```bash
scp ~/.hermes/skills/agent-comm/scripts/ac nanobotnb.lan:~/.hermes/skills/agent-comm/scripts/ac
scp ~/.hermes/skills/agent-comm/SKILL.md nanobotnb.lan:~/.hermes/skills/agent-comm/SKILL.md
```

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
$AC watch --timeout 300        # Continuous listener, one-line per message, never exits
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
- **Poll timeout expiry**: Returns stderr `"Error: poll timed out after Ns with no messages.\n  This is normal — start a new poll to keep waiting."` + exit code 1. Agent knows it waited and nothing came — not silent `[]`.
- **JSON-safe**: All content properly encoded. Quotes, backslashes, newlines safe.
- **Config**: `~/.agent-comm/config.sh` = COMM_HOST + COMM_PORT only. Never put agent names there.
- **Identity**: `COMM_USER` env var = agent name. Multiple agents = different COMM_USER.
- **Threading**: `$AC send --thread ID`, `$AC thread ID` for full thread.
- **Ask (send+wait)**: Checks target is online, sends message, polls until target replies or timeout. Fails immediately if target is offline or not registered.
- **Auto-register**: `$AC --auto-register <cmd>` registers before first command. Idempotent.

### ⚠️ CRITICAL: Poll Lock (one poll per agent, enforced)

The `ac poll` command uses a **PID-based lock** (`~/.agent-comm/locks/<name>.poll.lock`) to prevent concurrent polls:

- **Concurrent poll blocked** with clear error: agent name, PID of active poll, suggested fixes
- **Stale locks auto-removed**: dead process → lock silently cleaned on next poll attempt
- **Cleanup on exit**: `atexit` + SIGTERM/SIGINT handlers — no orphaned locks on crash or kill
- **Force override**: `$AC poll --force --timeout N` when old poll is truly stuck
- **Lock test results** (verified Hermes-nano): Block ✅, Force override ✅, Auto-cleanup ✅, Normal after cleanup ✅

Error message example:

```
Error: agent Hermes-nano already has an active poll (PID 869507).
  Fix: wait for the current poll to finish, or kill it with 'kill 869507',
  or use: ac poll --force --timeout N
```

## watch — Continuous Message Listener

`ac watch` runs forever, printing one line per incoming message. Never exits on its own.
Designed as a long-lived background process for Hermes agents.

```bash
$AC watch [--timeout 300] [--all] [--force]
```

**Output format** (one line per message, flushed immediately):

```
[MSG] id=82 from=Hermes-nano: Confirmed — both files updated...
[MSG] id=83 from=Hermes-5 channel=general: Build complete, tests pass
```

Each line: `[MSG] id=N from=AgentName [channel=ChannelId]: content (first 120 chars, newlines collapsed)`

**Hermes integration** — start once per session as background process:

```python
terminal(background=True, notify_on_complete=True,
         watch_patterns=["[MSG]"],
         command='$AC watch --timeout 300')
```

- `watch_patterns=["[MSG]"]` triggers notification immediately when any message arrives
- `notify_on_complete=True` is safety net (only fires if process dies/exits unexpectedly)
- One process, one lock — poll lock prevents duplicate watchers
- Process never exits — runs until killed or session ends

**When watch fires** — call `process poll <session_id>` to read the `[MSG]` lines.
Each line has sender + content preview. For full message details, use `ac inbox` or `ac thread <id>`.

### poll vs watch

| Feature  | `poll`                                    | `watch`                        |
| -------- | ----------------------------------------- | ------------------------------ |
| Lifetime | One-shot — exits after message or timeout | Continuous — loops forever     |
| Output   | Full JSON array of messages               | One-line summary per message   |
| Use case | Request-response, ad-hoc checks           | Background listener, always-on |
| Restart  | Manual — must launch new poll             | Automatic — internal loop      |

### ❌ ANTI-PATTERNS (verified broken)

**1. While-true bash loop with poll:**

```bash
# BROKEN — bash buffers output, watch_patterns never triggers
while true; do ac poll --timeout 1800; done
```

Use `ac watch` instead — it handles the loop internally with proper flushing.

**2. Concurrent polls/watch for the same agent:**

```bash
# BROKEN — poll lock prevents this, second one gets blocked
ac watch --timeout 300 &
ac poll --timeout 60
```

### Stress-Test Results

| Test                                                   | Result  | Notes                                           |
| ------------------------------------------------------ | ------- | ----------------------------------------------- |
| Basic poll-receive-reply                               | ✅ PASS | 17s round-trip                                  |
| Timeout recovery (poll → timeout → new poll → message) | ✅ PASS | After killing stale while-loop process          |
| Burst 3 messages in one poll                           | ✅ PASS | All 3 delivered in single batch                 |
| Concurrent polls (while-loop + manual poll)            | ❌ FAIL | Race condition, messages lost to auto-mark-read |
| Poll lock: block second poll                           | ✅ PASS | Clear error + fix suggestion                    |
| Poll lock: --force override                            | ✅ PASS | Takes over cleanly                              |
| Poll lock: auto-cleanup on process death               | ✅ PASS | atexit + signal handlers                        |
| Stress: 17×23=391 via real message round-trip          | ✅ PASS | Full chain: send → poll → process → reply       |
| Watch pattern on single poll (Hermes-5)                | ✅ PASS | Immediate notification on message arrival       |
| Watch pattern on single poll (Hermes-nano)             | ✅ PASS | sqrt(144)=12, watch + notify_on_complete        |

### When Michael Says "Listen" or "Communicate"

For one-shot: `$AC poll --timeout 300` in foreground.

For continuous listening (recommended), start background watch:

```
terminal(background=True, notify_on_complete=True,
         watch_patterns=["[MSG]"],
         command='$AC watch --timeout 300')
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
