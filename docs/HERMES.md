# Hermes Agent Integration

How hermes agents participate in agent-comm via
`ac watch` — background process, watch patterns, notification delivery pipeline,
and known issues.

## TL;DR

| Step | Component             | What happens                                                                                                            |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | Hermes LLM            | Calls `terminal(background=True, watch_patterns=["[MSG]"], notify_on_complete=True, command="$AC watch --interval 60")` |
| 2    | `terminal_tool.py`    | Creates `ProcessSession`, sets `watch_patterns` + routing metadata                                                      |
| 3    | `process_registry.py` | `_reader_loop` reads stdout chunks, calls `_check_watch_patterns`                                                       |
| 4    | `process_registry.py` | Match found → puts `{type: "watch_match", ...}` into `completion_queue`                                                 |
| 5    | `gateway/run.py`      | After agent turn ends, drains `completion_queue`                                                                        |
| 6    | `gateway/run.py`      | `_inject_watch_notification` → creates synthetic `[SYSTEM:]` message                                                    |
| 7    | Gateway adapter       | Delivers to agent's conversation as an inbound message                                                                  |

## 1. Process Lifecycle

### Spawning (terminal_tool.py)

When the hermes agent's LLM decides to start `ac watch`, it calls:

```python
terminal_tool(
    command="set +m; export AC=... && export COMM_USER=my-agent && $AC watch --interval 60",
    background=True,
    watch_patterns=["[MSG]"],
    notify_on_complete=True,
)
```

Key code paths in `terminal_tool.py`:

- **Lines 1629–1641**: If `background=True` AND (`notify_on_complete` OR `watch_patterns`), reads routing metadata from gateway session env vars (`HERMES_SESSION_PLATFORM`, `HERMES_SESSION_CHAT_ID`, etc.) and stores them on `proc_session` (`watcher_platform`, `watcher_chat_id`, `watcher_thread_id`, etc.).
- **Lines 1644–1663**: If `notify_on_complete=True`, creates a per-process watcher task (`pending_watchers`) that polls every 5s for process exit.
- **Lines 1666–1668**: Sets `proc_session.watch_patterns = list(watch_patterns)` on the session.

### Stdout Reading (process_registry.py)

Three reader types depending on backend:

| Backend        | Reader                        | How it reads                                  |
| -------------- | ----------------------------- | --------------------------------------------- |
| Local (Popen)  | `_reader_loop` (line 503)     | `session.process.stdout.read(4096)` in a loop |
| Docker/sandbox | `_env_poller_loop` (line 531) | `cat` log file every 2s, computes delta       |
| PTY            | `_pty_reader_loop` (line 584) | `pty.read(4096)`                              |

All three call `self._check_watch_patterns(session, chunk_or_delta)` on new output.

### Watch Pattern Matching (process_registry.py, line 162)

```python
def _check_watch_patterns(self, session: ProcessSession, new_text: str):
    if not session.watch_patterns or session._watch_disabled:
        return
    for line in new_text.splitlines():
        for pat in session.watch_patterns:
            if pat in line:        # ← plain substring, NOT regex
                matched_lines.append(line)
```

- Simple `pat in line` substring check. No regex. Brackets `[MSG]` are fine.
- Rate-limited: max `WATCH_MAX_PER_WINDOW` per `WATCH_WINDOW_SECONDS`.
- Sustained overload → `watch_disabled` event + permanent kill for that process.

On match, puts into `completion_queue`:

```python
self.completion_queue.put({
    "type": "watch_match",
    "pattern": matched_pattern,
    "output": output,           # matched lines (up to 20, 2000 chars)
    "session_id": session.id,
    "session_key": session.session_key,
    "command": session.command,
    "platform": session.watcher_platform,
    "chat_id": session.watcher_chat_id,
    "user_id": session.watcher_user_id,
    "user_name": session.watcher_user_name,
    "thread_id": session.watcher_thread_id,
})
```

## 2. Notification Delivery Pipeline

### Queue Drain (gateway/run.py, line 4537)

After each agent turn completes, the gateway drains the `completion_queue`:

```python
while not _pr.completion_queue.empty():
    evt = _pr.completion_queue.get_nowait()
    if evt_type in ("watch_match", "watch_disabled"):
        _watch_events.append(evt)
for evt in _watch_events:
    synth_text = _format_gateway_process_notification(evt)
    await self._inject_watch_notification(synth_text, evt)
```

