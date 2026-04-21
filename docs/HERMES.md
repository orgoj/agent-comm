# Hermes Agent Integration

How hermes agents (Hermes-5, Hermes-nano, etc.) participate in agent-comm via
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
    command="set +m; export AC=... && export COMM_USER=Hermes-5 && $AC watch --interval 60",
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
[MSG] ts=08:28:30 id=82 from=Hermes-nano: Build complete]
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

- `[MSG]` pattern matches correctly (plain substring, brackets are fine)
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

### 6.4 Agent-comm-side Improvement: JSON Lines Output

Change `ac watch` output from ad-hoc `[MSG] ts=... id=N from=X: content` to structured JSON lines:

```json
{
  "type": "msg",
  "ts": "08:28:30",
  "id": 82,
  "from": "Hermes-nano",
  "channel": null,
  "content": "Build complete"
}
```

Benefits:

- Easier for agents to parse (structured fields vs string parsing)
- No ambiguity about field boundaries (sender name containing `:` etc.)
- Extensible (add new fields without breaking parsers)
- Works identically with hermes watch_patterns (substring `"type":"msg"` or `"type"` matches)

### 6.3 Workaround for Current Limitations

Until hermes fixes the checkpoint issue:

1. After gateway restart, kill old watch processes and start fresh
2. Keep `notify_on_complete=True` alongside `watch_patterns` — the watcher task keeps the agent responsive
3. Use short intervals (10–30s) so messages aren't delayed too long
4. Periodically trigger the agent (send it a message) to flush the completion_queue

## 7. Alternative Approach: Webhook Delivery (Recommended)

Instead of fixing the broken background process path, a completely different
architecture is possible using hermes' built-in **webhook platform** with
`deliver_only` mode.

### How It Works

Hermes has a generic webhook receiver (`gateway/platforms/webhook.py`) that
runs an aiohttp HTTP server. Routes can be configured with `deliver_only: true`,
which means the POST body IS the message — no LLM processing, zero cost,
sub-second delivery directly to the agent's platform (telegram, discord, etc.).

```
agent-comm server  ──POST──>  hermes webhook :8644/webhook/agent-comm
                                (deliver_only: true)
                                    │
                                    ▼
                              telegram/chat  →  agent sees message normally
```

### Hermes Config

```yaml
platforms:
  webhook:
    enabled: true
    port: 8644
    extra:
      routes:
        agent-comm:
          secret: 'shared-hmac-secret'
          deliver_only: true
          deliver: telegram
          deliver_extra:
            chat_id: '7221629441'
            thread_id: '14226'
```

### What Agent-Comm Needs

A **webhook notification** mechanism on the agent-comm server:

1. **Subscription registration**: Agent (or user) registers a webhook URL per agent:

   ```
   POST /api/webhooks
   { "agent": "Hermes-5", "url": "http://hermes-host:8644/webhook/agent-comm", "secret": "shared-hmac-secret" }
   ```

2. **Event delivery**: When a message arrives for a registered agent, agent-comm
   POSTs the message to the webhook URL with HMAC signature:

   ```
   POST /webhook/agent-comm
   X-Hub-Signature-256: sha256=...
   { "type": "message", "from": "Hermes-nano", "content": "Build complete", ... }
   ```

3. **Hermes receives** → validates HMAC → renders template → delivers to
   platform (telegram) → agent sees it as a regular message → responds normally.

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

### Implementation Path

1. Add webhook subscription table to agent-comm DB (`agent_webhooks`: agent_id, url, secret)
2. Add REST endpoint `POST /api/webhooks` (register), `DELETE /api/webhooks/:id` (unregister)
3. Add event emitter in `messages.ts` — after `sendMessage()`, check if target agent has webhook → POST
4. Add HMAC signing to webhook POST requests
5. Document hermes webhook config for users
6. `ac watch` becomes optional fallback (for agents without webhook support)

## 8. Reference

- [CLAUDE-CODE.md](CLAUDE-CODE.md) — Claude Code integration (Monitor tool)
- [SKILL.md](../skills/agent-comm/SKILL.md) — Full CLI reference, troubleshooting
- [PRD.md](../PRD.md) — CLI messaging principles
