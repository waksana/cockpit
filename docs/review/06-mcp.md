# Module 6 — MCP server

## Summary

The cockpit MCP (`apps/mcp/`) is in good shape: every tool is a thin, consistent client over a
loopback intent, the session store is opened **read-only** with fully parameterized SQL, and the
JSON-budgeting layer (`cappedJson`) is genuinely well-engineered and unit-tested against the exact
corruption bug it was written to kill. The destructive-op `confirm` gate is correctly unbypassable
*at the tool surface*. The biggest risks are not memory-safety but **trust-surface and contract**
issues: `cockpit_upload_file` will read *any* host-readable path and republish it at a web-reachable
`/uploads` URL (an exfiltration primitive, only mitigated by the single-user/auth model);
`cockpit_rewind_session` documents an id source (`cockpit_read_session`) that does not actually
surface a usable message id; and the `confirm` guard plus all the path-traversal protection for
flows/gates live entirely *server-side or client-side* with no defense-in-depth on the other end.
No Critical issues found.

## Findings

### [High] `cockpit_upload_file` reads any absolute host path and makes it web-reachable — `apps/mcp/src/tools/files.ts:54-78`
- **What** The tool does `readFile(path)` on any caller-supplied absolute path with no allowlist,
  size pre-check, or confinement, then POSTs the bytes to `/upload`, which returns a `/uploads/<name>`
  URL served by the backend. There is no restriction preventing `path` from being
  `~/.ssh/id_rsa`, `~/.copilot/session-store.db`, or `cockpit-prefs.json` (which can hold tokens).
- **Why it matters** This turns "can call the MCP" into "can copy any host-readable secret to a
  web-served location." It is partly mitigated — the agent already has `bash` on the host, the
  uploads path is behind nginx cookie auth, and cockpit is single-user — so it is not a *new*
  read capability, but it *is* a new path from on-disk secret → externally fetchable URL, and the
  documented "Max ~25 MB" is not enforced in the MCP (the whole file is buffered into memory before
  the server can reject it, so an oversized/streamed path can OOM the MCP process first).
- **Recommendation** Document the exfiltration consideration explicitly; optionally `stat` the file
  and refuse oversized reads before buffering, and consider a soft warning/allowlist for paths
  outside the user's project roots. At minimum, ensure the server `/upload` side enforces the size
  cap independently (it should not depend on the MCP).

### [Medium] `cockpit_rewind_session` points at an id source that doesn't provide the id — `apps/mcp/src/tools/settings.ts:108` / `apps/mcp/src/index.ts:164-169`
- **What** `to_msg_id` is forwarded as `toMsgId` (matches the `session/rewind` contract,
  `packages/protocol/src/index.ts:629`), and the description says *"Get the target message id from
  cockpit_read_session."* But `cockpit_read_session` only emits `turns[].index` (the SDK
  `turn_index` / event-fold ordinal), never a ChatMessage `msgId`. No MCP read tool
  (`get_session`, `read_session`, `get_panels`, `get_plan`) surfaces a value usable as `toMsgId`.
- **Why it matters** An agent following the documented workflow cannot obtain a valid `toMsgId`,
  so the rewind tool is effectively unusable through the MCP without out-of-band knowledge of an id
  the surface never exposes.
- **Recommendation** Either surface the real message id in `cockpit_read_session`'s output, or
  correct the description to name the actual source of a rewind target id.

### [Medium] Destructive `confirm` gate and flow/gate path-safety have no defense-in-depth — `apps/mcp/src/index.ts:283`, `apps/mcp/src/tools/settings.ts:83,115`
- **What** `confirm:true` is enforced only in the MCP tool wrappers (`purge`, `compact`, `rewind`).
  The underlying intents (`session/purge`, `session/compact`, `session/rewind`) carry **no** confirm
  field and perform the destructive action unconditionally. Symmetrically, flow-id / gate-name
  path-traversal rejection lives **only** server-side (`isSafeBasename`, verified at
  `packages/core/src/flows.ts:20-22,166,192`); the MCP forwards `id`/`name` raw.
