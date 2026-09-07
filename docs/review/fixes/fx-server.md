# Fix: Server transport-layer security/consistency hardening (fx-server)

Implements the six items of the server-transport hardening task, per the deep
review `docs/review/deep/dr-server-security.md` (F1/F2 + new findings N1/N3) and
the fx-engine handoff (`docs/review/fixes/fx-engine.md` → "Limited/deferred" #3:
wire the shared busy predicate into the graceful-restart gate).

**Scope honored:** only `apps/server/src/index.ts` was modified, plus **one line**
added to the `@cockpit/core` barrel (`packages/core/src/index.ts:2`) re-exporting
the already-defined `sessionMetaBusy`/`engineSessionBusy` from `./lifecycle`. No
protocol/web/mcp/core-implementation source was touched; `push.ts` was left as-is
(it is VAPID web-push — the SSE fan-out it would seem to name actually lives in
`index.ts`, so the SSE changes landed there). No git ops, no server restart, no
deploy. New tests use `COCKPIT_NO_BOOT=1` + a temp upload dir — the real
`~/.copilot` is never read or written.

All line numbers are **post-edit** lines in `apps/server/src/index.ts` unless noted.

---

## Barrel re-export (the one allowed core line)

`packages/core/src/index.ts:2` — `export { sessionMetaBusy, engineSessionBusy } from './lifecycle.ts';`

fx-engine defined these pure predicates in `lifecycle.ts` and re-exported them from
`engine.ts`, but never put them in the `@cockpit/core` barrel, so the transport
could not import them. This single line closes that gap (and is the only core
change).

---

## 1. Delegate the busy predicate (graceful self-restart gate)

