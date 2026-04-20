# agent-comm TODO

## Critical

- [ ] **Every agent API request must send heartbeat** — `ac watch` and any other command that talks to the API but doesn't currently heartbeat must do so. Heartbeat should be implicit on every HTTP call, not just on specific read commands (`agents`, `inbox`, `discover`). (Michael's requirement)

## Open Questions (need Michael's input)

- [ ] Michael's full requirements for CLI (`ac`) and HTTP API for agent communication — to be documented here once provided
- [ ] Any other known issues from previous discussions — Michael to enumerate

## Backlog

- [ ] Poll timeout double-cap: REST layer (`rest.ts`) and domain layer (`messages.ts pollInbox`) both cap independently. Domain cap `Math.min(timeoutMs, 60_000)` is the bottleneck. Both must be changed to increase beyond 60s.
