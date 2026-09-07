# Fix: Engine lifecycle/correctness hardening (fx-engine)

Implements the seven items (A–G) of the Engine hardening task, per the deep
reviews `docs/review/deep/dr-engine-lifecycle.md`, `dr-engine-subagents.md`,
`dr-engine-turn.md`, and the emit-null TODO table in
`docs/review/fixes/fx-protocol.md` (+ the emit-null § of `dr-protocol-refine.md`).

**Scope honored:** only `packages/core/src/engine.ts` was modified, plus a new
`packages/core/src/lifecycle.ts` (imported + re-exported by engine.ts) and two new
test files (`lifecycle.test.ts`, `engine.test.ts`). **No protocol/server/web/mcp/
fold/prefs source was touched.** No git ops, no server restart, no deploy. Tests
use an injected temp prefs file — the real `~/.copilot` is never read or written.

All line numbers are **post-edit** lines in `packages/core/src/engine.ts` unless
noted.

---

## New module: `packages/core/src/lifecycle.ts`

Pure, dependency-free helpers (only protocol types) so the same definitions can be
reused by the transport from a `SessionMeta` snapshot without importing the Engine.

- `sessionMetaBusy(meta)` / `engineSessionBusy(meta, inflightTaskCount)` — the
  shared busy predicate (item A).
- `queueTextTag(text)` (FNV-1a → base36), `makeQueueId(index, text)` →
  `q-<i>-<tag>`, `parseQueueId(id)` (tolerates legacy `q-<i>` → empty tag) — the
  stable, content-tagged queue ids (item E).