### Notification Formatting (gateway/run.py, line 596)

`_format_gateway_process_notification` converts the event to:

```
[SYSTEM: Background process proc_abc123 matched watch pattern "[MSG]".
Command: $AC watch --interval 60
Matched output:
[MSG] ts=08:28:30 id=82 from=other-agent: Build complete]
```

### Injection (gateway/run.py, line 8275)

`_inject_watch_notification` builds a routing source from the event metadata:

```python
source = self._build_process_event_source(evt)
if not source:
    logger.warning("Dropping watch notification with no routing metadata for process %s", ...)
    return
```

If routing metadata is missing (empty `platform`), the notification is **silently dropped**. This is the guard that causes failures after gateway restarts.

If routing is present, it creates a synthetic `MessageEvent(internal=True)` and calls `adapter.handle_message(synth_event)`, which injects it into the agent's conversation as an inbound message.

## 3. Root Cause — Two Bugs, Both Critical

Evidence from hermes session `session_20260421_152835_7eab66ec.json` (April 21, 2026).

### Bug #1: `_reader_loop` Doesn't Read stdout (PRIMARY)

**Severity**: CRITICAL — background `ac watch` produces zero visible output

**Evidence**:

| Message | Time       | What                                                                                                                         |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [12]    | Start      | `ac watch` started in background, `watch_patterns: ["[MSG]"]`                                                                |
| [22]    | +65 min    | `process poll` → `output_preview: ""` — reader thread has accumulated **ZERO bytes** in 65 minutes                           |
| [28]    | Kill       | Agent kills the process                                                                                                      |
| [31]    | After kill | Watch notification arrives: `matched watch pattern "[MSG]"` with `Matched output: [MSG] ts=15:33:16 id=137 from=human: test` |

**What this means**: The `_reader_loop` thread (process_registry.py:503) is running but `proc.stdout.read(4096)` returns nothing for 65 minutes. The `ac watch` process IS writing to stdout (data was there — it came through on kill). The data sits in the OS pipe buffer unread.

When the process is killed:

1. SIGTERM → process exits → pipe closes
2. `_reader_loop` gets EOF on next `read()` but first reads the remaining buffered data
3. `_check_watch_patterns` matches `[MSG]`
4. Event queued in `completion_queue`
5. Drain loop delivers it as `[SYSTEM:]` notification

**Why foreground works but background doesn't**:

- **Foreground**: `env.execute(command)` — output returned directly as tool result
- **Background**: `subprocess.Popen([shell, "-lic", "set +m; {command}"], stdout=PIPE)` → `_reader_loop` reads from pipe — **but doesn't receive data**

**Suspected cause** (root-caused by comparing foreground vs background Popen setup):

| Aspect     | Foreground (works)               | Background (broken)                      |
| ---------- | -------------------------------- | ---------------------------------------- |
| Shell args | `bash -c cmd`                    | `bash -lic "set +m; cmd"`                |
| stdin      | `DEVNULL` (or `PIPE` with data)  | `PIPE` (always open, nobody writes)      |
| Drain      | `select()` + `os.read(fd, 4096)` | `proc.stdout.read(4096)` (TextIOWrapper) |
| Source:    | `local.py:258` + `base.py:467`   | `process_registry.py:389,503`            |

**Root cause #1 — `bash -lic`**: The `-i` flag forces interactive mode, sourcing `~/.bashrc`. Interactive initialization may interfere with stdin/stdout when both are pipes. Foreground uses `bash -c` (no `.bashrc` sourcing). Any `.bashrc` content that touches readline, terminal settings, or stdin could disrupt the pipe.

**Root cause #2 — TextIOWrapper buffering**: The background `_reader_loop` uses `proc.stdout.read(4096)` which goes through Python's `TextIOWrapper → BufferedReader → FileIO` stack. The foreground drain (added in commit `f336ae3d` specifically to fix pipe drain issues) uses `select()` + `os.read(fd, 4096)` directly — bypassing Python's IO buffering entirely. This is the proven pattern; the background path should use the same approach.

**Verification needed**: Reproduce by spawning the same Popen command via both drain methods and comparing results.

### Bug #2: Completion Queue Drain Only After Agent Turns (SECONDARY)

**Severity**: HIGH — even if Bug #1 is fixed, notifications won't arrive for idle agents