- **Why it matters** The guard holds at the surface it lives on, but each protection is single-sided.
  Any caller hitting the loopback intent directly (the documented fallback when the MCP isn't
  enabled) bypasses `confirm` entirely. This is *acceptable* under the single-user/localhost trust
  model, but it means `confirm` is a UX safety latch, not a security control — worth stating plainly
  so no one over-trusts it.
- **Recommendation** Document that `confirm` is an agent-facing latch, not a server gate. If cheap,
  consider mirroring a `confirm`/`force` requirement on the destructive intents themselves so the
  protection isn't lost when the loopback path is used directly.

### [Low] The "server-up precheck (GET /health)" described in the design does not exist — `apps/mcp/src/cockpit.ts:26-43`
- **What** There is no `GET :8771/health` precheck anywhere in the MCP. Liveness is handled lazily:
  `intent()` wraps `fetch` in try/catch and, on a connection error, throws a `CockpitError` with an
  actionable remediation message (`systemctl --user status cockpit-server.service`).
- **Why it matters** Functionally fine for intent-based tools, but the behavior differs from the
  documented "precheck," and the actionable message only fires on *connection* failure, not on a
  server that is up but unhealthy. Minor expectation mismatch.
- **Recommendation** Either add the documented health precheck or update the design note to describe
  the lazy error-translation approach actually used.

### [Low] `cockpit_upload_file` raw `fetch` has no timeout/abort — `apps/mcp/src/tools/files.ts:66-70`
- **What** Every intent call goes through `cockpit.ts`'s `intent()`, which arms an `AbortController`
  with `REQUEST_TIMEOUT_MS` (`apps/mcp/src/cockpit.ts:22-33`). The upload tool bypasses that helper
  and calls `fetch` directly with **no** signal/timeout.
- **Why it matters** A stalled connection on upload blocks the tool indefinitely, unlike every other
  tool. Inconsistent robustness.
- **Recommendation** Reuse the same `AbortController`/timeout pattern for the upload `fetch`.

