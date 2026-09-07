# cockpit — testing, performance & security

How cockpit is tested, its measured performance baseline, and a review of its
security posture. Commands run from the repo root unless noted.

## Test suites

| Layer | What | Run |
| --- | --- | --- |
| **Unit (core)** | fold (event→message tree, live==replay), `prefs`, `mcp-config` | `pnpm --filter @cockpit/core test` |
| **Unit (server)** | `uploads` (save/serve, path-traversal, mime, name safety) | `pnpm --filter @cockpit/server test` |
| **Both** | all unit tests | `pnpm test` |
| **Real-log regression** | fold every persisted `events.jsonl`, validate each message vs the protocol schema | `pnpm regress` |
| **E2E** | drives the running backend over HTTP (health/status, intent validation, upload roundtrip + traversal, session create/delete, MCP/skill intents, upload XSS headers) | `pnpm e2e` |
| **Perf** | fold throughput, endpoint latency, upload/serve MB/s, concurrent SSE | `pnpm perf` |

Unit tests use `node:test` + `tsx` (no extra framework). Test files are
`*.test.ts` next to the code; they're excluded from the `tsc` builds. E2E and perf
are plain Node scripts in `scripts/` that hit `127.0.0.1:8771` (non-destructive:
they create + delete one throwaway session and a throwaway upload).

## Performance baseline

Measured on the deployment host (`pnpm perf`, single-user box):

- **Fold throughput** — ~490k events/sec. The largest real session (35.7k events)
  replays in ~70ms. Fold runs on every session load; at this rate even a
  100k-event session loads in <250ms. Not a bottleneck.
- **Endpoint latency** — `/health` p99 ~2.5ms, `/status` p99 ~1.3ms. The
  graceful-restart poller and any UI status polling are effectively free.
- **Upload / serve** — 1MB: ~10ms up / ~12ms serve; 5MB: ~12ms up / ~77ms serve
  (~65–400 MB/s loopback). nginx caps a single upload at 30MB.
- **Concurrent SSE** — 50 simultaneous clients all receive their first snapshot
  within ~123ms. For a single-user console this is far beyond need.

**Conclusion:** no hot-path concern at the current scale. The only unbounded
resource is the upload folder (see security #6) and resident materialized
sessions (capped at `MAX_MATERIALIZED = 16`).

## Security posture

cockpit is a **single-operator** console. The trust model is: nginx is the
security boundary; everything behind it runs as the operator with full authority.

### Boundary & authN
- Backend binds **127.0.0.1 only**; all external access is via nginx with
  **HTTP Basic auth + a Secure/HttpOnly/SameSite=Lax cookie**.
- `/admin/restart` and `/status` are **NOT proxied by nginx** — reachable only
  from loopback. Good: the restart control isn't remotely triggerable.
- Exposed via nginx: `/events`, `/intent/*`, `/health`, `/upload`, `/uploads/*`,
  `/` — all under the server-level `auth_basic`.

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
4. **Intent validation** — every intent body is zod-parsed; unknown intents 404.
5. **Per-file size limit** — 25MB (backend) / 30MB (nginx).

### Accepted risks (by design, single-operator)
- **YOLO tool execution** — the agent auto-approves every tool (bash/edit/…). Anyone
  who passes nginx auth gets full RCE as the operator. This is the product (an agent
  console), not a bug; the basic-auth + cookie is the only gate, so **the htpasswd
  credential and the cookie value are the crown jewels.**
- **Static bearer cookie** — the auth cookie is a fixed long-lived value set by
  nginx. It's HttpOnly+Secure, but it's a static secret; rotating it requires an
  nginx edit. Acceptable for one user; would not be for multi-user.

### Residual gaps (low priority for single-user; worth noting)
6. **Upload folder is unbounded** — no total-size cap, no eviction, no per-time
   rate limit. A runaway/abused uploader could fill the disk. Mitigation if it ever
   matters: cap total bytes / count and evict oldest.
7. **No CSP on the app document** — the SPA itself sets no `Content-Security-Policy`.
   Low risk (no untrusted HTML is injected; React escapes by default), but a strict
   app-level CSP would be defense-in-depth.
8. **No malware/content scanning** on uploads — out of scope for a personal tool.

### Not applicable
- **CORS** — all client calls are same-origin; no cross-origin access is granted.
- **SSRF via MCP** — MCP servers are operator-authored in `~/.copilot/mcp-config.json`;
  there's no path for a remote party to add one.

## Diagnostics / known findings

### Graceful-restart turn truncation — investigated, restart is safe
Symptom suspected: a turn looked truncated after a graceful self-restart. **Conclusion:
not a UI bug and no live≠replay divergence.** Triple-checked: the session's
`events.jsonl` held the complete turn reply (2326 chars); the SDK's `getEvents()`
returns the in-memory array loaded *from* `events.jsonl` (= the same source cockpit's
UI replays); re-folding the session through cockpit's real fold reproduced the full
reply. The graceful restart is **safe for `events.jsonl`**: `process.exit(0)` fires
only when the session is idle, by which point `assistant.message` + `turn_end` have
been written in order, plus a 500ms SSE-flush grace.

The **real (smaller) issue** is unrelated to restart: `cockpit_read_session` reads the
SDK's `session-store.db` `turns` table, which is **lossy** — `assistant_response` was
`NULL` for ~6/20 turns on the inspected session (some around the restart boundary).
That table is a convenience mirror, not the truth. The authoritative transcript is
`events.jsonl` via the fold (also noted in `apps/mcp/README.md`).

**Verify plan (when next touching restart or read_session):** (1) arm
`/admin/restart`, drive a turn to completion, restart at idle, reload, assert the last
assistant message is byte-complete in the web replay; (2) compare
`cockpit_read_session` output against the folded `events.jsonl` for the same turns and
confirm any divergence is only the known `turns`-table NULLs, never the fold.
