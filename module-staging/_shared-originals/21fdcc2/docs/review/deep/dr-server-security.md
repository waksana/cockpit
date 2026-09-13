# Deep: Server SSE & trust boundary

Scope: `apps/server/src/{index.ts,push.ts,uploads.ts,speech.ts}` + `uploads.test.ts`,
cross-checked against `packages/core/src/engine.ts` (YOLO permission handler,
`writeGate`, `prompt`) and the cockpit skill `references/runtime.md` (SSE union,
graceful restart, the documented OOM history). Read-only pass: source unchanged.
`pnpm --filter @cockpit/server test` re-run green — **11/11 pass**. Fastify
**5.8.5**, no `@fastify/cors`, no CSRF plugin (verified `package.json` +
`grep -rni cors|origin|csrf src/` → no matches). One throwaway Fastify probe in
`/tmp` (deleted) was used to confirm content-type parsing; **no destructive intent
and no `/admin/restart` was ever sent to the running cockpit**.

## Verdict summary

The first pass is accurate and well-calibrated; nothing in it is refuted. The
trust-boundary High is **CONFIRMED and sharpened** with an exact reachable-intent
inventory (the worst is `prompt` = arbitrary code execution as the operator under
YOLO, not merely "destructive"). The SSE-backpressure Medium is **CONFIRMED and
upgraded in significance**: the buffering is genuinely unbounded *and* it is the
one heap-growth path the documented OOM watchdog cannot see, so it can both OOM
the process and cause collateral eviction of healthy sessions. Upload serving is
**CONFIRMED safe** (headers + traversal guard hold). The material *new* finding the
first pass missed is **CSRF**: because the server has no in-process auth and relies
on nginx cookie auth, a cross-origin `text/plain` form POST (a CORS "simple
request", no preflight) carrying the operator's cookie reaches every **bodiless
side-effecting intent** and `/admin/restart` — empirically confirmed below — giving
an off-path web page a forced-restart / refresh DoS. Body-bearing destructive
intents are incidentally protected (zod rejects the string body; a JSON body would
preflight and the no-CORS server fails it) — which is exactly why a deliberate
defense should not rely on that accident.

---

## Verified findings

### F1 — Trust boundary: zero in-process auth, full-control surface — CONFIRMED (sharpened)

Bind is loopback-only:

> `apps/server/src/index.ts:22` — `const HOST = '127.0.0.1';`
> `:481` — `await app.listen({ host: HOST, port: PORT });`

No route checks identity. `/intent/*` dispatches straight to the Engine after only
a zod **shape** check — there is no principal, token, or origin check anywhere in
`dispatch()` (`:182–462`) or the route wrapper:

> `:465` — `app.post('/intent/*', async (req, reply) => {`
> `:466` — `const name = (req.params as Record<string,string>)['*'] as IntentName;`
> `:467` — `if (!Object.hasOwn(Intents, name)) { reply.code(404); ... }`
> `:469` — `return await dispatch(name, req.body);`

The first pass calls the blast radius "destructive or RCE-capable". Verified
**stronger than RCE-*capable*** — it is **direct arbitrary code execution**: every
session is created with an auto-approve-everything permission handler, so `prompt`
runs shell/file tools with no gate:

> `packages/core/src/engine.ts:328` — `permissionRequestHandler: APPROVE_ALL_PERMISSIONS,`
> `engine.ts:10` (doc) — `// F3  YOLO — auto-approve every permission request.`
> `engine.ts:114` (doc) — `// cockpit runs 100% yolo (the operator is the sole user)...`

So a single unauthenticated `POST /intent/prompt {sessionId,text}` executes
attacker text as the operator with full filesystem + shell. `flow/write-gate`
then `flow/run` is a second, self-contained write-a-script-then-execute path:

> `index.ts:426` — `case 'flow/write-gate': { ... return engine.writeGate(b.name, b.script); }`
> `engine.ts:1469` — `writeGate(name: string, script: string): { ok; path?; error? } { return this.flowReg.writeGate(name, script); }`

**Status:** CONFIRMED. The architectural claim is correct; the severity wording
should read **arbitrary code execution**, not "RCE-ish". Exact inventory in the
next section. Fix in *Recommended fix* (shared-secret header is the proportionate
defense-in-depth; it also closes F4/CSRF for free).

### F2 — SSE fan-out ignores backpressure → unbounded heap — CONFIRMED (upgraded)

The write path discards the `write()` return value in all three places, with no
high-water-mark, drop, or forced disconnect:

> `index.ts:39` — `reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);`   (snapshot via `sseSend`)
> `index.ts:85–88` — `const frame = ...; for (const reply of clients) { try { reply.raw.write(frame); } catch { /* dropped below on close */ } }`
> `index.ts:177` — `const ping = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch {} }, 25000);`

The only teardown is the socket-close event:

> `index.ts:178` — `req.raw.on('close', () => { clearInterval(ping); clients.delete(reply); });`

`reply.raw` is the Node `http.ServerResponse`. `write()` returns `false` once
`writableLength` exceeds `writableHighWaterMark` (default 16 KB) but **keeps
buffering in heap regardless**; buffered bytes are only freed when flushed to the
socket, which stalls indefinitely if the peer's TCP receive window is zero (sleeping
phone, backgrounded tab, lossy link). `'close'` does not fire for a half-open/zombie
socket until a TCP timeout — potentially minutes, or never under a zero-window
stall. The 25 s `: ping` does **not** rescue this: writing the ping onto a stalled
socket also just buffers and never throws, so it neither detects nor bounds growth.

