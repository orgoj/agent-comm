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

# agent-comm — Inter-Agent Communication

## Setup & Config

**Location**: `ac` lives in the skill directory: `~/.hermes/skills/agent-comm/scripts/ac`

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

**Setup**:

```bash
export COMM_USER=my-agent-name   # Required for most commands
# Config read from ~/.agent-comm/config.sh (COMM_HOST, COMM_PORT)
# Use --auto-register to skip manual registration:
$AC --auto-register send target 'hello'
```

**Roles**:

- **`human`** — the human operator (Michael). NOT an agent. Has full authority over all agents. Visible in `ac agents` as status "online" when the web dashboard is open.
- **Agents** — AI instances (Hermes-5, Hermes-nano, etc.). Each has its own `COMM_USER`.

## CLI Reference

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

### Webhooks

```bash
$AC webhook register http://example.com/hook [--secret MY_SECRET]
$AC webhook list
$AC webhook delete
```

## Key Behaviors

- **Auto-heartbeat**: Read commands (agents, inbox, discover) auto-send heartbeat.
- **Auto-mark read**: `$AC poll`, `$AC inbox`, `$AC thread` automatically mark returned messages as read. Next poll won't return them again.
- **Poll loop**: Backend caps at 60s. The CLI loops in 55s chunks internally, so `--timeout 3600` waits up to 1h without backend changes. No hard upper limit.
- **Server-side double cap**: REST layer (`rest.ts`) and domain layer (`messages.ts pollInbox`) both cap poll timeout independently. The domain cap `Math.min(timeoutMs, 60_000)` is the actual bottleneck. To increase beyond 60s, BOTH must be changed.
- **Poll timeout expiry**: Returns stderr `"Error: poll timed out after Ns with no messages.\n  This is normal — start a new poll to keep waiting."` + exit code 1. Agent knows it waited and nothing came — not silent `[]`.
- **JSON-safe**: All content properly encoded. Quotes, backslashes, newlines safe.
- **Config**: `~/.agent-comm/config.sh` = COMM_HOST + COMM_PORT only. Never put agent names there.
- **Identity**: `COMM_USER` env var = agent name. Multiple agents = different COMM_USER.
- **Threading**: `$AC send --thread ID`, `$AC thread ID` for full thread.
- **Ask (send+wait)**: Checks target is online, sends message, polls until target replies or timeout. Fails immediately if target is offline or not registered.
- **Auto-register**: `$AC --auto-register <cmd>` registers before first command. Idempotent.

### Poll Lock (fcntl.flock)

The `ac poll` and `ac watch` commands use **`fcntl.flock()`** on `~/.agent-comm/locks/<name>.poll.lock`:

- **Atomic at kernel level** — no TOCTOU race, no two processes can acquire simultaneously
- **Auto-released on any process death** — even SIGKILL, segfault, power loss
- **`try/finally` + signal handlers**: Normal return releases via `finally`, signals release via handler + `os._exit(0)`
- **No `atexit` needed** — flock is released when FD is closed (happens automatically on death)

**Why `os._exit(0)` in signal handler**: `sys.exit` raises `SystemExit` which Python handles asynchronously. If the process is inside C code (urllib socket read), there's a window where the lock is released but the process hasn't died yet. `os._exit(0)` terminates immediately.

**NEVER manually delete lock files** (`rm ~/.agent-comm/locks/*.poll.lock`). The flock is released automatically on any process death — kernel guarantees this. Kill the process instead.

Error message example:

```
Error: agent Hermes-5 already has an active poll (PID 762125).
  Fix: wait for it, or kill it
```

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

### Anti-Patterns

**0. Running `ac inbox --unread` on a remote agent for debugging:**

```bash
# BROKEN — marks ALL returned messages as read, breaks watch
ssh nano 'COMM_USER=Hermes-nano $AC inbox --unread'
```

`ac inbox` calls `_mark_read_msgs()` internally. After this, `ac watch` (which uses `unread=true`) sees 0 messages because they're all read.

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

| Test                                                   | Result | Notes                                           |
| ------------------------------------------------------ | ------ | ----------------------------------------------- |
| Basic poll-receive-reply                               | PASS   | 17s round-trip                                  |
| Timeout recovery (poll → timeout → new poll → message) | PASS   | After killing stale while-loop process          |
| Burst 3 messages in one poll                           | PASS   | All 3 delivered in single batch                 |
| Concurrent polls (while-loop + manual poll)            | FAIL   | Race condition, messages lost to auto-mark-read |
| Poll lock: block second poll                           | PASS   | Clear error + fix suggestion                    |
| Poll lock: --force override                            | PASS   | Takes over cleanly                              |
| Poll lock: auto-cleanup on process death               | PASS   | atexit + signal handlers                        |
| Stress: 17x23=391 via real message round-trip          | PASS   | Full chain: send → poll → process → reply       |
| Watch pattern on single poll (Hermes-5)                | PASS   | Immediate notification on message arrival       |
| Watch pattern on single poll (Hermes-nano)             | PASS   | sqrt(144)=12, watch + notify_on_complete        |
| Watch: continuous [MSG] output (Hermes-5)              | PASS   | One-line format, watch_patterns=["[MSG]"]       |
| Watch: never marks read, last_seen_id dedup            | PASS   | Startup dump + incremental tracking             |
| Lock: os.\_exit(1) prevents race on kill               | PASS   | No in-flight request leakage after signal       |
| 600s poll timeout cap                                  | PASS   | Full 120s poll without cutoff (Hermes-nano)     |

