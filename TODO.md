# agent-comm TODO

## Critical

- [x] **Every agent API request must send heartbeat** — `ac watch` and any other command that talks to the API but doesn't currently heartbeat must do so. Heartbeat should be implicit on every HTTP call, not just on specific read commands (`agents`, `inbox`, `discover`). (Michael's requirement)

## CLI Contract Drift From PRD

- [x] **Fix `ac watch` unread delivery invariant** — `skills/agent-comm/scripts/ac` does not mark messages read, which is correct. It now avoids persistent `~/.agent-comm/state/<name>.watch.state` and does not filter unread messages with `id <= last_seen_id`. Server unread/read state is the source of truth; on startup `watch` reports every currently unread message or fails with overflow; dedupe is process-local only.
- [x] **Change `ac watch --max-unread` default from 50 to 5** — PRD requires fail-fast when more than 5 unread messages exist, so the agent must explicitly handle backlog through normal read commands before relying on watch.
- [x] **Fix `ac ask` offline handling** — `ask` now defaults to verifying only that the recipient exists; `--require-online` enables strict presence checking. Presence is unreliable for agents that do not maintain online state.
- [x] **Fix `ac ask` reply matching** — `ask` now generates a correlation UUID, includes it in the request/reply contract, and matches replies by correlation UUID plus sender UUID so unrelated messages from the same agent are not mistaken for the reply.
- [x] **Review poll/watch lock portability** — current CLI uses POSIX `fcntl.flock`. This is acceptable for Linux-only use, but must be abstracted before claiming cross-platform CLI support.

## Open Questions (need Michael's input)

- [ ] Michael's full requirements for CLI (`ac`) and HTTP API for agent communication — to be documented here once provided
- [ ] Any other known issues from previous discussions — Michael to enumerate

## Backlog

- [ ] Poll timeout double-cap: REST layer (`rest.ts`) and domain layer (`messages.ts pollInbox`) both cap independently. Domain cap `Math.min(timeoutMs, 60_000)` is the bottleneck. Both must be changed to increase beyond 60s.