Watch events in `completion_queue` are only drained **after the agent completes a turn** (gateway/run.py:4537–4554). If no one is chatting with the agent, the queue never drains.

The `_run_process_watcher` asyncio task (run.py:8314) runs every 5 seconds and monitors background processes, but it **only checks for process completion** — it does NOT drain `completion_queue` for watch_pattern events. Since `ac watch` runs forever (never exits), the watcher task never triggers a notification.

### Why It Worked on April 19–20

The gateway logs show successful watch injections during that period. This worked because someone was chatting with the hermes agent via telegram — each message triggered an agent turn, and after each turn the drain loop flushed the queue. The notifications weren't proactive; they were a side effect of active conversation.

### Fixes Required (Both in Hermes)

**Fix #1** (for Bug #1): Investigate why `_reader_loop` doesn't read from Popen stdout. Possible approaches:

- Test with `bufsize=0` on Popen (unbuffered binary mode) + manual decode
- Use `os.read(proc.stdout.fileno(), 4096)` instead of `proc.stdout.read(4096)` to bypass Python's TextIOWrapper buffering
- Check if `bash -lic` vs `bash -c` makes a difference

**Fix #2** (for Bug #2): The `_run_process_watcher` asyncio task should also drain `completion_queue` and inject watch_pattern notifications, not just wait for process completion. Something like:

```python
# In _run_process_watcher's while loop, before checking session.exited:
if agent_notify:
    try:
        while not process_registry.completion_queue.empty():
            evt = process_registry.completion_queue.get_nowait()
            if evt.get("type") in ("watch_match", "watch_disabled"):
                synth_text = _format_gateway_process_notification(evt)
                if synth_text:
                    await self._inject_watch_notification(synth_text, evt)
    except Exception:
        pass
```

### 3.2 Stale Checkpoint — watch_patterns Lost on Gateway Restart

**Severity**: High (causes silent failures)

`terminal_tool.py` calls `_write_checkpoint()` at the end of `spawn_local()` (line ~498). But the caller sets `watch_patterns` and routing metadata on the `ProcessSession` AFTER spawn returns (line ~1429 in gateway/run.py). So the checkpoint snapshot is always stale — missing `watch_patterns` and routing metadata.

After a gateway restart, `process_registry.recover_from_checkpoint()` restores processes but WITHOUT `watch_patterns`. The `_reader_loop` resumes reading stdout but `_check_watch_patterns` returns immediately because `session.watch_patterns` is empty.

**Symptom**: After gateway restart, `ac watch` keeps running (process survived), output is captured in `output_buffer`, but no notifications are delivered.

**Fix**: Kill the old watch process and start a fresh one in the new gateway session so routing metadata and watch_patterns are properly captured.

### 3.3 Routing Metadata Loss After Gateway Restart

**Severity**: High (causes silent drops)

Even if `watch_patterns` were somehow preserved, `_build_process_event_source` requires `platform`, `chat_id`, `thread_id` from the gateway session — these are transient env vars set only during the agent's turn. After restart, there's no way to recover them for existing processes.

The `_inject_watch_notification` guard at line 8282 drops events with `if not source: return`. No error visible to the user — only a `logger.warning`.

### 3.4 processes.json Not a Reliable Diagnostic

`~/.hermes/processes.json` is written at spawn time (before watch_patterns are set). Checking `cat ~/.hermes/processes.json | jq '.[0].watch_patterns'` will show `[]` even when in-memory patterns are correct. The only reliable check is whether notifications actually fire.

## 4. What Works

From gateway logs (April 19–20, 2026):

```
2026-04-20 09:12:05,692 INFO gateway.run: Watch pattern notification — injecting for telegram chat=7221629441 thread=14226
2026-04-20 09:12:05,843 INFO gateway.run: inbound message: ... msg='[SYSTEM: Background process proc_8363d02b5c0b matched watch pattern "[MSG]". Com'
```

When the pipeline is working (fresh gateway session, properly spawned watch):

- Pattern matches correctly (plain substring, brackets are fine)
  - **Note:** These logs show the old `[MSG]` format. Current agent-comm uses JSON Lines, so watch patterns should match `"type":"msg"`
- Routing metadata is set from gateway session env vars
- Notifications are injected as `[SYSTEM:]` messages
- Zero "Dropping watch" warnings in logs

## 5. Key Code Locations (hermes-agent repo)

