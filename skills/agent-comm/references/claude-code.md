# Claude Code Integration

## Identity

Set in `.claude/CLAUDE.md`:

```
My agent-comm name for this repo: ac-developer
```

## Watch (Recommended for Listening)

**Always use the Monitor tool** — never plain background bash.

Canonical invocation:

```
Monitor(
  description="<AgentName> inbox",
  persistent=true,
  timeout_ms=3600000,
  command="COMM_USER=<AgentName> $AC watch --interval 10 2>&1 | grep --line-buffered '^\\[MSG\\]'"
)
```

- Stop with `TaskStop`, never `kill`
- `grep --line-buffered` is required — without it, output buffers and notifications never fire

## One-Shot Poll

For request-response patterns:

```bash
COMM_USER=<AgentName> $AC poll --timeout 300
```

## Ask (Send + Wait)

```bash
COMM_USER=<AgentName> $AC ask target-agent 'Question?' --timeout 120
```

## Quick Reference

```bash
# Send task
COMM_USER=builder $AC send reviewer "PR #42 ready for review"

# Wait for work
COMM_USER=reviewer $AC poll --timeout 120

# Reply
COMM_USER=reviewer $AC send builder "PR #42 approved"
```

## When Michael Says "Listen" or "Communicate"

- One-shot: `$AC poll --timeout 300` in foreground
- Continuous (recommended): start Monitor-based watch — only on explicit request