**Why this is more than "single-user, low blast radius":** `references/runtime.md:96–99`
documents that cockpit has **already OOM-aborted once** ("JavaScript heap out of
memory"), and the mitigation is a heap watchdog (`memory.ts`, `runtime.md:109–115`)
that samples `heapUsed` every 15 s and **evicts idle sessions** to recover. That
watchdog cannot see SSE buffers — they are not sessions — so a stalled client's
buffered `msg/upsert` frames (a streaming turn emits a high volume of them)
(a) inflate `heapUsed` invisibly and can trip the watchdog into evicting **healthy
idle sessions** as collateral, and (b) if growth outruns the 15 s sample + 30 s GC
grace, contribute directly to an OOM abort. This is the one heap-growth path the
documented OOM defense structurally does not cover.

**Concrete slow-client sequence:**
1. Phone opens `/events`; server sends snapshot + adds to `clients`.
2. Phone sleeps; TCP socket goes half-open / advertises zero window. No `close`.
3. Operator runs a long streaming turn → hundreds of `msg/upsert` frames fan out.
4. Each `reply.raw.write(frame)` returns `false`; bytes pile in `reply.raw`'s
   writable buffer (heap). Nothing reads the return value; nothing disconnects.
5. `: ping` every 25 s adds more buffered bytes, still no error.
6. `heapUsed` climbs → watchdog evicts innocent idle sessions (collateral) and/or
   the process trends toward the OOM ceiling.

**Fix (precise):** in the fan-out loop, bound per-connection buffering and drop the
slow consumer — safe because the client auto-reconnects (`index.ts:173` sends
`retry: 2000`) and re-pulls a fresh snapshot (no `lastEventId` resume, by design),
so a dropped slow client self-heals.

```ts
// index.ts ~85–88, replace the inner loop body:
const HWM = 8 * 1024 * 1024; // ~8MB per-connection ceiling
for (const reply of clients) {
  const raw = reply.raw;
  if (raw.writableLength > HWM) {        // slow/stalled consumer
    clients.delete(reply);
    raw.destroy();                        // fires 'close' → keep-alive cleared
    continue;
  }
  try { raw.write(frame); } catch { clients.delete(reply); }
}
```
Optionally also `reply.raw.socket?.setTimeout(60_000, () => reply.raw.destroy())`
at `/events` setup so a zombie socket is reaped even between turns. `cork()/uncork()`
is a throughput optimization, not a fix here — the load-bearing change is the
high-water-mark drop.

### F3 — Upload serving headers + traversal guard — CONFIRMED safe

Headers actually set on `GET /uploads/:name`:

> `index.ts:132` — `reply.header('Cache-Control', 'private, max-age=31536000, immutable');`
> `index.ts:133` — `reply.header('X-Content-Type-Options', 'nosniff');`
> `index.ts:134` — `reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");`
> `index.ts:135` — `reply.type(mimeForStored(name));`

The served MIME comes from the **stored extension**, never the client-supplied
`mime` (`uploads.ts:84` `mimeForStored` → `MIME_BY_EXT[...] ?? 'application/octet-stream'`).
Active-content cases are all neutralized:
- `.html`/`.htm` are **not** in `MIME_BY_EXT` (`uploads.ts:78–83`) → served
  `application/octet-stream` + `nosniff` → browsers download, never render.
- `.svg` **is** mapped to `image/svg+xml`, but a directly-navigated SVG is a
  document under `Content-Security-Policy: sandbox` **without** `allow-scripts`, so
  its script never runs; as an `<img>` subresource SVG script never runs anyway.
- `.pdf`/`.json`/`.txt`/`.md` don't execute as HTML.

The attacker *does* control the stored extension within `[^.a-z0-9]`-sanitized,
12-char-capped bounds (`uploads.ts:32`), but no reachable extension yields active
HTML in the cockpit origin given `nosniff` + sandbox. **No stored-XSS.**

Traversal guard:

> `uploads.ts:62` — `if (!storedName || storedName.includes('/') || storedName.includes('\\') || storedName.includes('..')) return null;`
> `uploads.ts:63–68` — `const path = join(UPLOAD_DIR, storedName); if (!existsSync(path)) return null; ... if (!st.isFile()) return null;`

Effective and well-tested: `uploads.test.ts:60–80` locks rejection of `../`,
absolute paths, `sub/dir/file`, `a\b`, `..`, empty, and the "file exists outside the
dir but the name escapes" case. **Status:** CONFIRMED safe. The first pass's two Low
nits stand as optional belt-and-suspenders (allowlist regex; explicit
`Content-Disposition`), not security gaps.

---

## Destructive / admin intent inventory (reachable with no in-process auth)

Every row below is reachable by anyone who can reach the port (loopback today;
the public web origin via nginx for `/intent/*` and `/upload`). Ordered by severity.
Line refs are the `dispatch()` cases in `index.ts`.

| Severity | Intent / route | Effect if the nginx assumption is violated | Ref |
|---|---|---|---|
| **Critical (ACE)** | `prompt` | Executes attacker text as an agent turn under YOLO (`APPROVE_ALL_PERMISSIONS`) — full shell + filesystem as the operator. | `:197` / `engine.ts:328` |
| **Critical (ACE)** | `flow/write-gate` + `flow/run` | Writes an arbitrary script to disk, then executes a flow/gate. Self-contained write-then-run. | `:426`,`:430` / `engine.ts:1469` |
| **Critical (deferred ACE)** | `flow/add`, `flow-schedule/add`, `hook/add`, `schedule/add` | Plant automation that later fires prompts (ACE on a timer/event). | `:418`,`:434`,`:396`,`:375` |
| **High (data destruction)** | `session/purge` | Permanent, irreversible SDK delete of a session. | `:243` |
| **High (data destruction)** | `session/rewind` (`rollbackFiles`) | Discards history and can roll back files on disk. | `:221` |
| **High (data destruction)** | `session/compact` | Irreversible context compaction. | `:216` |
| **High (config→code)** | `mcp/global-default`, `mcp/session-toggle`, `mcp/reload-session`, `mcp/refresh` | Toggle/respawn MCP servers — loads server code from config (code-exec vector if config is attacker-influenced). | `:326`,`:344`,`:335`,`:331` |
| **Medium (DoS)** | `POST /admin/restart` | Arms graceful self-restart; exits when idle. Forced restart. **CSRF-reachable — see F4.** | `:158` |
| **Medium (DoS)** | `skills/refresh` | Arms a graceful restart (bodiless). **CSRF-reachable.** | `:365` |
| **Medium (input injection)** | `respondAsk`, `respondPlan`, `planSupersede`, `respondElicitation` | Inject decisions/instructions into a paused running turn. | `:271`–`:289` |
| **Medium (soft destruction)** | `session/delete` | Soft-delete to trash (reversible). | `:231` |
| **Low–Med (info / lifecycle)** | `fs/listDir`, `session/unload`, `session/reload`, `session/new`, `rename`, `pin`, `cancel`, `queue/remove`, `inbox/seen`, `setModel`, `setMode` | Filesystem enumeration (dirs only) + session lifecycle/settings churn. | `:454`, `:248`–`:262`, `:184`, `:206`–`:230`, … |
| **Low (cost/SSRF-ish)** | `speech/token`; `push/subscribe` | Mint an Azure token (cost); register a push endpoint the server later POSTs to (outbound request surface). | `:317`,`:307` / `push.ts:66–78` |

Read-only intents (`session/list`, `session/get`, `session/plan`, `session/panels`,
`session/trash-list`, `mcp/global`, `skills/global`, `flow/list`, `*-schedule/list`,
`/status`, `/health`) leak state to anyone who can read a response — but a CSRF
attacker **cannot** read cross-origin responses, so their off-path risk is nil; they
matter only under a *direct* boundary breach (a loopback co-tenant / SSRF-to-port).

---

## SSE backpressure analysis

**Buffering model:** one shared `clients: Set<FastifyReply>` (`index.ts:36`). One
Engine event → one JSON frame → a synchronous `for` loop writing the same frame to
every reply (`:85–88`). Each `reply.raw` (Node `ServerResponse`) owns an independent
writable buffer. Backpressure signalling (`write()===false`, `writableLength`,
`'drain'`) is entirely ignored. There is **no** per-connection ceiling, no
drop-oldest, no forced disconnect, and no cap on `clients.size`.

**Does a stuck socket bound memory? No.** See F2 for the step-by-step. A single
half-open client buffers every subsequent frame in heap until the TCP stack finally
errors the socket (unbounded in time and size), and this is invisible to the
`memory.ts` heap watchdog (which only evicts *sessions*), so it can OOM the process
or evict healthy sessions as collateral.

**Fix:** the high-water-mark drop in F2 (`raw.writableLength > HWM → destroy +
delete`), optionally plus a socket idle-timeout reaper. Dropping is safe and
self-healing because the client reconnects (`retry: 2000`, `:173`) and the server
always replays a full snapshot on connect (`:174`) — there is no resume cursor to
lose.

---

## Upload serving headers (quoted) + traversal guard verdict

Quoted headers and guard are in **F3** above. Verdict: **traversal guard closed,
stored-XSS neutralized** (`nosniff` + `sandbox` CSP + extension-derived MIME with
`.html` falling through to `octet-stream`). Residual is cosmetic only: no explicit
`Content-Disposition` (a navigated non-image renders inline rather than forcing a
download), and the traversal guard is a blocklist where an allowlist
(`^\d+-[0-9a-f]{12}(\.[a-z0-9]{1,12})?$`) would be strictly tighter. Neither is a
security gap given the current mitigations.

---

## New findings

### N1 — [Medium] CSRF on bodiless side-effecting intents + `/admin/restart` — NEW

The process trusts nginx **cookie** auth and adds no Origin/Referer/CSRF check. A
cross-origin **"simple request"** (no CORS preflight) carrying the operator's cookie
therefore reaches any endpoint whose side effect does **not** need a parseable JSON
body. Empirically confirmed against Fastify 5.8.5 (throwaway `/tmp` probe, deleted;
mirrors `index.ts` route shapes):

```
1 textplain /admin/restart        -> 200 {"pending":true,"typeofBody":"string"}
2 nobody    /intent/skills/refresh -> 200 {"ran":true,"typeofBody":"undefined"}
3 urlenc    /admin/restart        -> 415 FST_ERR_CTP_INVALID_MEDIA_TYPE
4 textplain /intent/skills/refresh -> 200 {"ran":true,"typeofBody":"string"}
```

Interpretation:
- An HTML `<form method=POST enctype="text/plain">` (or `fetch(..., {method:'POST',
  credentials:'include'})` with no/`text/plain` body) is a **simple request** — no
  preflight — so the browser sends it with cookies and the handler runs (rows 1,2,4).
- `/admin/restart` reads `(req.body)?.pending ?? true` (`index.ts:159`), so even a
  `text/plain` string body **arms a restart** (row 1) — a forced-restart DoS *if
  `/admin/restart` is proxied by nginx*.
- Bodiless side-effecting intents run regardless of body: **`skills/refresh`**
  (`:365` → arms restart = DoS), **`mcp/refresh`** (`:331`), **`session/refresh`**
  (`:296`). `/intent/*` **is** proxied (it's how the web app works), so this holds
  even if `/admin/restart` is not.
- **What protects the heavy intents** (`prompt`/`purge`/`rewind`/`write-gate`/…) is
  *accidental*, not designed: their `text/plain` string body fails the per-intent
  `zod.parse` → 400, and a real `application/json` body is **not** CORS-safelisted →
  it preflights → the no-CORS server returns no `Access-Control-Allow-Origin` → the
  browser blocks it (row 3 shows even `urlencoded` is 415). A future `@fastify/cors`
  with a permissive origin, or any intent that starts tolerating a string/empty body,
  would silently widen this to the destructive set.

**Fix:** reject cross-origin state-changing requests at the process boundary —
either a strict `Origin`/`Referer` allowlist hook, or (preferred, and it doubles as
the F1 defense-in-depth) require a secret header injected by nginx on `/intent/*` and
`/admin/*`. A custom header also forces any cross-origin caller into a preflight that
the no-CORS server fails. See *Recommended fix*.

### N2 — [Low] `/upload` is unauthenticated and uncapped in count — NEW (supporting)

`POST /upload` (`:112`) has no auth and writes attacker bytes to disk
(`uploads.ts:42–47`); only size is bounded (25 MB, `:24`,`:29`,`:112`). It is *not*
CSRF-reachable (the `application/octet-stream` parser is required → cross-origin
preflight → blocked; a `multipart` form body fails `Buffer.isBuffer` → 400 at
`:115`). But under a *direct* boundary breach it is an unbounded disk-fill primitive
(no count/total-bytes cap on `~/.copilot/cockpit-uploads/`). Same shared-secret gate
closes it.

### N3 — [Low] No connection cap on `clients` — NEW (supporting)

`clients` (`:36`) grows without limit; nothing bounds concurrent `/events` streams.
Single-user makes this academic, but combined with no in-process auth a direct-breach
attacker can open many streams (each a memory + fan-out cost). A small cap (e.g.
refuse `/events` past N) is cheap insurance.

### N4 — [Low] Confirms first-pass Lows — error leakage, `/health` login, `/upload` path

Re-verified, all stand: `index.ts:473` returns raw `e.message` (path/internal
leakage); `:107` `/health` returns `engine.login`; `:119` `/upload` returns the
absolute on-disk `path` to the browser. Behind a working nginx the audience is the
operator, so these are genuinely Low — but they compound the boundary risk if it is
ever breached.

### N5 — [Info] CORS absence is correct; intent body DoS is bounded

No `@fastify/cors` is registered (verified) — **keep it that way**; the same-origin
default is load-bearing (it's what preflight-blocks the heavy intents in N1).
Per-intent bodies inherit Fastify's default 1 MiB global limit (no per-route override
on `/intent/*`), so an oversized-body DoS is bounded at 1 MiB; only `/upload` raises
it (to 25 MB, deliberately). No action needed; noting so a future global
`bodyLimit` bump isn't made blindly.

---

## Recommended fix (proportionate defense-in-depth + matching nginx notes)

This is a single-user loopback app fronted by nginx; the goal is to make a proxy
slip or a stray loopback process **not instantly catastrophic**, without security
theater. Three changes, in priority order.

**R1 — Shared-secret header on mutating paths (closes F1 + N1 + N2 in one move).**
nginx injects a fixed secret it already holds; the server requires it on `/intent/*`,
`/admin/*`, and `/upload`. Read-only `GET`s (`/events`,`/uploads/:name`,`/health`,
`/status`) can stay open or be gated too. Sketch in `index.ts`:
```ts
const AUTH = process.env.COCKPIT_PROXY_SECRET;            // set in the systemd unit
app.addHook('onRequest', async (req, reply) => {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD') return;                // SSE/serve/health stay open
  if (AUTH && req.headers['x-cockpit-auth'] !== AUTH) {   // POST /intent|/admin|/upload
    reply.code(403); return reply.send({ error: 'forbidden' });
  }
});
```
Because the header is custom and non-safelisted, every cross-origin caller is forced
into a preflight the no-CORS server fails — so this **also** kills the N1 CSRF class
even for any future body-tolerant intent. Keep it env-gated so local dev without the
secret still works (the `if (AUTH ...)` guard).
*Matching nginx:* in the cockpit `location` blocks for `/intent/`, `/admin/`,
`/upload`, add `proxy_set_header X-Cockpit-Auth "<secret>";` (same value as
`COCKPIT_PROXY_SECRET`). Confirm `/admin/restart` is **not** publicly proxied at all
unless it must be; if it isn't proxied, N1's restart-via-`/admin/restart` vector is
moot but the `skills/refresh` vector via `/intent/*` still needs R1.

**R2 — SSE high-water-mark drop (closes F2).** Apply the F2 patch
(`writableLength > 8MB → destroy + delete`), optionally a 60 s socket timeout at
`/events`. No nginx change. Self-healing via existing reconnect+snapshot.

**R3 — Cheap belt-and-suspenders (Lows).** Return a generic error for non-zod
failures (`:473`), drop `login` from unauthenticated `/health` (`:107`), omit `path`
from the `/upload` response (`:119`), and tighten `resolveUpload` to an allowlist
regex (`uploads.ts:62`). Optional `Content-Disposition: attachment` for non-images on
`/uploads/:name`. None need an nginx change.

**Test debt worth paying (the security behavior is currently unguarded):** a thin
Fastify `inject()` suite would lock the load-bearing bits cheaply — `/uploads/:name`
returns 404 on traversal and carries both `nosniff` + the sandbox CSP; `/intent/<bad>`
→ 404; an unknown-secret `POST /intent/*` → 403 (after R1); and a `writableLength`
threshold drop in the fan-out. Today `index.ts` has **zero** route-level tests
(`uploads.test.ts` covers only the storage module), so a future edit could silently
drop a header or the auth hook with nothing failing.