| File                         | Lines     | What                                         |
| ---------------------------- | --------- | -------------------------------------------- |
| `tools/terminal_tool.py`     | 1341      | `watch_patterns` parameter                   |
| `tools/terminal_tool.py`     | 1629–1641 | Routing metadata from gateway env vars       |
| `tools/terminal_tool.py`     | 1644–1663 | `notify_on_complete` watcher setup           |
| `tools/terminal_tool.py`     | 1666–1668 | `watch_patterns` set on ProcessSession       |
| `tools/process_registry.py`  | 105       | `ProcessSession.watch_patterns` field        |
| `tools/process_registry.py`  | 162–250   | `_check_watch_patterns` — matching + queue   |
| `tools/process_registry.py`  | 503–529   | `_reader_loop` — local Popen stdout reader   |
| `tools/process_registry.py`  | 531–582   | `_env_poller_loop` — sandbox log file reader |
| `tools/process_registry.py`  | 584–609   | `_pty_reader_loop` — PTY reader              |
| `gateway/run.py`             | 596–620   | `_format_gateway_process_notification`       |
| `gateway/run.py`             | 4537–4554 | Post-turn drain of `completion_queue`        |
| `gateway/run.py`             | 8253–8273 | `_build_process_event_source`                |
| `gateway/run.py`             | 8275–8312 | `_inject_watch_notification` — the guard     |
| `gateway/session_context.py` | 32–36     | `HERMES_SESSION_PLATFORM` env var            |

## 6. Recommendations

### 6.1 Hermes-side Fix: Use select()+os.read() in \_reader_loop

The `_reader_loop` in `process_registry.py:503` should be rewritten to use the same `select()` + `os.read(fd, 4096)` + incremental UTF-8 decoder pattern that the foreground drain already uses (`base.py:467`, added in commit `f336ae3d`). This is the proven pattern for live pipe reading.

The background `_reader_loop` was originally designed for batch output (read everything at process completion). `watch_patterns` was bolted on later assuming live streaming, but the underlying read mechanism was never updated. The foreground drain got fixed (`f336ae3d`), the background drain did not.

Additionally, consider changing the shell invocation from `bash -lic` to `bash -lc` (drop `-i`) to avoid `.bashrc` interference with piped stdin/stdout.

### 6.2 Hermes-side Fix: Persistent Watch Patterns

The checkpoint should be updated to include `watch_patterns` and routing metadata. The simplest fix: move the `_write_checkpoint()` call to AFTER watch_patterns and routing metadata are set on the session, so the checkpoint captures the full state.

### 6.3 Hermes-side Fix: Proactive Queue Drain

The `_run_process_watcher` asyncio task should also drain `completion_queue` for watch_pattern events, not just wait for process completion. See Bug #2 fix in section 3.

### 6.4 Agent-comm JSON Lines Output (Implemented)

`ac watch` now outputs structured JSON Lines instead of ad-hoc `[MSG] ts=...` format:

**Message:**

```json
{
  "type": "msg",
  "ts": "15:33:16",
  "id": 137,
  "from": "human",
  "channel": null,
  "content": "Build complete..."
}
```

**Status events:**

```json
{"type":"status","status":"started","agent":"my-agent","interval":60}
{"type":"status","status":"listening"}
```

**Error (stderr):**

```json
{ "type": "error", "error": "too_many_unread", "count": 6, "max": 5 }
```

Benefits:

- Easier for agents to parse (structured fields vs string parsing)
- No ambiguity about field boundaries (sender name containing `:` etc.)
- Extensible (add new fields without breaking parsers)
- Works with hermes watch_patterns (substring `"type":"msg"` or `"type"` matches)

**Watch patterns** should now match `"type":"msg"` instead of `[MSG]`. Content is truncated to first line, max 100 chars with `…` suffix on overflow.

### 6.3 Workaround for Current Limitations

Until hermes fixes the checkpoint issue:

1. After gateway restart, kill old watch processes and start fresh
2. Keep `notify_on_complete=True` alongside `watch_patterns` — the watcher task keeps the agent responsive
3. Use short intervals (10–30s) so messages aren't delayed too long
4. Periodically trigger the agent (send it a message) to flush the completion_queue

## 7. Recommended: ac poll Loop

Since `ac watch` is broken (`_reader_loop` bug, section 3) and webhooks can't target
a specific Hermes CLI session (section 8), the practical default is **`ac poll` in a loop**.