Re-exported from engine.ts (`engine.ts:35`) per the task ("export it; supplied for
server reuse, but you don't change server"). The `@cockpit/core` barrel
(`src/index.ts`) only re-exports `Engine`, and it is out of scope, so the transport
can consume these by importing them through the engine module today; wiring the
barrel is left as future work (noted below).

---

## A. Shared busy predicate

**Problem (dr-engine-lifecycle):** "busy?" was decided by scattered, inconsistent
checks (`status==='running'`, sometimes `&& !compacting`, sometimes ignoring
sub-agents), so eviction / unload / reload / heap-watchdog each had a *different*
notion of safe-to-unload.

**Change:** one private gate `isBusy(st)` (`engine.ts:486`) delegating to
`engineSessionBusy(st.meta, st.inflightTasks.size)` (`lifecycle.ts:39`). "Busy" =
`status==='running'` **or** a pending choice (ask/planRequest/elicitation) **or**
`activeSubagents>0` **or** `compacting` — OR'd with the live in-flight `task` Set
(catches an add not yet projected). Consumed at every site:

- `evictIfNeeded` (count cap) — `engine.ts:538`
- `checkHeapPressure` (heap watchdog) — `engine.ts:606` (replaced the bespoke
  `status==='idle' && !compacting` filter)
- `unload` — `engine.ts:657`
- `reload` — `engine.ts:668`

Exported for transport reuse: `engine.ts:35`.

## B. Ghost sub-agent leak reaper

**Problem (dr-engine-subagents, 1/124 in real logs):** a `task` whose
`tool.execution_complete` never arrives leaves its `toolCallId` in `inflightTasks`
forever, pinning `activeSubagents≥1` and (now) holding the busy gate open
indefinitely.

**Change:** `reapGhostSubagents(st)` (`engine.ts:514`). The SDK *defers*
`session.idle` while any background agent runs, so a genuinely-idle session with
`inflightTasks>0` has no live agent. The reaper confirms this against the **public**
`session.taskRegistry.list({includeCompleted:false})` via `sdkHasRunningAgents(st)`
(`engine.ts:495`, mirrors the SDK's private `hasRunningAgents()`): it clears only
when the registry **affirmatively reports no running agent**; if the registry still
shows a running agent, or cannot be queried, it leaves the count alone — so it never
breaks legitimate defer-idle. Invoked:

- on `session.idle` (`engine.ts:817`) — the natural reconcile point;
- each heap-watchdog tick for all loaded sessions (`engine.ts:580`) — self-heals a
  leak even with no further events;
- before `evictIfNeeded` filters victims (`engine.ts:536`) and before unload/reload
  (`engine.ts:655`, `:667`) — a ghost can't wrongly refuse a lifecycle op.

## C. Compacting guard on unload/reload

**Problem (dr-engine-lifecycle, engine.ts:562,573 pre-edit):** `unload()`/`reload()`
only refused `status==='running'`. A **manual** `/compact` keeps `status==='idle'`
(the SDK emits no `session.idle` for it), so a graceful self-restart could
`unload`/`exit(0)` **mid-compaction**.

**Change:** both now reap ghosts then refuse when `isBusy(st)` — which includes
`compacting` (and choices and sub-agents). `unload` `engine.ts:651–662`, `reload`
`engine.ts:665–679`. The Chinese error message widened from "运行中…" to "忙碌中…".

## D. emit-null (clear-on-the-wire), not omit

**Problem (fx-protocol TODO table / dr-protocol-refine):** clearing a `.nullable()`
field by *omitting* it fails — `JSON.stringify` drops `undefined`
(`apps/server/src/index.ts`), and the client spread-merge keeps the stale value
(`apps/web/src/net/store.ts`). The user-visible bug: switching to a **non-reasoning**
model returns `reasoningEffort===undefined`, so the prior model's effort badge stuck
on. Protocol already made the three fields `.nullable()`; the engine must emit `null`.

**Changes (all the TODO-table sites):**

| Site | `engine.ts` | Change |
|---|---|---|
| setModel optimistic pre-switch | `1064–1065` | `currentReasoningEffort: reasoningEffort ?? null`, `currentContextTier: contextTier ?? null` (was conditional spread) |
| setModel **success** (the bug) | `1088–1089` | `cur.reasoningEffort ?? null`, `cur.contextTier ?? null` |
| setModel rollback `prev` | `1060–1062` | built with `?? null` so rollback clears |
| setMode rollback | `1168` | `currentMode: prev ?? null` |
| loadSession patch | `449–451` | the three fields `?? null` |

**Belt-and-suspenders normalizer** in `patch()` (`engine.ts:2082`): after
`out = {...fields}`, for each key in `CLEARABLE_MODEL_FIELDS`
(`currentReasoningEffort`/`currentContextTier`/`currentMode`, `engine.ts:66`) an
`undefined` value is rewritten to `null`. It is **scoped to exactly the three
nullable fields** — it never touches `currentModelId`/`availableModels`, which stay
pure-optional (the snapshot schema rejects an explicit `null` for them), per the
spec's per-field default. This is strictly safer than a blanket normalizer.

## E. Queue hardening

**Problem (dr-engine-turn):** `removeQueued` parsed a **positional** `q-<i>` id and
**cleared the whole queue then rebuilt** via the SDK's *private* `enqueueUserMessage`
+ *deprecated* `clearPendingMessages`. The SDK re-indexes its pending array on every
drain/removal, so a stale index silently deleted the **wrong** survivor; and
`cancel()` did not drain the SDK queue, so a message queued behind a cancelled turn
resurrected as the next turn.

**Changes:**

- **Stable content-tagged ids.** `syncQueue` (`engine.ts:994`) now mints
  `makeQueueId(i, text)` (`q-<i>-<tag>`), reading via a new feature-detected
  `readQueueItems` (`engine.ts:954`) that prefers the **public**
  `getPendingQueuedItems()` (gives item `kind`) and falls back to the deprecated
  messages reader.
- **Fail-closed single removal.** `removeQueued` (`engine.ts:1924`) parses the id,
  fast-paths the embedded index when its content tag still matches, else relocates
  by tag, else **no-ops** (never a wrong-item delete). It refuses (no-op) when a
  surviving item is **not** a message (a command/model-change can't be faithfully
  rebuilt — see limited item) and when a clear/enqueue primitive is missing
  (confirms both exist **before** clearing, so the queue is never left half-mutated).
- **Migrated off private/deprecated SDK methods** via three isolated, feature-detected
  helpers preferring the public surface: `readQueueItems` (public
  `getPendingQueuedItems`), `clearQueue` (public `clearPendingItems`, `engine.ts:975`),
  `enqueueMessage` (public `enqueueItem`, `engine.ts:984`) — each falling back to the
  older method only if the public one is absent at runtime.
- **cancel drains the SDK queue.** `cancel` (`engine.ts:1027`) now `clearQueue`s the
  pending queue after `abort()` and reflects `queue:[]` in its silent patch, so a
  queued-behind-cancel message can't auto-start.

## F. Forward `lastActivity` into the SSE patch

**Problem:** the engine set `st.meta.lastActivity` on every folded message but never
emitted it; the web synthesized `lastActivity: Date.now()` client-side
(`apps/web/src/net/store.ts`), violating the pure-projection principle.

**Change:** in the `onLive` msg/upsert loop (`engine.ts:874–891`), when activity
occurs the engine sets `lastActivity` and emits a **throttled bare**
`session/patch {sessionId, lastActivity}` (at most once per `LASTACTIVITY_EMIT_MS =
1000`, `engine.ts:61`; throttle state `SessionState.lastActivityEmit`, `engine.ts:96`).
A bare emit (not via `patch()`) because `lastActivity` never affects attention; the
throttle keeps a streaming turn from emitting one patch per token. The web can now
drop its synthesis. Only the engine emits it.

## G. `session.error` → `status:'error'`

**Problem (dr-engine-turn):** the SDK swallows an agentic-loop failure into a
`session.error` **event** (it does not reject `send()`), then emits `session.idle`.
The engine had no `session.error` branch, so a failed turn projected as a normal
idle completion ('ready') and never surfaced as an error at the meta level.

**Change:** a `session.error` branch in `onLive` (`engine.ts:829`) patches
`{status:'error', error:<message>}` and **falls through** to the fold (so the error
also renders as the usual system-error bubble). The `session.idle` handler
(`engine.ts:808`) now preserves an existing `status:'error'` (it only clears
`intent`, never masking error back to `idle`); the error clears naturally at the next
`assistant.turn_start` (which already sets `status:'running', error:null`).

> Note: `attention.ts` (out of scope) maps `status:'error' → attention null`, so a
> failed turn raises **no** 'ready' badge. That is an accepted tradeoff — the
> `status:'error'` meta + the error bubble are the signal; changing the attention
> mapping would require touching `attention.ts`, which is not in scope.

## Supporting change: constructor prefs injection (test isolation)

`new Prefs()` is the Engine's only real-filesystem touch at construction. To let
tests point it at an isolated temp file (and **never** read/write the real
`~/.copilot`), `prefs`/`hookReg`/`flowSchedReg` moved from field initializers to a
new `constructor(opts: { prefsFile?: string } = {})` (`engine.ts:205`). `new Engine()`
(the server's call) is unchanged via the default `opts={}`. Field initializers can't
read constructor params, which is why the assignment moved into the body.

---

## Verification

```
pnpm --filter @cockpit/core build     # tsc: clean (0 errors)
pnpm --filter @cockpit/core test       # 175 pass / 0 fail  (144 baseline + 31 new)
pnpm --filter @cockpit/core regress     # 56 sessions | 19416 msgs | 0 fold errors | 0 invalid
```

New tests:

- `src/lifecycle.test.ts` (11) — busy-predicate truth table (incl. the
  manual-compaction gap and the in-flight-count OR), queue-id round-trip, the
  race-relocation tag, legacy-id tolerance, and fail-closed id rejection.
- `src/engine.test.ts` (20) — unload/reload refuse running/compacting/choice/
  sub-agent and the unverifiable-registry conservative case; idle unload echoes
  `activeSubagents:0`; reaper clears a ghost / keeps a real agent / stays
  conservative when unverifiable / ignores a running session; `session.error →
  status:'error'` preserved across the trailing idle; setModel/setMode/`patch()`
  emit-null; removeQueued precise / race-relocate / fail-closed stale / fail-closed
  non-message-survivor; cancel drains the queue; throttled lastActivity forwarding.

---

## Limited / deferred items

1. **Faithful interior queue removal is impossible via the SDK's public surface
   (E — accepted limitation).** The SDK exposes only LIFO `removeMostRecentPendingItem`
   and clear-all; an interior removal must clear + rebuild. Re-enqueue can only
   faithfully reconstruct **message** items (prompt text) — a surviving
   `command`/`model_change`/`resume-pending` item, or non-prompt `SendOptions`
   (attachments, `displayPrompt`, `prepend`, `source`, …), would be lost. The fix
   therefore **fails closed**: it refuses the removal (no-op) when a non-message
   survivor exists, rather than silently dropping it. Removing the *only* item, or
   any item from an all-messages queue, works precisely. A faithful interior
   removal would need a new SDK primitive (out of scope — would touch `sdk-types.ts`
   / the SDK).

2. **`readQueueItems` display vs. raw prompt.** `getPendingQueuedItems().displayText`
   may differ from the verbatim prompt. The id's content tag and a removal's
   revalidation both use this same `displayText`, so they always agree (the race fix
   is sound); for the *rebuild* text, `removeQueued` prefers the deprecated
   `getPendingQueuedMessages()` (the only faithful raw-prompt source) when it lines up
   1:1 with the items, falling back to `displayText` otherwise. The residual risk is
   only that a rebuilt prompt shows display text instead of the raw prompt in the
   (already fail-closed, all-messages) rebuild path — never a wrong-item deletion.

3. **Transport reuse of the busy predicate is via the engine module, not the
   `@cockpit/core` barrel.** `src/index.ts` (which only re-exports `Engine`) is out
   of scope, so although `sessionMetaBusy`/`engineSessionBusy` are exported from
   engine.ts, wiring them into the barrel (and the server's graceful-restart gate) is
   left to the server-owning change. No regression: the engine consumes the predicate
   internally today.

4. **`session.error` raises no attention badge.** By design (see item G note) — the
   `error→null` mapping lives in `attention.ts`, which is out of scope.
