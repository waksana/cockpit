# Module 5 — Server transport

## Summary
The transport is genuinely thin and well-disciplined: every intent body is zod-validated before reaching the Engine, `prompt` is correctly fire-and-forget, the SSE snapshot-then-subscribe sequence has no missed-event race, and the highest-risk area — upload storage/serving — is hardened (random stored names, path-traversal guard, `nosniff` + sandbox CSP) and unit-tested (11/11 pass). The dominant risk is architectural rather than a bug: the server has **zero in-process auth** and trusts nginx completely, while the `/intent/*` surface it exposes includes destructive and RCE-capable operations — so a single nginx misconfiguration or an un-proxied new path equals full host compromise. Secondary issues are SSE backpressure being ignored and a couple of minor info-disclosure points. No Critical defects found in the in-scope code.

## Findings

### [High] Entire route surface trusts nginx for auth; blast radius is total — `apps/server/src/index.ts:22`, `:158`, `:465`
- **What:** The process binds loopback (`HOST = '127.0.0.1'`, `:22`) and performs **no authentication on any route**. `/intent/*` (`:465`) dispatches operations that are destructive or RCE-capable: `session/purge` (permanent delete), `prompt` (drives an agent with full filesystem + yolo permissions), `flow/write-gate` (writes a script to disk — `engine.ts:1469`), `flow/run` (executes a flow/gate), `session/rewind` with `rollbackFiles`, and `fs/listDir` (filesystem enumeration). `/admin/restart` (`:158`) can force a process exit, and `skills/refresh` (`:365-374`) likewise arms a restart.
- **Why it matters:** There is no defense-in-depth. If nginx's auth is ever bypassed/misconfigured, **or** a newly added path is proxied but not placed behind the auth block (the skill explicitly warns new paths aren't auto-guarded), an unauthenticated caller gets full control of the host. The newer ops paths — `/admin/restart`, `/status`, `/upload`, `/uploads/:name` — must each be confirmed present in the nginx cockpit block AND behind auth; `/admin/restart` in particular must never be publicly reachable.
- **Recommendation:** (1) Audit the nginx config so *every* path (`/events`, `/intent/*`, `/upload`, `/uploads/:name`, `/status`, `/admin/restart`, `/health`) is auth-gated, defaulting to deny for unmatched paths. (2) Add a cheap in-server defense-in-depth check — a shared secret header injected by nginx (e.g. `X-Cockpit-Auth`) validated on `/admin/*` and `/intent/*` — so a proxy slip isn't instantly catastrophic. (3) Keep the loopback bind assertion.

### [Medium] SSE fan-out ignores write backpressure — `apps/server/src/index.ts:84-88`
- **What:** `engine.onEvent` writes each frame with `reply.raw.write(frame)` and discards the boolean return value (`:87`); the per-connect keep-alive path (`:177`) and snapshot send (`:39`) do the same. There is no high-water-mark handling.
- **Why it matters:** When a client stalls (e.g. a phone sleeps mid-stream with the TCP socket still half-open), Node buffers all subsequent frames in process memory. During token streaming a single turn can emit a large volume of `msg/upsert` frames, so one stuck client can accumulate unbounded buffered data until the socket finally closes. Single-user/few-devices limits the practical blast radius, but it is an unbounded-memory path with no ceiling.
- **Recommendation:** Honor the `write()` return value (or track `reply.raw.writableLength`) and drop/close a client that falls beyond a threshold; the client already reconnects and re-pulls a fresh snapshot, so disconnecting a slow consumer is safe and self-healing.

### [Low] `/health` discloses the operator's GitHub login — `apps/server/src/index.ts:107`
- **What:** `/health` returns `{ ok: true, login: engine.login }`, where `engine.login` is the authenticated GitHub username (`engine.ts:219`).
- **Why it matters:** Health endpoints are frequently exempted from auth for uptime monitoring. If this one is, it leaks the operator's GitHub identity to anyone who can reach it.
- **Recommendation:** Either keep `/health` behind auth, or strip `login` from the unauthenticated health response and expose identity only on an authenticated route.

### [Low] Intent errors return raw `e.message` to the client — `apps/server/src/index.ts:471-473`
- **What:** On any dispatch failure the handler replies `{ error: e.message }` verbatim.
- **Why it matters:** Engine/SDK errors can embed absolute filesystem paths or internal detail. Behind nginx auth the audience is the trusted operator, so impact is limited, but it is needless internal exposure and pairs badly with the trust-boundary risk above.
- **Recommendation:** Log the full error (already done at `:471`) and return a generic message for non-validation errors; it is fine to surface zod validation messages specifically.