**Problem (dr-engine-lifecycle handoff / fx-engine #3):** the server kept its **own
copy** of "is this session busy?" (`sessionBusy`, a local re-implementation of the
four busy terms). Even though it happened to match today, a duplicate is free to
drift — a future edit could silently drop the `compacting` / `activeSubagents` /
pending-choice terms and let the server `exit(0)` **mid-compaction**,
**mid-sub-agent**, or **mid-question**, exactly the class of bug the engine's shared
predicate was created to kill.

**Change:** `sessionBusy(s: SessionMeta)` now **delegates** to the engine's shared
`sessionMetaBusy` (`index.ts:113` → `@cockpit/core` → `lifecycle.ts`). The two
notions of "busy" are now provably identical — the transport's restart gate uses the
exact same definition as the engine's eviction/unload/reload guards. Consumed at the
two restart-gate sites unchanged:

- `busyCount()` (the gate's counter) — `index.ts:118`
- `/status` (ops readout) — `index.ts:271`

`awaitingChoice()` is retained (`index.ts:100`) — it still feeds the per-session
`awaitingChoice` flag in `/status` (`index.ts:267`).

## 2. Origin / CSRF defense (dr-server-security N1 — CONFIRMED)

**Problem (N1):** the process has **no in-process auth** — it trusts nginx's
basic-auth + `SameSite=Lax` cookie and binds loopback only. A cross-origin browser
POST that is a CORS **"simple request"** (`text/plain` or bodiless — **no
preflight**) carries the operator's ambient cookie and reaches every bodiless
side-effecting intent (`skills/refresh`, `mcp/refresh`, `session/refresh`, …) and
`/admin/*` — a forced-restart / refresh DoS off-path. `SameSite=Lax` narrows but
does not fully close it (and the heavy intents are only *accidentally* protected by
zod-rejecting a string body).

**Change:** an `onRequest` hook (`index.ts:218`) rejects **cross-origin mutating
requests** with `403` before any handler runs. Decision in the pure, exported
`isAllowedOrigin(headers)` (`index.ts:198`):

- **No `Origin` and no `Referer` → ALLOW.** A forged cross-origin browser request
  *always* carries one of them; their absence means a non-browser caller (the
  cockpit MCP / curl over loopback, server-to-server) with no ambient cookie —
  structurally not a CSRF. This is what keeps **the MCP loopback path** and
  **`scripts/e2e.mjs`** working (Node `fetch` sends no `Origin`).
- **`Origin`/`Referer` present → must resolve to a trusted host:** the request's own
  `Host` (the standard same-origin check, `index.ts:213`), a **loopback** host
  (`index.ts:214`, `isLoopbackHost` strips the port — covers `localhost:5173` dev),
  or the **configured/known public-origin allowlist** (`ALLOWED_ORIGIN_HOSTS`,
  `index.ts:176`). Anything else → reject.
- The literal **`Origin: null`** (sandboxed/opaque origin) is *not* trusted — it
  fails the `URL` parse (`originToHost`, `index.ts:184`) → reject (not the
  no-origin allow path).
- **Only mutating methods are gated**; `GET/HEAD/OPTIONS` (SSE, `/uploads`,
  `/health`, `/status`, preflight) stay open (`index.ts:220`). A CSRF attacker can't
  read a cross-origin GET response anyway, and the preflight the no-CORS server fails
  already blocks the follow-up.

The allowlist defaults to the known public origin
`https://cockpit.rbym47.com` (`DEFAULT_ALLOWED_ORIGINS`, `index.ts:175`) and is
extendable via `COCKPIT_ALLOWED_ORIGINS` (comma-separated). The default makes the
fix **regression-proof against either nginx `Host` behavior**: if nginx forwards the
original `Host` (`proxy_set_header Host $host`), the same-origin check passes; if it
rewrites `Host` to the upstream (`127.0.0.1`), the known-origin allowlist still
admits the real frontend. No nginx change is required.

**Why Origin/Referer and not the review's preferred shared-secret header:** R1's
secret header needs a matching nginx edit (`proxy_set_header X-Cockpit-Auth …`),
which this task may not touch. The Origin check is the review's stated alternative
and is fully in-process — proportionate here.

## 3. SSE high-water-mark (dr-server-security F2 — CONFIRMED/upgraded)

**Problem (F2):** the SSE fan-out discarded `write()`'s return value with **no**
high-water-mark, drop, or forced disconnect. Node's `ServerResponse` keeps buffering
in **heap** when a peer's TCP receive window stalls (sleeping phone, backgrounded
tab) — `write()` returns `false` but never throws, and `'close'` won't fire for a
half-open socket for minutes. That buffer is **invisible to the `memory.ts` heap
watchdog** (it only evicts *sessions*), so one stalled client can OOM the process or
trip the watchdog into evicting healthy sessions as collateral.

**Change:** a per-connection ceiling `SSE_HWM` (default 8 MB, env
`COCKPIT_SSE_HWM`, `index.ts:50`). All SSE writes go through `sseWrite()`
(`index.ts:63`): if `raw.writableLength > hwm` it **drops** the connection
(`clients.delete` + `raw.destroy()`) and logs it; a throwing write (closed socket)
also drops. The fan-out loop is now `broadcastFrame(clients, frame)`
(`index.ts:77`, used by `onEngineEvent`, `index.ts:134`); the connect snapshot
(`sseSend`, `index.ts:81`) and the 25 s keep-alive `: ping` (`index.ts:308`) route
through the same path — so a stalled/zombie connection is reaped on the next ping
even between turns (its buffered ping bytes are the trigger). Dropping is **safe and
self-healing**: the client auto-reconnects (`retry: 2000`, `index.ts:299`) and
re-pulls a full snapshot on connect — there is no resume cursor to lose.

## 4. SSE connection cap (dr-server-security N3 — NEW)

**Problem (N3):** `clients` grew without limit; nothing bounded concurrent `/events`
streams. With no in-process auth, a direct-breach attacker could open many streams
(each a memory + fan-out cost).

**Change:** `MAX_SSE_CLIENTS` (default 64, env `COCKPIT_MAX_SSE_CLIENTS`,
`index.ts:53`). `GET /events` refuses a new stream past the cap with
`503 + Retry-After: 5` (`index.ts:292`) before entering raw SSE mode. 64 is far
above any one operator's devices/tabs, and stale entries are cleaned on `'close'`
and by the F2 HWM drop, so the legitimate operator is never locked out.

## 5. prompt = RCE under YOLO (dr-server-security F1) — known design, not changed

`prompt` (and `flow/write-gate` + `flow/run`) execute as the operator under
`APPROVE_ALL_PERMISSIONS` (`engine.ts:328`). This is **the product** — cockpit is a
single-operator agent console where the operator *drives* the agent to run
commands; YOLO is intentional (`docs/cockpit-testing.md` "Accepted risks"). **No
behavior change.** The real mitigation against an *off-path* exploit (a cross-origin
page abusing the operator's cookie) is the Origin/CSRF gate (#2), which blocks the
forged cross-origin request before it ever reaches `dispatch()`. Recorded here as
**known design, mitigated by CSRF**, per task scope.

## 6. nginx — recommendation only (no real config touched)

No nginx file was read or modified. For defense-in-depth beyond the in-process
Origin check, the operator *may* add the review's R1 shared-secret header — purely a
recommendation:

```nginx
# In the cockpit location blocks for /intent/ and /upload (and /admin/ only if it is
# ever proxied — today it is loopback-only and SHOULD stay unproxied):
proxy_set_header X-Cockpit-Auth "<secret>";          # == $COCKPIT_PROXY_SECRET
# Ensure the browser Origin survives to the backend so the same-origin check works
# without relying on the hardcoded allowlist:
proxy_set_header Host $host;
proxy_set_header Origin $http_origin;
```

If that header is adopted, pair it with an env-gated server check; not implemented
here because it requires the coordinated nginx edit this task must not make. The
Origin gate (#2) already closes N1 without any nginx change.

---

## Supporting change: guarded boot (test isolation)

The module previously constructed `new Engine()` (which reads the real `~/.copilot`
prefs) and called `main()` (`engine.start()` + `app.listen()`) at import time, so the
transport surface could not be unit-tested without booting the whole engine. Engine
+ push construction, the `onEvent` registration, and `main()` moved into a `boot()`
function (`index.ts:619`) called only when `process.env.COCKPIT_NO_BOOT !== '1'`
(`index.ts:627`). Production (`tsx src/index.ts`, env unset) boots **identically** to
before; tests import the module with `COCKPIT_NO_BOOT=1` to get the Fastify `app` +
the exported pure helpers (`isAllowedOrigin`, `sseWrite`, `broadcastFrame`,
`sessionBusy`) with **no** engine and **no** bound port. `engine`/`push` became
`let …!` (definite-assignment) — always set in `boot()` before any request handler
that derefs them can run; the inline `engine.onEvent(arrow)` became the named
`onEngineEvent` (`index.ts:133`) registered in `boot()`.

---

## Verification

```
pnpm --filter @cockpit/server build   # tsc --noEmit: clean (0 errors)
pnpm --filter @cockpit/server test     # 36 pass / 0 fail  (11 baseline + 25 new)
pnpm --filter @cockpit/core  build     # tsc: clean (barrel re-export)
pnpm --filter @cockpit/core  test       # 175 pass / 0 fail (unchanged baseline)
```

New tests — `apps/server/src/security.test.ts` (25), imported with
`COCKPIT_NO_BOOT=1` + temp `COCKPIT_UPLOAD_DIR`:

- **Origin gate via `app.inject`** (9): cross-origin → 403; same-origin (Host
  match) / known public origin / configured (env) origin / loopback / no-Origin →
  pass (404 unknown-intent); opaque `null` → 403; `/admin/restart` cross-origin →
  403; cross-origin **GET** reaches the handler (not gated).
- **Pure `isAllowedOrigin` truth table** (6): no-headers, cross-origin, same-origin
  via Host, opaque `null`, Referer fallback (accept + reject), loopback at any port.
- **SSE high-water-mark** (5): `sseWrite` drops + destroys an over-HWM connection,
  writes a healthy one, drops on a throwing write; `broadcastFrame` drops only the
  slow consumer and keeps healthy ones; an explicit lower HWM is respected.
- **Busy delegation** (5): `sessionBusy` equals `sessionMetaBusy` across
  idle/running/compacting/sub-agent/each pending-choice; idle→not-busy;
  compacting/sub-agent/awaiting-choice while idle → busy.

---

## Limited / deferred items

1. **No backend restart / no live e2e of the new behavior (by task constraint).**
   cockpit-server runs live TS; a restart **is** the deploy, which the task reserves
   for the user (and I run inside cockpit myself). `scripts/e2e.mjs` runs against the
   **already-running** backend, i.e. the *old* code — it can neither exercise the new
   Origin gate nor the HWM drop, and it would write a throwaway session into the real
   `~/.copilot`, so it was **not** run. The new behavior is fully covered by the
   in-process `app.inject` + unit suite instead. Once the operator deploys, the e2e's
   no-`Origin` Node-`fetch` requests pass the gate unchanged (verified by the
   no-Origin-allow test).

2. **Origin check depends on the browser sending `Origin`/`Referer`.** This is the
   standard same-origin-header CSRF defense and holds for all modern browsers (which
   send `Origin` on every state-changing request). If a proxy were to strip `Origin`
   *and* `Referer`, the request degrades to the no-origin **allow** path — i.e. the
   CSRF protection is bypassed but **the legitimate frontend is never broken**
   (fail-open on availability, not on a forged cross-origin request, which still
   needs a present mismatching `Origin`). A future hardening that *requires* a
   trusted header (review R1) would remove this dependency but needs the coordinated
   nginx edit (#6).

3. **Hardcoded default public origin.** `https://cockpit.rbym47.com` is baked into
   `DEFAULT_ALLOWED_ORIGINS` so the current deployment can't regress regardless of
   nginx `Host` behavior. A domain change requires either setting
   `COCKPIT_ALLOWED_ORIGINS` or nginx forwarding `Host` (then the dynamic same-origin
   check covers it). Documented above; left as an env knob rather than guessing the
   future domain.

4. **YOLO RCE unchanged (by design).** See #5 — the in-scope mitigation is the CSRF
   gate; changing the permission handler is out of scope and contrary to the product.

5. **`push.ts` untouched.** The task named it as a primary file and tagged the SSE
   HWM to it, but `push.ts` is VAPID web-push; the SSE fan-out lives in `index.ts`,
   so the HWM/cap landed there (where the `clients` set and write loop are). Mixing
   transport-backpressure logic into the web-push module would be a semantic
   regression, so `push.ts` was deliberately left as-is.

6. **Belt-and-suspenders Lows (N4/N2) not addressed** — generic error bodies,
   dropping `login` from `/health`, omitting the on-disk `path` from `/upload`, and a
   `/uploads` allowlist regex are genuine but out of this task's stated five fixes;
   behind working nginx their audience is the operator (Low). Noted for a follow-up.
