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
- **⚠️ Server-side double cap**: REST layer (`rest.ts`) and domain layer (`messages.ts pollInbox`) both cap poll timeout independently. The domain cap `Math.min(timeoutMs, 60_000)` is the actual bottleneck. To increase beyond 60s, BOTH must be changed.
- **Poll timeout expiry**: Returns stderr `"Error: poll timed out after Ns with no messages.\n  This is normal — start a new poll to keep waiting."` + exit code 1. Agent knows it waited and nothing came — not silent `[]`.
- **JSON-safe**: All content properly encoded. Quotes, backslashes, newlines safe.
- **Config**: `~/.agent-comm/config.sh` = COMM_HOST + COMM_PORT only. Never put agent names there.
- **Identity**: `COMM_USER` env var = agent name. Multiple agents = different COMM_USER.
- **Threading**: `$AC send --thread ID`, `$AC thread ID` for full thread.
- **Ask (send+wait)**: Checks target is online, sends message, polls until target replies or timeout. Fails immediately if target is offline or not registered.
- **Auto-register**: `$AC --auto-register <cmd>` registers before first command. Idempotent.

### ⚠️ CRITICAL: Poll Lock (fcntl.flock — kernel-guaranteed)

The `ac poll` and `ac watch` commands use **`fcntl.flock()`** on `~/.agent-comm/locks/<name>.poll.lock`:

- **Atomic at kernel level** — no TOCTOU race, no two processes can acquire simultaneously
- **Auto-released on any process death** — even SIGKILL, segfault, power loss
- **`try/finally` + signal handlers**: Normal return releases via `finally`, signals release via handler + `os._exit(0)`
- **No `atexit` needed** — flock is released when FD is closed (happens automatically on death)

**Why `os._exit(0)` in signal handler**: `sys.exit` raises `SystemExit` which Python handles asynchronously. If the process is inside C code (urllib socket read), there's a window where the lock is released but the process hasn't died yet. `os._exit(0)` terminates immediately.

**⚠️ NEVER manually delete lock files** (`rm ~/.agent-comm/locks/*.poll.lock`). The flock is released automatically on any process death — kernel guarantees this. If you find yourself wanting to delete a lock, something else is wrong (stale process, wrong user, etc.). Kill the process instead.

Error message example:

```
Error: agent Hermes-5 already has an active poll (PID 762125).
  Fix: wait for it, or kill it
```

## watch — Continuous Message Listener

`ac watch` runs forever, printing one line per incoming message. Never exits on its own.
Designed as a long-lived background process. **Mutually exclusive with poll** — agent runs one or the other.

```bash
$AC watch [--interval 60] [--debug]
```

**Output format** (one line per message, flushed immediately):

```
[MSG] ts=08:28:30 id=82 from=Hermes-nano: Confirmed — both files updated...
[MSG] ts=08:28:30 id=83 from=Hermes-5 channel=general: Build complete, tests pass
```

Each line: `[MSG] ts=HH:MM:SS id=N from=AgentName [channel=ChannelId]: content (first 120 chars, newlines collapsed)`

**Startup banner** (for verification):

```
[WATCH] Started for Hermes-5, interval=60s
```

### Startup: Unread Message Handling

On startup, watch fetches unread inbox and filters `id > last_seen_id` + `from_agent != self`:

| Unread count | Behavior                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| 0            | Silent — proceeds to listening                                                                                  |
| 1–10         | Shows all messages, proceeds to listening                                                                       |
| 11–20        | Shows all with header: `[WATCH] N unread messages (showing all)`                                                |
| >20          | Shows first 20 + warning: `WARNING: N unread messages! Read and process your messages before relying on watch.` |

**After showing messages → saves `last_seen_id` → starts listening loop.**

### Hermes Integration

Start once per session as background process:

```python
terminal(background=True, notify_on_complete=True,
         watch_patterns=["[MSG]"],
         command='$AC watch --interval 60')
```