### [Low] `/upload` returns the absolute server path to the browser — `apps/server/src/index.ts:119`, `apps/server/src/uploads.ts:46-54`
- **What:** The upload response includes `path` (the absolute on-disk path under the operator's home dir). The comment frames it as "agent guidance," but it is returned to the web client too.
- **Why it matters:** Minor info disclosure of the home directory / username / storage layout to the browser context.
- **Recommendation:** Only the `url` is needed by the browser; consider omitting `path` from the HTTP response and surfacing it only where an agent actually consumes it.

### [Low] `resolveUpload` traversal guard is a blocklist — `apps/server/src/uploads.ts:62`
- **What:** The guard rejects names containing `/`, `\`, or `..`. This is effective (absolute paths start with `/`; all traversal needs a separator or `..`) and is well covered by tests.
- **Why it matters:** Stored names always match a fixed shape (`<ts>-<rand><ext>`), so an allowlist would be strictly tighter than enumerating bad characters and removes any future-edge-case worry (null bytes, platform-specific separators).
- **Recommendation:** Defense-in-depth only: validate against `^\d+-[0-9a-f]{12}(\.[a-z0-9]{1,12})?$` (or similar) instead of, or in addition to, the blocklist.

### [Low] Served uploads have no `Content-Disposition` — `apps/server/src/index.ts:128-137`
- **What:** Stored uploads are served inline with an extension-derived MIME and no `Content-Disposition`.
- **Why it matters:** This is currently *safe*: the served MIME comes from the extension (not the client-supplied mime), `nosniff` + a sandbox CSP neutralize SVG/script content, and `.html`/`.htm` aren't in the MIME map so they fall through to `application/octet-stream` and download rather than render. The residual is only that a directly-navigated non-image renders inline where forcing a download would be a cleaner belt-and-suspenders posture, and the download filename defaults to the opaque stored name.
- **Recommendation:** Optionally add `Content-Disposition: inline; filename="..."` for images and `attachment; filename="..."` for everything else (sanitize the filename for the header). Not required for security given the existing mitigations.

### Critical
- None found. The two highest-risk surfaces (upload path-traversal and stored-content XSS) are correctly guarded and tested.

## Test coverage assessment
`pnpm --filter @cockpit/server test` runs `uploads.test.ts` only — **11 tests, all passing.** Coverage of `uploads.ts` is strong and security-focused: byte round-trip, image-vs-file kind, stored-name sanitization, control-char stripping in the display name, traversal/absolute-path rejection (including the "file exists outside the dir but the name escapes" case), non-existent-but-well-formed names, streaming, and MIME mapping.
Gaps (no automated coverage): `index.ts` has **none** — the path-traversal guard is exercised at the unit (`resolveUpload`) level but not through the HTTP route, and there are no tests for the served security headers (`nosniff`/CSP `sandbox`), the `/intent/*` 404-for-unknown-name branch (`:467`), intent zod-rejection responses, the SSE snapshot-then-subscribe ordering, or the graceful-restart `busyCount`/`sessionBusy` gate. `push.ts` and `speech.ts` are untested. The header/CSP hardening is load-bearing security with no regression test guarding it — a future edit could silently drop `nosniff` or the sandbox CSP. Adding a thin Fastify `inject()` test over `/uploads/:name` (asserting 404 on traversal and presence of both headers) and over `/intent/<bad>` would lock down the most security-relevant behavior cheaply.

## Positive notes
- **Every intent with a body is zod-validated before the Engine** (`dispatch`, `:182-462`): each `case` calls `Intents[name].body.parse(body)`; bodiless intents (e.g. `session/list`, `mcp/refresh`) correctly skip parsing. The switch is exhaustive with a `never` guard (`:458-460`), and `/intent/*` rejects unknown names before dispatch (`:467`).
- **`prompt` is genuinely fire-and-forget:** the dispatch awaits only `engine.prompt` (`:199`), which itself does `void st.sdk.send(...)` and returns immediately (`engine.ts:828`), with a `.catch` backstop that surfaces turn errors via SSE — exactly the design that avoids nginx 504s.
- **No SSE snapshot race:** `/events` writes the snapshot then adds to `clients` with no `await` between them (`:174-175`), so the single-threaded handler cannot interleave a live event — no missed or duplicated events on (re)connect. Per-connection cleanup is correct: `req.raw.on('close')` clears the keep-alive interval and removes the client (`:178`), so no listener/connection leak.
- **Upload hardening is layered and deliberate:** random non-user-controlled stored names (`uploads.ts:31-34`), 25MB body limit enforced at both the content-type parser and the route (`:29`, `:112`), serving MIME derived from the stored extension rather than the client-supplied mime (defeats content-type confusion), and `nosniff` + sandbox CSP on served content (`:133-134`).
- **Graceful-restart gate is thoughtfully broad:** `sessionBusy` accounts for running turns, pending user choices (ephemeral, unrecoverable), in-flight background sub-agents, and compaction, and is re-checked on any session change (`:67-104`) — the comments correctly justify why a narrow "running→idle" trigger would hang the restart.
- **Secrets stay server-side:** `speech.ts` exchanges the Azure key for a short-lived token and never sends the key to the client; `push.ts` keeps VAPID keys on disk and prunes dead (404/410) subscriptions.

## Cross-cutting (brief — noted, not investigated)
- **nginx config is not in this repo** — the entire trust model depends on it. The High finding can only be *closed* by auditing the actual nginx cockpit block to confirm all paths (especially `/admin/restart`, `/status`, `/upload`, `/uploads/:name`) are proxied **and** auth-gated, with deny-by-default for unmatched paths. Owner of the deploy/nginx module should verify.
- **`engine.prompt` / `engine.login` / `flowReg.writeGate`** live in `@cockpit/core` (Module owning the Engine) — referenced here only to confirm the transport's fire-and-forget and trust-boundary claims; their internals are out of scope for this review.
- **Web Push endpoints (`push.ts:66-78`)** constitute a narrow server-side request surface (the server POSTs to subscriber-provided endpoints). Gated by the same single-user auth, so not raised as a finding; flagged for whoever owns outbound-request policy.
