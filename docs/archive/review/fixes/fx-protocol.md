# Fix: Protocol schema hardening (fx-protocol)

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../README.md) · [归档边界](../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/fixes/fx-protocol.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


Implements the spec `docs/review/deep/dr-protocol-refine.md` (High #5 / T5 / the
schema side of T3), the High item of `docs/review/01-protocol.md`, and is
consistent with the undefined-serialization § of `dr-engine-subagents.md`.

**Scope honored:** only `packages/protocol/src/index.ts` was modified, plus a new
`packages/protocol/src/index.test.ts` and a `test` script (+`tsx` devDep) in
`packages/protocol/package.json`. **No `engine`/`server`/`web` source was
touched.** No git ops, no server restart, no deploy.

All line numbers below are the **post-edit** lines in `packages/protocol/src/index.ts`.

---

## 1. Clearable fields → `.nullable()` (relaxation; backward-compatible)

Added two shared helpers at the top of the file (used by the changes below):
- `exactlyOne(obj, keys)` — `index.ts:15-16`
- `SafeBasename` — `index.ts:22-24`

`SessionMeta` model sub-fields, per the spec "Clearable-fields table" (only the
fields the engine genuinely clears back to absent — **not** over-nullabled):

| Field | Before | After | Line |
|---|---|---|---|
| `currentReasoningEffort` | `z.string().optional()` | `z.string().nullable().optional()` | `index.ts:460` |
| `currentContextTier` | `ContextTier.optional()` | `ContextTier.nullable().optional()` | `index.ts:462` |
| `currentMode` | `AgentMode.optional()` | `AgentMode.nullable().optional()` | `index.ts:465` |

**Deliberately left pure `.optional()` (never cleared — over-nullable guard):**
`currentModelId` (`:459`) and `availableModels` (`:466`). The already-`.nullable()`
clearables (`error/ask/planRequest/elicitation/todo/intent/attention`) were already
correct and unchanged.

`.nullable()` is a **relaxation**: the field now accepts both `undefined` (engine's
current emit — still legal) and an explicit `null`. `SessionMeta.partial()`
(`session/patch`, `index.ts:569`) preserves the nullability, so a patch can carry
`{ field: null }` that survives `JSON.stringify` and round-trips to clear the
client projection. **Zero regression** — nothing that validated before fails now.

## 2. Exactly-one-of `.superRefine()` (tightening — reflects the real invariant)

Moved three mutual-exclusion invariants off engine dispatch code onto the shared
intent-body gate, via the `exactlyOne` helper. Applied only to terminal
`z.object(...)` bodies (never to `SessionMeta`/`.partial()`-derived schemas — the
spec HARD CONSTRAINT):

| Intent | Rule | Line |
|---|---|---|
| `schedule/add` | exactly one of `{interval, cron, at}` | `index.ts:847-850` |
| `hook/add` | exactly one of `{flowId, promptTemplate}` (stricter than the engine guard, which permitted both) | `index.ts:873-876` |
| `flow-schedule/add` | exactly one of `{flowId, target}` **and** exactly one of `{interval, cron, at}` | `index.ts:939-944` |

These mirror the existing engine guards (`engine.ts:1340`, `engine.ts:1602`,
`flow-schedule.ts:128-131`), so every currently-legal call still passes; only
the already-meaningless none/both cases (previously caught later in engine code)
are now rejected at the boundary.

## 3. `SafeBasename` regex on filesystem-bound fields (defense-in-depth)

Mirrors engine `flows.ts:20-21 isSafeBasename` (regex **and** `!includes('..')` —
the regex alone accepts `a..b`):

| Field | Before | After | Line |
|---|---|---|---|
| `Flow.id` (used by `flow/add`, body `Flow`) | `z.string()` | `SafeBasename` | `index.ts:278` |
| `flow/remove.id` | `z.string()` | `SafeBasename` | `index.ts:906` |
| `flow/write-gate.name` | `z.string()` | `SafeBasename` | `index.ts:913` |
| `flow/write-gate.script` | `z.string()` | `z.string().min(1)` | `index.ts:913` |

Engine keeps its `isSafeBasename` checks as defense-in-depth; the schema now also
rejects traversal at the boundary for **every** caller (incl. a future MCP path).

## 4. `push/subscribe.endpoint` → https-only + drop `.passthrough()` (tightening)

`PushSubscriptionJson` (`index.ts:595-599`):
- `endpoint`: `z.string()` → `z.string().url().refine(u => u.startsWith('https://'), …)`
  — `.url()` alone accepts `file:///etc/passwd`, so the https refine is essential
  (this is a server-side Web Push `fetch` target; SSRF-adjacent).
- dropped `.passthrough()` — the three keys (`endpoint`/`expirationTime`/`keys`)
  are the whole Web Push shape.

Server note: `apps/server` already does `Intents['push/subscribe'].body.parse(body)`,
so tightening the schema tightens the live gate with no server edit.

---

## New test suite

`packages/protocol/src/index.test.ts` (node:test + tsx, matching the repo
convention). The package previously had **0 tests**. Added `test` script +
`tsx` devDep to `packages/protocol/package.json` and ran `pnpm install`.

Coverage (spec "Proposed protocol fixture test suite", groups A–E):
- **A** SessionMeta round-trip + null discipline (full/minimal parse; null for
  each already-nullable field; reject `null` for non-nullable `title` and for the
  never-cleared optional `currentModelId`).
- **B** `session/patch` contract: `error:null` baseline; clearing each **new**
  nullable (`currentReasoningEffort`/`currentContextTier`/`currentMode`) to null;
  over-nullable guard (`currentModelId:null` / `availableModels:null` rejected);
  missing `sessionId` rejected; wire-fidelity (null survives JSON, undefined dropped).
- **C** exactly-one-of: reject none/both, accept exactly one, for all three bodies.
- **D** basename (`flow/add`, `flow/remove`, `flow/write-gate`) + empty-script +
  https-endpoint accept/reject sets.
- **E** every `ServerEvent` variant parses; representative `Intents` body+result
  samples parse; nested (sub-agent) `ChatMessage` parses; compile-time
  `ChatMessage` interface↔schema parity assertion (enforced by `tsc`).

### Results

```
pnpm --filter @cockpit/protocol test   → tests 19   pass 19   fail 0
pnpm --filter @cockpit/protocol build  → tsc exit 0 (parity assertion holds)
```

### Regression (required)

```
pnpm --filter @cockpit/core   test → tests 144  pass 144  fail 0
pnpm --filter @cockpit/server test → tests 11   pass 11   fail 0
```

All green; the schema relaxation/tightening breaks no existing legal call.

---

## TODO for fx-engine (emit `null`, not omit) — DO NOT do here

The `.nullable()` relaxation only *allows* a clearing `null`; the engine must
actually **emit `null` instead of omitting** so the field clears on the wire
(`JSON.stringify` drops `undefined` — `apps/server/src/index.ts:39`; the client
spread-merge then keeps the stale value — `apps/web/src/net/store.ts:236-238`).
The matching engine edits (all in `packages/core/src/engine.ts` unless noted):

| Field → clear-site | What to change |
|---|---|
| `currentReasoningEffort` — setModel **success** `engine.ts:~895` (the user-visible bug: `cur.reasoningEffort` is `undefined` on a non-reasoning model) | emit `cur.reasoningEffort ?? null` |
| `currentContextTier` — setModel success `engine.ts:~896` | emit `cur.contextTier ?? null` |
| `currentReasoningEffort`/`currentContextTier` — optimistic pre-switch patch `engine.ts:~880-881` | emit `reasoningEffort ?? null` / `contextTier ?? null` instead of the `...(x!==undefined?{}:{})` spread |
| `currentReasoningEffort`/`currentContextTier` — rollback `prev` built `engine.ts:~875` + applied `:~900` | build `prev` with `null` for an absent effort/tier so rollback clears, not omits |
| four model sub-fields — load `engine.ts:~414-417` | pass `?? null` |
| `currentMode` — setMode rollback `engine.ts:~973` + load `:~417` | emit `?? null` |

**Belt-and-suspenders (recommended, kills the class):** in `patch()` where `out`
is assembled (`engine.ts:~1848`), normalize every `undefined` value to `null`
before emit (`engine.ts:~1861`). This is now safe for the three fields nullabled
here; if that normalizer is adopted, `currentMode` (done) and optionally
`currentModelId` must stay/become nullable so it can never produce a schema-rejected
`null` (we left `currentModelId` pure-optional per the spec's per-field default —
revisit only if the blanket normalizer is adopted).

Engine guards for the exactly-one-of and basename rules can **stay** as
defense-in-depth (now redundant with the boundary, by design — "both ends validate").