## Per-Agent Integration Guides

### Generic CLI Agent

For any agent with terminal access:

- **poll** for request-response: `ac poll --timeout 120`
- **ask** for send+wait: `ac ask target 'question'`
- **watch** for continuous listening: `ac watch --interval 60`

Multi-agent quick ref:

```bash
# Send task
COMM_USER=builder $AC send reviewer "PR #42 ready for review"

# Wait for work
COMM_USER=reviewer $AC poll --timeout 120

# Reply
COMM_USER=reviewer $AC send builder "PR #42 approved"
```

When Michael says "Listen" or "Communicate":

- One-shot: `$AC poll --timeout 300` in foreground.
- Continuous (recommended): start background watch — no cron, no webhook. Only on explicit request.

### Claude Code

When running under Claude Code:

- **Always use Monitor tool for watch** (never plain background bash)
- Canonical invocation with `grep --line-buffered`:

```
Monitor(
  description="<AgentName> inbox",
  persistent=true,
  timeout_ms=3600000,
  command="COMM_USER=<AgentName> $AC watch --interval 10 2>&1 | grep --line-buffered '^\\[MSG\\]'"
)
```

- Stop with `TaskStop`, never `kill`
- Identity in `.claude/CLAUDE.md` (e.g. `My agent-comm name for this repo: ac-developer`)
- Full guide: see docs/CLAUDE-CODE.md

### Hermes Agent

**Recommended: Webhook delivery** (sub-second, zero LLM cost, no background process):

Step 1 — Register the webhook with agent-comm:

```bash
# Tell agent-comm where to POST when your agent receives a message
COMM_USER=my-agent $AC webhook register http://hermes-host:8080/api/webhooks/my-agent
# Secret is auto-generated and printed to stderr — save it for verification
```

Step 2 — Configure Hermes to accept the POST. In your agent's startup (Python):

```python
# In your agent's setup, create a webhook endpoint that Hermes will call
# when agent-comm posts a notification. Example using Hermes webhook platform:
webhook_config = {
    "url": "http://agent-comm-host:3420",  # not used for inbound, but identifies source
    "secret": "THE_SECRET_FROM_STEP_1",
    "mode": "deliver_only",  # POST body IS the notification, no LLM processing
}
```

**How it works**: When agent-comm receives a message for your agent, it POSTs a signed JSON payload to the URL from step 1. The payload:

```json
{
  "event": "message:sent",
  "timestamp": "...",
  "data": { "id": 42, "from_agent": "...", "content": "...", "importance": "normal" }
}
```

**Verify signatures**: Each POST includes `X-Agent-Comm-Signature: sha256=<hex>` header. Verify: `HMAC-SHA256(secret, requestBody) == hex_value`.

Advantages over `ac watch`:

| Aspect                 | `ac watch` (background)   | Webhook delivery           |
| ---------------------- | ------------------------- | -------------------------- |
| Latency                | Broken `_reader_loop`     | Sub-second                 |
| LLM cost               | Requires agent turn       | Zero (deliver_only)        |
| Background process     | Yes (breaks)              | No                         |
| Reliability            | Depends on broken pipe    | Proven webhook platform    |
| Recovery after restart | Broken (stale checkpoint) | Automatic (stateless HTTP) |

**Legacy: ac watch** (works but background process required):

```python
terminal(background=True, notify_on_complete=True,
         watch_patterns=["[MSG]"],
         command='$AC watch --interval 60')
```

- `watch_patterns=["[MSG]"]` triggers notification on message arrival
- `notify_on_complete=True` is safety net (fires if process dies unexpectedly)
- One process, one lock — poll lock prevents duplicate watchers
- Process never exits — runs until killed or session ends
- **Note**: `_reader_loop` in hermes background mode is broken for long-running processes. Webhook delivery is the recommended alternative.

## Dev vs Prod

- **PROD**: Docker on port 3420, DB at `~/.agent-comm/agent-comm.db`. Never touch without "deploy to prod".
- **DEV**: `npm run dev` locally on 3421, DB at `./data/agent-comm.db`.
- Deploy: `docker compose up -d --build`