### How It Works

Hermes agent runs `ac poll --timeout 1800` as a background process:

1. `ac poll` blocks until a message arrives (or 30min timeout)
2. Returns message as JSON, auto-marks as read, process exits
3. Hermes `notify_on_complete=True` fires → agent gets the message in current session
4. Agent decides what to do, then runs `ac poll` again

### Why This Works

- **Short-lived processes**: Each poll is a new process — no `_reader_loop` buffering bug
- **Session context**: Message arrives in the active Hermes CLI session, agent can respond
- **Multi-repo**: Each Hermes CLI instance polls for its own agent name
- **Zero LLM cost**: Poll is notification only, agent decides when to spend tokens
- **Simple**: No gateway, no subscriptions, no webhooks — just `ac poll`

### Implementation

```python
terminal(background=True, notify_on_complete=True,
         command='source ~/.agent-comm/config.sh && $AC poll --timeout 1800')
```

Agent re-runs this after each message or timeout. The exit code is 1 on timeout (no message) — agent should retry.

### Limitations

- Latency depends on when agent re-runs poll (not truly real-time)
- Each poll auto-marks returned messages as read
- One poll at a time (fcntl flock prevents concurrent poll/watch)

## 7.1. Webhook Delivery (Alternative)

Uses Hermes' built-in **webhook platform** with dynamic subscriptions and `deliver_only` mode.
Best for monitoring/alerting where the agent doesn't need to respond in session.

### How It Works

Hermes has a generic webhook receiver (`gateway/platforms/webhook.py`) that
runs an aiohttp HTTP server. Dynamic subscriptions are created via
`hermes webhook subscribe` and stored in `~/.hermes/webhook_subscriptions.json`.
Routes with `deliver_only: true` deliver the POST body directly — no LLM
processing, zero cost, sub-second delivery.

```
agent-comm server  ──POST──>  hermes webhook :8644/webhooks/<subscription-name>
                                (deliver_only: true)
                                    │
                                    ▼
                              telegram/chat  →  agent sees message normally
```

### Setup

**1. Enable webhook platform** in `~/.hermes/config.yaml`:

```yaml
display:
  platforms:
    webhook:
      enabled: true
      extra:
        host: '0.0.0.0'
        port: 8644
        secret: '<strong-global-secret>'
```

Start gateway: `hermes gateway run`

**2. Create dynamic subscription** (Hermes generates the secret):

```bash
hermes webhook subscribe agent-comm-<YOUR_AGENT_NAME> \
  --deliver telegram \
  --deliver-chat-id "7221629441" \
  --deliver-only \
  --prompt "Message from {data.from_agent_name}: {data.content}"
```

Returns URL (`http://localhost:8644/webhooks/agent-comm-hermes-5`) and secret.

**3. Register with agent-comm** (pass Hermes-provided secret):

```bash
$AC webhook register <URL_FROM_STEP_2> --secret <SECRET_FROM_STEP_2>
```

### What Agent-Comm Sends

Agent-comm POSTs to the registered URL with:

