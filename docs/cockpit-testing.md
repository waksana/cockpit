# cockpit — testing, performance & security

How cockpit is tested, its measured performance baseline, and a review of its
security posture. Commands run from the repo root unless noted.

For the deployed modernization's conclusions and remaining limits, see the
[2026-09-08 final review](./review/2026-09-08-foundation.md).

## Test suites

| Layer | What | Run |
| --- | --- | --- |
| **Unit (core)** | fold (event→message tree, live==replay), `prefs`, `mcp-config` | `pnpm --filter @cockpit/core test` |
| **Unit (server)** | `uploads` (save/serve, path-traversal, mime, name safety) | `pnpm --filter @cockpit/server test` |
| **Unit (MCP)** | API client, tool boundaries, file exchange | `pnpm --filter @cockpit/mcp test` |
| **Unit (web)** | acknowledged sends/drafts, reconnect windows, local diagnostics and image URLs | `pnpm --filter @cockpit/web test` |
| **All workspaces** | every workspace's unit-test script, plus launcher/restart helpers | `pnpm test` |
| **Build** | workspace compilation, including the web app's actual TypeScript sources | `pnpm build` |
| **Real-log regression** | fold every persisted `events.jsonl`, validate each message vs the protocol schema | `pnpm regress` |
| **E2E** | drives the running backend over HTTP (health/status, intent validation, upload roundtrip + traversal, session create/delete, MCP/skill intents, upload XSS headers) | `pnpm e2e` |
| **Perf** | fold throughput, endpoint latency, upload/serve MB/s, concurrent SSE | `pnpm perf` |

Unit tests use `node:test` + `tsx` (no extra framework). Use isolated fixtures and
mock transports for the foundation's governance-free boot, API/MCP coverage,
cross-session interaction, file exchange and reconnect behavior. Do not use a
personal session store or restart the running service for ordinary unit tests.
Test files are
`*.test.ts` next to the code; they're excluded from the `tsc` builds. E2E and perf
are plain Node scripts in `scripts/` that hit `127.0.0.1:8771` (non-destructive:
they create + delete one throwaway session and a throwaway upload).

Do not run deployment-facing E2E/performance scripts against a personal service
as ordinary unit checks. Native SDK probes use a separate configuration/state
root, a synthetic workspace and a controlled model endpoint. Confirm the actual
runtime data path and child process before creating fixture sessions.

Semantic acceptance compares the supported native operations' actual outcomes:
ordered messages and queues, pending decisions, effective model/configuration,
filesystem effects and failures. GUI formatting can differ. The intentional
always-approve permission policy is not default interactive CLI equivalence.

Resource acceptance distinguishes the API process, Copilot runtime and MCP
children. Repeated load/release cycles must release the actual SDK-owned session,
not only Cockpit's reference. Passive history queries must start no runtime, emit
no viewer-specific SSE pages and leave other devices' scrollback unchanged.

## Historical performance baseline

Measured on an earlier deployment (`pnpm perf`, single-user box); not a
modernization acceptance threshold or evidence of bounded runtime ownership:

- **Fold throughput** — ~490k events/sec. The largest real session (35.7k events)
  replays in ~70ms. Fold runs on every session load; at this rate even a
  100k-event session loads in <250ms. Not a bottleneck.
- **Endpoint latency** — `/health` p99 ~2.5ms, `/status` p99 ~1.3ms. The
  graceful-restart poller and any UI status polling are effectively free.
- **Upload / serve** — 1MB: ~10ms up / ~12ms serve; 5MB: ~12ms up / ~77ms serve
  (~65–400 MB/s loopback).
- **Concurrent SSE** — 50 simultaneous clients all receive their first snapshot
  within ~123ms. For a single-user console this is far beyond need.

These historical measurements do not establish current production capacity or
bounded memory. The old materialized-session cap and heap watchdog no longer
exist. Native SDK idle cleanup is set to 30 minutes; history caching has separate
budgets, and uploaded files/persisted history remain operator-managed disk usage.

## Security posture

Cockpit is a **single-operator** console. The authenticated gateway is the remote
access boundary; native tools run with the service account's authority.

### Boundary & authN
- Backend binds **127.0.0.1 only**; all external access is via nginx with
  the deployed **passkey-gate authentication**.
- The current gateway protects the whole proxied surface, including
  `/admin/restart`, `/status`, `/events`, `/intent/*`, uploads and the SPA.
  Operational routes are not loopback-only merely because the API binds loopback.
- Origin/Referer checks protect browser mutations against CSRF; they are not
  authentication. Do not expose the backend through an unauthenticated tunnel.

### Hardening in place
1. **Path traversal** — `resolveUpload` rejects any name containing `/`, `\`, or
   `..`, and only serves plain basenames inside the upload dir. Unit + e2e tested.
2. **Stored filenames** — generated as `<ts>-<rand><ext>`; no user-controlled
   characters reach the filesystem. The display name is preserved separately and
   only ever rendered as text.
3. **Upload XSS** — served with `X-Content-Type-Options: nosniff` and
   `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'`. A
   navigated SVG/HTML upload runs script-less; inline `<img>` rendering is
   unaffected. (Fix applied after this review found SVG was served as
   `image/svg+xml`, a stored-XSS vector.)
4. **Intent validation** — every intent body and result is schema-validated;
   unknown intents return 404.
5. **Per-file size limit** — 25 MiB (backend) / `25m` (nginx).

### Accepted risks (by design, single-operator)
- **YOLO tool execution** — the agent auto-approves every tool (bash/edit/…). Anyone
  authorized through the gateway can control tools as the service account. This
  is explicit product policy, not multi-user isolation. Protect gateway sessions,
  server credentials and operator-authored MCP/skills accordingly.

### Residual gaps (low priority for single-user; worth noting)
6. **Upload storage has no total quota or retention policy.** Monitor disk usage;
   do not introduce automatic deletion without an explicit retention requirement.
7. **No multi-tenant authorization boundary.** Hardening must not be mistaken for
   safety against an already authorized operator or malicious installed tools.
8. **No malware/content scanning** on uploads — outside this single-operator scope.

### Not applicable
- **CORS** — all client calls are same-origin; no cross-origin access is granted.
- **Untrusted MCP installation is not isolated** — server configuration is
  operator-authored. This is an explicit trust assumption, not a blanket SSRF
  immunity claim.

## Diagnostics / known findings

### Graceful restart and interrupted work

The backend waits for active work and native callbacks to settle, then awaits
native shutdown and pending notification deliveries before closing transport.
Confirmed native process death instead causes a nonzero exit for supervisor
recovery. Neither case blindly replays an uncertain submitted prompt.

The imported MCP reader previously depended on a lossy SDK `turns` table and its
own local event-log fold. The foundation reader now calls `session/peek`: both
clients use the backend's canonical transcript, with no local SQL fallback.
See [`apps/mcp/README.md`](../apps/mcp/README.md) for message-cursor pagination.

When changing restart or transcript handling, use an isolated backend fixture to
compare API/MCP messages with the same history projected to the web client.
Browser disconnection must not affect execution. Restarting the process remains
a separate operation: it must wait for idle and must not be described as preserving
an in-flight turn.