### [Low] `readEventTurns` re-folds the entire event log on every paginated read — `apps/mcp/src/store.ts:142-178` / `apps/mcp/src/index.ts:146-150`
- **What** `cockpit_read_session` calls `readEventTurns(id)` (which streams the whole `events.jsonl`,
  accumulating *all* turns' text into memory) and then slices `[offset, offset+limit]` in JS. The
  comment notes logs reach 100MB+.
- **Why it matters** Each paginated page re-reads and re-parses the full log and holds every turn's
  text in memory before discarding all but the page — O(n) work/memory per call regardless of
  `limit`/`offset`. For a salvage read of a very large session this is slow and memory-heavy.
- **Recommendation** Acceptable for occasional salvage; if it becomes hot, fold lazily up to
  `offset+limit` or cache the folded turns per session id.

### [Low] `read_session` trusts the session id as a path segment (mitigated) — `apps/mcp/src/store.ts:132-138` / `apps/mcp/src/index.ts:139-146`
- **What** `eventLogPath(id)` does `join(SESSION_STATE_DIR, id, 'events.jsonl')` with the
  caller-supplied id. There is no UUID-shape validation; traversal is prevented only because
  `getSessionRow(id)` (a parameterized DB membership check) runs first and SDK session ids are UUIDs.
- **Why it matters** Defense rests on the DB lookup, not on the path builder. Safe today, but a
  future caller that reaches `eventLogPath`/`hasEventLog` without the membership check would inherit
  a traversal bug.
- **Recommendation** Add a cheap basename/UUID-shape assertion in `eventLogPath` (defense-in-depth),
  independent of the DB check.

### [Low] Minor internal-detail leakage in error text — `apps/mcp/src/store.ts:37-46`, `apps/mcp/src/tools/files.ts:73`
- **What** `StoreError` messages embed the absolute `SESSION_STORE` path; the upload-failure path
  surfaces `t.slice(0, 200)` of the server's raw response.
- **Why it matters** Low sensitivity (local single-user), but these are the only places error text
  carries filesystem/server internals rather than an actionable abstraction.
- **Recommendation** Leave as-is unless tightening; the path is arguably useful for the
  "set COCKPIT_SESSION_STORE" hint. Noted for completeness.

### Critical
None found.

## Test coverage assessment

- **What exists & passes:** `pnpm --filter @cockpit/mcp test` runs `shared.test.ts` — **6/6 pass**.
  The suite is high-value: it targets `cappedJson`/`capped` precisely, including the real
  `cockpit_read_session` corruption bug (control chars + embedded quotes, over-budget shrink, and
  the single-oversized-turn clip branch). This is the riskiest pure-logic in the module and it is
  well covered.
- **The server-side guard the MCP leans on is tested elsewhere:** `isSafeBasename` traversal
  rejection and `writeGate` confinement are covered in `packages/core/src/flows.test.ts:117-168`
  (out of this module's scope but confirmed present, so the MCP's "path-traversal rejected" promise
  is real).
- **Gaps (no tests):** none of the tool wrappers themselves are tested. Specifically uncovered:
  the `confirm`-gate refusal branches (`purge`/`compact`/`rewind`), the "exactly one of
  interval/cron/at" and "exactly one of flow_id/prompt_template" validators
  (`index.ts:542-543`, `hooks.ts:45,364-368`), snake→camel field mapping to intents, and the
  `read_session` event-vs-`turns` source selection / pagination math. The `intent()` error
  translation (`cockpit.ts`) and `store.ts` SQL paths are also untested (the latter would need a
  fixture DB). These are mostly thin glue, but the one-of validators and the gate-refusal branches
  are cheap, pure, and worth a few asserts given they are the actual safety logic.

## Positive notes (brief)

- **Read-only store + parameterized SQL:** `new DatabaseSync(SESSION_STORE, { readOnly: true })`
  (`store.ts:42`) and every query uses `?` placeholders (`store.ts:53-111`). No injection surface
  via `sessionId`/limit/offset; no write/schema path. Exactly as required.
- **`cappedJson` is the standout:** it never raw-slices serialized JSON (the documented failure
  mode), offering verbatim → shrink-callback → valid overflow-envelope, and the binary-search
  prefix fit in `read_session` (`index.ts:181-227`) is careful and correct.
- **Consistent, actionable error surface:** `CockpitError` carries a verbatim-surfaceable
  remediation (`cockpit.ts:36-40`), and tools uniformly translate via
  `e instanceof CockpitError ? e.message : String(e)`.
- **Destructive ops are well-labeled:** correct `destructiveHint`/`idempotentHint` annotations and
  explicit, unbypassable `confirm` defaults (`.default(false)`) on purge/compact/rewind.
- **Clean separation by concern** under `tools/*` with a shared types/helpers module; zod schemas
  match the underlying intent contracts I spot-checked (`prompt.mode` enum, `session/rewind.toMsgId`,
  respond_* request-id mapping).

## Cross-cutting (brief)

- The MCP's safety for flows/gates/uploads is entirely *delegated* to the server/engine
  (`isSafeBasename` in `packages/core/src/flows.ts`, the `storedName` guard in
  `apps/server/src/uploads.ts:62`, the `confirm`-less destructive intents in `apps/server`/
  `packages/core`). Those boundaries were spot-verified as present and tested, but they belong to
  other modules — flagged here only because the MCP's promises depend on them.
- `cockpit_list_dir` → `engine.listDir` (`packages/core/src/engine.ts:1230`) intentionally allows
  enumerating **any** directory on the host (no home confinement, dotfiles hidden). Consistent with
  the folder-picker intent and the host-shell trust model; noted, not a finding against this module.
- Protocol contract alignment (`packages/protocol/src/index.ts`) is the cross-module dependency that
  keeps these zod schemas honest; the rewind id-source gap above is the one place the MCP's
  *documentation* drifts from what the surface can supply.