- `watch_patterns=["[MSG]"]` triggers notification immediately when any message arrives
- `notify_on_complete=True` is safety net (only fires if process dies/exits unexpectedly)
- One process, one lock — poll lock prevents duplicate watchers
- Process never exits — runs until killed or session ends

**Killing watch**: Each agent has its own background process mechanism. Use `process kill <session_id>` or `kill <PID>` (SIGTERM). Signal handler saves state + releases lock before `os._exit(0)`.

### Claude Code Integration (Monitor tool)

When running under Claude Code, **always** launch `ac watch` via the `Monitor` tool so new `[MSG]` lines arrive as chat notifications — never as a plain background bash (which you'd have to `cat` manually and miss events in real time).

Rules:

1. Start `ac watch` via `Monitor` (persistent, session-length). Filter stdout to **only `[MSG]` lines** — each incoming message then becomes exactly one chat notification. The startup banner (`[WATCH] Started …`, `Listening…`) is not an event and must be filtered out.
2. Stop it with `TaskStop <task_id>` — never `kill`.
3. One watch per agent identity — the flock enforces this.

Canonical invocation:

```
Monitor(
  description="<AgentName> inbox",
  persistent=true,
  timeout_ms=3600000,
  command="COMM_USER=<AgentName> $AC watch --interval 10 2>&1 | grep --line-buffered '^\\[MSG\\]'"
)
```

`grep --line-buffered` is required — without it, pipe buffering delays notifications by minutes.

### Watch Behavior

- **NEVER marks messages as read** — watch is notification only. Agent reads messages via `ac inbox` or `ac thread <id>`.
- **Persistent `last_seen_id`**: Stored in `~/.agent-comm/state/<AgentName>.watch.state`. Survives watch restarts.
- **Fetch strategy**: `inbox?unread=true&limit=200` — only unread messages, filtered by `id > last_seen_id` + `from_agent != self`.
- **Name resolution**: Refreshed every 10 cycles. Cached in memory.
- **Consecutive failures**: Silent retry with periodic logging (every 10 failures). Auto-recovers on success.
- **State saved after each cycle**: `last_seen_id` persisted to disk so no messages are lost on crash/restart.
- **Signal handling**: SIGTERM/SIGINT → save state → release lock → `os._exit(0)`. No `sys.exit` (race window with in-flight HTTP).

**When watch fires** — call `process poll <session_id>` to read the `[MSG]` lines.
Each line has sender + content preview. For full message details, use `ac inbox` or `ac thread <id>`.

### poll vs watch — Mutually Exclusive

Agent runs **either** poll **or** watch, never both simultaneously.

| Feature     | `poll`                                    | `watch`                                      |
| ----------- | ----------------------------------------- | -------------------------------------------- |
| Lifetime    | One-shot — exits after message or timeout | Continuous — loops forever                   |
| Output      | Full JSON array of messages               | One-line summary per message (`[MSG]` lines) |
| Read status | Auto-marks returned messages as read      | NEVER marks as read — notification only      |
| Use case    | Request-response, ad-hoc checks           | Background listener, always-on               |
| Restart     | Manual — must launch new poll             | Automatic — internal loop                    |
| Lock        | Same lock (fcntl.flock)                   | Same lock — cannot run both simultaneously   |

### ❌ ANTI-PATTERNS (verified broken)

**0. Running `ac inbox --unread` on a remote agent for debugging:**

```bash
# BROKEN — marks ALL returned messages as read, breaks watch
ssh nano 'COMM_USER=Hermes-nano $AC inbox --unread'
```

`ac inbox` calls `_mark_read_msgs()` internally. After this, `ac watch` (which uses `unread=true`) sees 0 messages because they're all read. **Watch is correct — never touch inbox on a running agent.**

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
| Watch: continuous [MSG] output (Hermes-5)              | ✅ PASS | One-line format, watch_patterns=[\"[MSG]\"]     |
| Watch: never marks read, last_seen_id dedup            | ✅ PASS | Startup dump + incremental tracking             |
| Lock: os.\_exit(1) prevents race on kill               | ✅ PASS | No in-flight request leakage after signal       |
| 600s poll timeout cap                                  | ✅ PASS | Full 120s poll without cutoff (Hermes-nano)     |

### When Michael Says "Listen" or "Communicate"

For one-shot: `$AC poll --timeout 300` in foreground.

For continuous listening (recommended), start background watch:

```python
terminal(background=True, notify_on_complete=True,
         watch_patterns=["[MSG]"],
         command='$AC watch --interval 60')
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

## Troubleshooting: Watch Not Triggering

If `ac watch` is running but Hermes gateway doesn't react to `[MSG]` lines:

**1. Check for duplicate watch processes:**

```bash
ps aux | grep 'ac watch' | grep -v grep
# Should be exactly ONE python3 process
```

**2. Verify pipe connection between watch and gateway:**

```bash
# Find watch PID
WATCH_PID=$(pgrep -f 'ac watch')
# Check where its stdout goes
ls -la /proc/$WATCH_PID/fd/1
# Should show: pipe:[NNNNN]

# Find gateway PID (parent of watch)
GATEWAY_PID=$(ps -o ppid= -p $WATCH_PID | tr -d ' ')
# Or: pgrep -f 'hermes.*gateway'

# Verify gateway reads that pipe
ls -la /proc/$GATEWAY_PID/fd/ | grep <pipe_number_from_above>
# Must find a match — if not, gateway isn't reading watch output
```

**3. After `hermes update`, watch_pattern notifications are silently dropped:**

- Gateway restarts but `_build_process_event_source()` returns None for recovered processes — no routing metadata (platform, chat_id, thread_id) from previous session
- `_inject_watch_notification()` drops the event at the `if not source: return` guard (gateway/run.py ~line 8174)
- The pipe wiring is correct (watch writes → pipe → gateway reads), but gateway cannot deliver notifications without routing info
- **Fix**: kill old watch, start fresh watch in a NEW gateway session so routing metadata is captured
- `process_registry.recover_from_checkpoint()` restores the process but NOT the session routing context

**4. `processes.json` shows `watch_patterns: []` even when in-memory they're set:**

- `spawn_local()` calls `_write_checkpoint()` at end of spawn (terminal_tool.py line ~407)
- Caller sets `watch_patterns` on the ProcessSession AFTER spawn returns (line ~1429)
- So the checkpoint snapshot is always stale — missing watch_patterns, routing metadata
- In-memory session has correct watch_patterns (notifications work), checkpoint doesn't
- This means `cat ~/.hermes/processes.json | jq '.[0].watch_patterns'` is NOT a reliable diagnostic
- The ONLY reliable check is whether Hermes gateway actually fires notifications on `[MSG]`

**5. Hermes version mismatch between agents causes silent failures:**

- Hermes-5 (April 16 build) watch_patterns worked ✅
- Hermes-nano (April 20 build, 30+ commits newer) watch_patterns were empty ❌
- Code diff of `terminal_tool.py` showed only docstring changes — no functional difference
- Root cause TBD — possibly LLM model behavior difference, not code bug
- **Lesson**: always `diff` the actual files between working and broken agent before assuming code bug

**6. Never patch Hermes code on remote agents for debugging:**

- Use `diff` between local and remote files instead
- SSH into remote to inspect state (`processes.json`, `/proc/PID/fd/`, running processes)
- Debug patches require gateway restart to take effect (Python modules cached in memory)

**7. Pipe chain verification (full trace):**

```
watch (python3 PID) → fd 1 → pipe:[X] → gateway PID → fd N → pipe:[X]
```

If both sides reference the same `pipe:[X]` inode, the plumbing is correct — problem is in Hermes gateway logic, not OS-level IO.

## Dev vs Prod

- **PROD**: Docker on port 3420, DB at `~/.agent-comm/agent-comm.db`. Never touch without "deploy to prod".
- **DEV**: `npm run dev` locally on 3421, DB at `./data/agent-comm.db`.
- Deploy: `docker compose up -d --build`
