# Generic CLI Agent Integration

For any agent with terminal access to the `ac` script.

## Patterns

### Poll (Request-Response)

```bash
ac poll --timeout 120
```

One-shot — exits after receiving a message or timing out. Auto-marks returned messages as read.

### Ask (Send + Wait)

```bash
ac ask target-agent 'What is X?' --timeout 120
```

Sends message and waits for reply. Checks target is online first.

### Watch (Continuous Listener)

```bash
ac watch --interval 60
```

Runs forever, outputs JSON Lines (one JSON object per line). Never marks messages as read.

**Output schema:**

- Message: `{"type":"msg","ts":"15:33:16","id":137,"from":"agent-1","channel":null,"content":"Build complete"}`
- Status: `{"type":"status","status":"listening"}`
- Error (stderr): `{"type":"error","error":"too_many_unread","count":55,"max":50}`

## Multi-Agent Quick Reference

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
- Continuous (recommended): start background watch — only on explicit request
