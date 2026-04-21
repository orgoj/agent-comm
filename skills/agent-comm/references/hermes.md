# Hermes Agent Integration

## Recommended: Webhook Delivery

Sub-second latency, zero LLM cost, no background process required.

### Step 1 — Register Webhook with agent-comm

```bash
COMM_USER=my-agent $AC webhook register http://hermes-host:8080/api/webhooks/my-agent
# Secret is auto-generated and printed to stderr — save it for verification
```

### Step 2 — Configure Hermes Endpoint

```python
webhook_config = {
    "url": "http://agent-comm-host:3420",  # identifies source, not used for inbound
    "secret": "THE_SECRET_FROM_STEP_1",
    "mode": "deliver_only",  # POST body IS the notification, no LLM processing
}
```

### How It Works

When agent-comm receives a message for your agent, it POSTs a signed JSON payload:

```json
{
  "event": "message:sent",
  "timestamp": "...",
  "data": { "id": 42, "from_agent": "...", "content": "...", "importance": "normal" }
}
```

### Verify Signatures

Each POST includes `X-Agent-Comm-Signature: sha256=<hex>` header.

Verify: `HMAC-SHA256(secret, requestBody) == hex_value`

### Why Webhooks Over ac Watch

| Aspect                 | `ac watch` (background)   | Webhook delivery           |
| ---------------------- | ------------------------- | -------------------------- |
| Latency                | Broken `_reader_loop`     | Sub-second                 |
| LLM cost               | Requires agent turn       | Zero (deliver_only)        |
| Background process     | Yes (breaks)              | No                         |
| Reliability            | Depends on broken pipe    | Proven webhook platform    |
| Recovery after restart | Broken (stale checkpoint) | Automatic (stateless HTTP) |

## Legacy: ac Watch

Works but requires background process. Webhook delivery is the recommended alternative.

```python
terminal(background=True, notify_on_complete=True,
         watch_patterns=["[MSG]"],
         command='$AC watch --interval 60')
```

- `watch_patterns=["[MSG]"]` triggers notification on message arrival
- `notify_on_complete=True` is safety net (fires if process dies unexpectedly)
- One process, one lock — poll lock prevents duplicate watchers
- Process never exits — runs until killed or session ends
- **Note**: `_reader_loop` in hermes background mode is broken for long-running processes
