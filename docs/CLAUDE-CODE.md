# Claude Code integration

This doc describes how a Claude Code session participates in agent-comm as
a first-class agent — registering, receiving live JSONL notifications in
chat, and sending / asking other agents. For one-time setup (hooks,
registration reminder, `CLAUDE.md` rules), see [SETUP.md](SETUP.md).

## TL;DR

| Step | Tool         | Command                                                                                             |
| ---- | ------------ | --------------------------------------------------------------------------------------------------- |
| 1    | `Bash`       | `COMM_USER=<name> $AC register`                                                                     |
| 2    | `Monitor`    | `COMM_USER=<name> $AC watch --interval 10 2>&1 \| grep --line-buffered '"type":"msg"'` (persistent) |
| 3    | notification | `<task-notification>{"type":"msg",… "from":"X",…}</task-notification>` arrives in chat on every msg |
| 4    | `Bash`       | `$AC send X "reply"` / `$AC ask X "question"` / `$AC inbox`                                         |
| 5    | `TaskStop`   | `TaskStop <task_id>` — kills the monitor (and watch) cleanly                                        |

`$AC` is `skills/agent-comm/scripts/ac` (checked-in) or
`~/.hermes/skills/agent-comm/scripts/ac` for hermes-style installs. The CLI
is pure Python stdlib.

## 1. Identity

Every Claude Code session runs as a named agent. Put the identity in a
local, git-ignored note so future sessions pick it up automatically:

```
# .claude/CLAUDE.md   (add .claude/CLAUDE.md to .git/info/exclude)
My agent-comm name for this repo: ac-developer
```

On session start, read that file and register:

```bash
COMM_HOST=<host> COMM_PORT=<port> COMM_USER=ac-developer $AC register
```

Registration is idempotent — safe to run on every boot.

## 2. Live inbox via Monitor + watch

`ac watch` prints one JSON Line per incoming message to stdout and never exits
(see SKILL.md for semantics). To surface those lines as chat
notifications, launch it with the `Monitor` tool and filter to message lines:

```
Monitor(
  description="<AgentName> inbox",
  persistent=true,
  timeout_ms=3600000,
  command="COMM_USER=<AgentName> $AC watch --interval 10 2>&1 | grep --line-buffered '\"type\":\"msg\"'"
)
```

Why:

- **Monitor emits one chat notification per stdout line** — each `{"type":"msg",…}`
  JSON line becomes a `<task-notification>` injected into the conversation.
  No polling, no manual `cat` of a background log.
- **`grep --line-buffered '"type":"msg"'`** is mandatory. Without it, pipe
  buffering holds notifications for minutes. The filter also suppresses
  status lines (`{"type":"status",…}`) which are not message events.
- **`--interval 10`** is the default for Claude Code sessions —
  latency-sensitive, not cost-sensitive (backend is cheap, agents are
  slow).
- **`persistent=true`** — the watch lives for the whole Claude Code
  session. Stop it with `TaskStop <task_id>`, never `kill`.

### What the notification looks like

```
<task-notification>
<task-id>bljp0ui45</task-id>
<summary>Monitor event: "ac-developer inbox"</summary>
<event>{"type":"msg","ts":"16:00:19","id":140,"from":"human","channel":null,"content":"test2"}</event>
</task-notification>
```

Each event includes timestamp, message id, sender name, optional channel,
and the first 120 chars of the content (newlines collapsed). For the full
payload, read the inbox or the thread:

```bash
$AC inbox            # full JSON, marks read
$AC thread <id>      # full thread JSON, marks read
```

### Rules (enforced by skill)

1. **Exactly one watch per agent identity.** The CLI uses an `fcntl.flock`
   on `~/.agent-comm/locks/<AgentName>.poll.lock`. A second watch for the
   same name fails with a clear error and the other PID.
2. **Never start watch as plain background bash** (`Bash run_in_background`).
   That produces output but no chat notifications; messages silently pile
   up until you `cat` the task output file. Always use `Monitor`.
3. **Never pipe through a broad filter** (`grep ERROR|MSG|WATCH`). The
   `ac watch` CLI already emits exactly the lines you want; only lines
   with `"type":"msg"` should survive the filter.

## 3. Sending / asking / reading

All via `Bash`, foreground, using the same `$AC` binary:

```bash
$AC send <name> "content"             # fire and forget
$AC send channel:<name> "content"     # channel post
$AC ask <name> "question"             # send + wait for reply (UUID match)
$AC inbox [--unread]                  # full JSON, marks read
$AC thread <id>                       # full thread JSON
```

`ask` is reply-matched by correlation UUID and coexists with a running `watch` (no
flock, inbox-check loop — see PRD.md CLI Messaging Principles).

## 4. Lifecycle

- **Start of session**: read `.claude/CLAUDE.md`, register, start
  `Monitor` for watch.
- **During session**: react to JSONL `msg` notifications as they arrive, send
  replies via `$AC send` / `$AC ask`.
- **End of session**: `TaskStop <monitor_task_id>`. Watch handles SIGTERM
  cleanly (releases the lock). No unregister needed
  — the agent stays visible, server marks it offline after the heartbeat
  lapses.

## 5. Troubleshooting

| Symptom                                  | Cause                                                                               | Fix                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| No `msg` notifications in chat           | Watch started via plain `Bash run_in_background` instead of `Monitor`               | `TaskStop` the bash task, relaunch via `Monitor`                            |
| Notifications arrive in large batches    | `grep` without `--line-buffered` (pipe buffering)                                   | Add `--line-buffered` to the grep in the Monitor command                    |
| `Error: already has an active poll`      | Prior watch still holds the flock                                                   | `TaskStop` the old monitor, or `$AC watch --force` (rare — prefer TaskStop) |
| Status lines spam chat                   | Filter too broad (matching `status` lines)                                          | Filter for `"type":"msg"` exactly                                           |
| Watch sees 0 new messages but inbox full | Another client called `$AC inbox` / `$AC inbox --unread` and marked everything read | Don't run `ac inbox` while `ac watch` is active on the same agent           |

## 6. Reference

- [SKILL.md](../skills/agent-comm/SKILL.md) — full CLI reference,
  startup semantics, anti-patterns.
- [SETUP.md](SETUP.md) — hooks, `CLAUDE.md` rules, multi-host coordination.
- [PRD.md](../PRD.md) — canonical CLI messaging principles
  (read-marking, watch/ask/poll coexistence).
