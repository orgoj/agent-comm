# agent-comm

## Architecture

Layered architecture with explicit dependency injection (no global state):

```
src/
  domain/     agents, channels, messages, state, feed, cleanup, rate-limit, events
  storage/    SQLite (better-sqlite3, WAL mode)
  transport/  REST (node:http), WebSocket (ws), MCP (stdio)
  ui/         Vanilla JS dashboard (no build step for UI)
```

- **No frameworks** — no React, Vue, Express. Pure Node.js + TypeScript.
- `context.ts` is the DI root — wires all services together.
- UI files (`index.html`, `app.js`, `styles.css`) are plain files copied to `dist/ui/` on build.

## UI / Dashboard

- **Icons**: Material Symbols Outlined (via Google Fonts CSS). No emojis.
- **Fonts**: Inter (UI text), JetBrains Mono (code/data)
- **Theme**: Light/dark toggle via `.theme-light` / `.theme-dark` class on `<body>`
- **Design tokens**: CSS custom properties (`--bg`, `--accent`, `--border`, `--shadow-*`, etc.)
- **Accent color**: `#5d8da8`
- **Radii**: 12px cards, 16px panels, 8px small elements
- **Section headers**: Uppercase, 13px, weight 600, letter-spacing 0.5px
- **Empty states**: Material Symbols icon (block, centered) + text + optional hint

## Code Style

- ESLint + Prettier enforced via lint-staged (husky pre-commit)

## Versioning

- Version lives in `package.json` and is read at runtime (REST `/health`, WS state payload, UI sidebar)
- Never hardcode version strings
- **Bump the version only on release** — ordinary commits leave `package.json` untouched
- Commit message format (regular commits): short imperative subject, e.g. `fix: …`, `docs: …`, `feat: …`
- Commit message format (release): `v1.x.y: short description` with the matching `package.json` bump in the same commit

## Build & Test

```
npm run build      # tsc + copy UI files to dist/
npm test           # vitest (unit + integration + e2e)
npm run check      # typecheck + lint + format + test
npm run dev        # watch mode (tsc + nodemon)
```

## Key APIs

- **REST**: `GET /health`, `GET /api/agents`, `GET /api/messages`, `GET /api/channels`, `GET /api/state`, `GET /api/feed`, `POST /api/cleanup/stale`, `POST /api/cleanup/full`, `POST /api/cleanup/feed` (feed event purge), `DELETE /api/agents/offline` (purge >1hr offline), `POST /api/state/:ns/:key/cas` (atomic compare-and-swap, used by the file-coord hook). Write endpoints are rate-limited (token bucket: 10 burst, 1/sec per agent).
- **WebSocket**: Full state on connect, incremental events streamed (including `channel:member_joined`/`channel:member_left`), `refresh` request supported
- **MCP**: 7 tools (`comm_register`, `comm_agents`, `comm_send`, `comm_inbox`, `comm_poll`, `comm_channel`, `comm_state`). `comm_inbox` accepts an `importance` filter; `comm_poll` blocks on `message:sent` until a matching message arrives (or timeout). Full-text search (FTS5) is available via REST (`GET /api/messages/search`) for the dashboard's human-facing search bar — agents use `comm_inbox` with filters instead. Activity feed is auto-emitted internally on all actions (no MCP tool needed).

## Hooks (system-layer enforcement)

`scripts/hooks/` ships several hook scripts:

- **Enforcing** (active, exit 2 blocks): `file-coord.mjs` (lock-or-fail on Edit/Write), `bash-guard.mjs` (blocks `git commit -am` that would clobber another session's WIP). Both bench-validated.
- **Lifecycle**: `session-start.js` (dashboard URL + workspace announce), `check-registration.js`, `on-stop.js`, `workspace-awareness.mjs` (facts-only workspace context).
- **Optional**: `check-inbox.js` — advisory PostToolUse nudge for unread messages. Not default-installed; opt-in only. Prefer `comm_poll` with `importance` filter in the agent's prompt for peer-sent urgent signals.

Key coordination hook:

- **`file-coord.mjs`** (`PreToolUse` + `PostToolUse` on `Edit|Write|MultiEdit`) — claims a per-file lock via `POST /api/state/file-locks/<path>/cas` before any edit, releases on PostToolUse, records the edit in the `files-edited` world-model namespace. Default identity = `hostname-ppid` (stable per Claude session), overridable via `AGENT_COMM_ID`. Fail-open if dashboard is down. **This is the empirically validated coordination primitive — bench measured 56% cheaper, 37% faster, deterministic vs naive parallel multi-agent on shared files.**

The hook is host-agnostic — the same `file-coord.mjs` script works for any client that can shell out to a Node process around tool calls (Claude Code, OpenCode, custom MCP clients). See `docs/SETUP.md` for per-host installation.

## Bench

`bench/` contains a real measurement harness (not synthetic) that validates shared-file coordination via the file-coord hook and the `bash-guard` block on cross-session `git commit -am`. See `bench/README.md` for tiers, scenarios, and methodology.

## CLI Messaging Principles (PRD.md is source of truth)

- **Read-marking principle (inviolable)**: A message is marked read **only when fully displayed** to the agent. No command may mark messages read that the agent hasn't seen. `watch` never marks read (one-line notifications). `ask` marks only the matched reply, not the entire inbox batch.
- **Watch/Ask/Poll coexistence**: Watch holds flock. Poll shares the same flock (mutually exclusive with watch). Ask uses NO flock — inbox-check loop — so it works alongside a running watch.
- **Watch uses `?unread=true`** intentionally. If agent already read a message, watch won't report it — correct, agent already knows. No `since_id` needed.
- **Watch startup guard**: refuses start if unread > `--max-unread` (default 50). Agent must clear inbox first.
- **Watch heartbeats** every cycle to stay online.
- **`ask` reply matching uses UUID** (not agent name) and only matches messages sent after the ask (`created_at` check).
- **Server startup**: `resetOnStartup()` marks agents with heartbeat >2min old as offline. When `OFFLINE_TIMEOUT=0`, previously-offline agents are reactivated first, then stale ones are reset.

## Agent Integration Principles

- **Identity setup is per-agent, one-time**: Human provides agent name + server URL → agent saves to `~/.agent-comm/config.sh` → `source` on every session. No need to re-explain each time.
- **Config variables**: `AC` (path to CLI), `COMM_USER` (agent name), `COMM_HOST` (server, default `localhost:3420`).
- **Hermes uses `ac poll` loop** (not `ac watch` — broken `_reader_loop`, not webhooks — no session context). Background poll with `--timeout 1800`, retry on timeout (exit 1 = no message, normal).
- **Webhooks use `X-Hub-Signature-256` header** (Hermes-compatible, GitHub-style). Secret is generated by Hermes via `hermes webhook subscribe`, not by agent-comm.
- **Webhook payload includes agent names** (`from_agent_name`, `to_agent_name`) alongside UUIDs for readability in prompt templates.
- **`ac poll` CLI loops internally** past the 60s server cap, so `--timeout 1800` works correctly.