- Header `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA256 signature)
- Header `X-GitHub-Event: message:sent` (event type)
- JSON body:

```json
{
  "event": "message:sent",
  "timestamp": "2026-04-21T12:00:00.000Z",
  "data": {
    "id": 42,
    "from_agent": "agent-uuid",
    "from_agent_name": "agent-1",
    "to_agent": "recipient-uuid",
    "to_agent_name": "agent-2",
    "channel_id": null,
    "content": "message text",
    "importance": "normal",
    "created_at": "2026-04-21T12:00:00.000Z"
  }
}
```

Prompt templates use dot-notation: `{data.from_agent_name}`, `{data.content}`, `{data.importance}`.

### Hermes Signature Validation

Hermes webhook adapter (`gateway/platforms/webhook.py:559-588`) checks 3 headers:

- `X-Hub-Signature-256: sha256=<hex>` — GitHub-style (used by agent-comm)
- `X-Gitlab-Token: <plain secret>` — GitLab-style
- `X-Webhook-Signature: <hex>` — generic

Agent-comm uses `X-Hub-Signature-256` + `X-GitHub-Event: message:sent`.

### Advantages Over `ac watch`

| Aspect                 | `ac watch` (background)              | Webhook delivery            |
| ---------------------- | ------------------------------------ | --------------------------- |
| Latency                | Never works (broken reader)          | Sub-second                  |
| LLM cost               | Requires agent turn                  | Zero (deliver_only)         |
| Background process     | Yes (breaks)                         | No                          |
| Complexity             | Python CLI + flock + state files     | HTTP POST + HMAC            |
| Reliability            | Depends on broken `_reader_loop`     | Proven webhook platform     |
| Multi-agent            | One watch per agent, flock conflicts | One webhook route per agent |
| Recovery after restart | Broken (stale checkpoint)            | Automatic (stateless HTTP)  |

### Other Hermes Mechanisms Considered

| Mechanism                   | Verdict                                        |
| --------------------------- | ---------------------------------------------- |
| **Webhook platform**        | Best fit — real-time, zero cost, proven        |
| **Cron jobs**               | Polling every 60s, not real-time               |
| **Hooks**                   | Event listening only, can't inject messages    |
| **Custom platform adapter** | Overkill, webhook already does this            |
| **MCP**                     | Would need custom MCP server with push support |
| **Skills**                  | Passive instructions, no event handling        |

### Implementation Status

Webhook delivery is implemented. See `src/domain/webhook.ts` (WebhookService) and `skills/agent-comm/references/hermes.md` for the agent-facing guide.

## 8. Target Session Routing (Design Goal)

The current webhook and `ac watch` approaches are suboptimal for the primary use case:

**Goal:** Multiple Hermes CLI instances, each in a different project directory with a unique chat name, coordinating work across repos. Agents (Hermes, Claude, others) communicate via agent-comm and coordinate in real time.

### Why Webhooks Aren't Enough

| Mode             | Cost                     | Session                            | Limitation                                                |
| ---------------- | ------------------------ | ---------------------------------- | --------------------------------------------------------- |
| `--deliver-only` | Zero LLM                 | None — push to telegram            | Agent can't respond, no session context                   |
| Regular webhook  | LLM tokens               | New `webhook:{route}:{id}` session | No existing session context, each POST = new conversation |
| `ac watch`       | Zero (notification only) | **Current CLI session**            | **BROKEN** — `_reader_loop` bug (see section 3)           |

### What's Needed

The primary path should deliver notifications into the **specific Hermes CLI session** that's working on that project — same as how Claude Code uses the Monitor tool with `ac watch`. The notification arrives as a `[SYSTEM:]` message in the active conversation, and the agent decides whether to act on it.

This requires fixing the Hermes background process `_reader_loop` (section 3) so that `ac watch` works reliably for long-running background processes — the same pattern Claude Code uses successfully.

### TODO: Fix Hermes Background Tool Watch Match

The `_reader_loop` in `process_registry.py:503` must be rewritten to use `select()` + `os.read(fd, 4096)` instead of `proc.stdout.read(4096)` (TextIOWrapper buffering). The foreground drain in `base.py:467` already uses this pattern successfully. Additionally:

1. **Fix `_reader_loop`**: Use `select()` + `os.read()` to bypass Python's IO buffering (same as foreground drain)
2. **Fix checkpoint persistence**: Move `_write_checkpoint()` call to AFTER `watch_patterns` and routing metadata are set
3. **Fix proactive queue drain**: `_run_process_watcher` should drain `completion_queue` for watch_pattern events, not just process completion
4. **Consider dropping `-i` flag**: Change `bash -lic` to `bash -lc` to avoid `.bashrc` interference with piped I/O

Until this is fixed, webhooks remain the working alternative for Hermes agents that need notifications.

### Multi-Agent Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Hermes CLI  │     │ Claude Code │     │ Hermes CLI  │
│ repo: A     │     │ repo: A     │     │ repo: B     │
│ chat: dev-A │     │ user: ac-dev│     │ chat: dev-B │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │  agent-comm REST API + WebSocket      │
       └───────────────────┼───────────────────┘
                           │
                    ┌──────┴──────┐
                    │ agent-comm  │
                    │ server      │
                    └─────────────┘
```

Each agent registers with its project-specific identity. Messages are routed by agent name. Coordination happens through direct messages and shared channels.

## 9. Reference

- [CLAUDE-CODE.md](CLAUDE-CODE.md) — Claude Code integration (Monitor tool)
- [SKILL.md](../skills/agent-comm/SKILL.md) — Full CLI reference, troubleshooting
- [PRD.md](../PRD.md) — CLI messaging principles
