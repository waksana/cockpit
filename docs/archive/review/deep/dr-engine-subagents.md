# Deep: Engine subagents & SDK contract

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../README.md) · [归档边界](../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/deep/dr-engine-subagents.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


Verification pass over `packages/core/src/engine.ts` (`trackSubagents`, `attention`/`patch`,
`projectButlerMeta`, soft-delete `deleteSession`, schedule rehydrate), `bootstrap.ts`
(`assertSdkContract` + the two sub-agent fixes), and `sdk-types.ts`, cross-checked against the
installed `@github/copilot@1.0.63` bundle and 60+ real `events.jsonl` logs. Read-only; no source
touched. SDK runtime shapes and real-log conservation were probed read-only with throwaway inline
scripts (no source or fixtures modified).

## Verdict summary

The sub-agent accounting is structurally sound — `inflightTasks` is a `Set<toolCallId>`, so it
**cannot go negative and is immune to duplicate-start / unmatched-complete underflow** (the first
pass's negativity worry is REFUTED). The two real holes are both CONFIRMED with fresh evidence: (a)
the eviction/unload/reload guards still ignore `activeSubagents`/`awaitingChoice`, so the watchdog
can evict an idle-but-working session and let a pending graceful restart kill its background
sub-agents (the count→0 also never reaches the client, leaving a stale badge); and (b) a `task`
that never emits completion leaks the count with no reaper — **observed in real logs (1 of 124
task starts has no matching `tool.execution_complete`)**. New: the **setModel *success* path**
desyncs `currentReasoningEffort`/`currentContextTier` on a reasoning→non-reasoning switch because
`undefined` patch fields are dropped by `JSON.stringify` — the same M1/T5 omission the first pass
only caught on the error-rollback path. `assertSdkContract()` still guards **zero** of the
per-session methods the Engine calls, and one of those calls (`enqueueUserMessage`) reaches a
method the SDK declares **`private`**.

---

## Verified findings

### F1 — CONFIRMED (High): eviction/unload/reload ignore in-flight sub-agents; busy-definition drift

The server's restart gate and the Engine's teardown guards use **two different definitions of
"busy"**:

`apps/server/src/index.ts:67-69`
```js
function sessionBusy(s){ return s.status === 'running' || awaitingChoice(s) || (s.activeSubagents ?? 0) > 0 || !!s.compacting; }
```

Engine eviction/heap/unload/reload guards, by contrast, gate only on status/idle/compacting/schedule:
- `engine.ts:456` — `…s.meta.status === 'idle' && !hasSchedule(s) && !s.meta.compacting…` (no `inflightTasks`/`awaitingChoice`)
- `engine.ts:516,519` — `…status === 'idle' && !s.meta.compacting` then `.filter((s) => !hasSchedule(s))` (same gap)
- `engine.ts:562` — `unload`: `if (st.meta.status === 'running') throw…` only
- `engine.ts:573` — `reload`: identical single check

A background `task` sub-agent **outlives its turn** (status returns to `idle` while it runs — the
documented reason `inflightTasks` exists, `engine.ts:62-66`). So `idle && activeSubagents>0` is an
expected state that every guard above treats as evictable. When `evict()` → `unloadState` runs,
`engine.ts:435,442` set `inflightTasks.clear()` + `activeSubagents = 0` and clear `ask/planRequest/
elicitation` (`:438-440`). That flips the server's `sessionBusy` to `false`, so a `restartPending`
process `exit(0)`s (`apps/server/src/index.ts:81`) and **kills the running background sub-agents** —
the exact failure `inflightTasks` was built to prevent — and drops the live tap so their work
vanishes from the view. The heap watchdog makes this fire automatically under memory pressure (when
long fleets are most likely).

**Fix.** Factor a single predicate in `packages/core` and consume it on both sides:
```ts
// engine.ts (export so apps/server reuses it instead of its own sessionBusy)
export function engineSessionBusy(st: SessionState): boolean {
  return st.meta.status === 'running'
    || hasPendingChoice(st.meta)
    || st.inflightTasks.size > 0
    || (st.meta.activeSubagents ?? 0) > 0
    || !!st.meta.compacting;
}
```
- `evictIfNeeded` victim filter (`:456`) and `checkHeapPressure` `idle`/`evictable` filters
  (`:516,519`): add `&& st.inflightTasks.size === 0 && !hasPendingChoice(st.meta)`.
- `unload` (`:562`) / `reload` (`:573`): refuse when `engineSessionBusy(st)`, not just `running`.
- Keep the heap "last resort" escape (`:526-531`) but extend it to sub-agent-busy sessions only
  above `HEAP_HARD_FRAC`, logged loudly — never under normal count-cap pressure.

### F2 — CONFIRMED (High, new evidence): a never-completing `task` leaks the count with no reaper

`trackSubagents` removes a tracked id only on a matching `tool.execution_complete`
(`engine.ts:800-802`); the only other removals are `abort`-event clear (`:803-804`), `cancel()`
clear (`:863`), and `unloadState` clear (`:435`). There is **no reconcile against the live stream
and no TTL**. If a `task` tool call starts but its completion event never arrives — sub-agent
process killed, tool hung — and the session is neither aborted nor unloaded, the id stays in
`inflightTasks` forever, pinning `activeSubagents ≥ 1` and **holding the graceful-restart gate open
indefinitely**.

Real-log evidence (60+ `~/.copilot/session-state/*/events.jsonl`):
```
task starts: 124  unique: 124
task starts with NO matching execution_complete: 1   (toolu_01Ts8UHDADBR1sA8PuF97RcS)
```
≈0.8% of task starts are "ghosts". Over a long-lived fleet that's a realistic stuck-gate.

**Fix.** Reconcile the set against truth periodically/where convenient rather than relying solely on
abort/unload:
- Cheapest: in the heap-watchdog tick (or a small interval), drop any `inflightTasks` id whose
  owning `task` row in the fold is already terminal (`toolMsg`/tool status !== running), and re-`patch`
  `activeSubagents` if it changed.
- Or assign each tracked id an enqueue timestamp and evict entries older than a generous TTL
  (minutes), logged. Either converts the leak from "permanent" to "self-healing".

### F3 — CONFIRMED + REFINED (Medium): `assertSdkContract()` guards bootstrap only; session surface fails silently — and one call is to a `private` SDK method

`assertSdkContract()` checks exactly seven **bootstrap/manager-construction** symbols
(`bootstrap.ts:48-56`) and **none** of the per-session methods the Engine calls every turn (full
gap table below). Most are declared optional in `sdk-types.ts` and called `?.`-and-swallowed, so a
renamed method becomes a **silent no-op**, not a fail-fast: `setModel` would patch the UI and never
switch (`engine.ts:884`), `respondPlan`/`respondElicitation` would drop the user's answer
(`:1686`/`:1713`, optional), `cancel` would not abort (`:852`), `scheduleRegistry.add/stop` would
silently fail (`:1339,:1356`).

New, stronger evidence than the first pass: cockpit's `removeQueued` calls
`st.sdk.enqueueUserMessage?.({prompt})` (`engine.ts:1731`), but in the 1.0.63 bundle that method is
**private**:
```
sdk/index.d.ts:13893:    private enqueueUserMessage;
```
`sdk-types.ts:31` re-declares it as a public optional method, so the `as any` boundary hides the
fact that cockpit reaches a private symbol — a routine minor SDK bump can rename/inline it with zero
type signal and `removeQueued` silently becomes a no-op (queue not rebuilt → survivors lost). Same
file confirms `getPendingQueuedMessages()` is `@deprecated` (`sdk/index.d.ts:14094-14096`, "Use
getPendingQueuedItems() instead").

**Fix.** Add a post-first-load self-check (e.g. in `loadSession` after `st.sdk` is set, once per
process) that asserts the presence of the **mutating** session methods and throws/logs loudly if
absent: `respondToUserInput`, `respondToExitPlanMode`, `respondToElicitation`, `abort`,
`model.switchTo`/`getCurrent`, `mode.get`/`set`, `history.compact`/`truncate`,
`scheduleRegistry.add`/`stop`, and the queue trio. At minimum, replace the silent `?.`-and-swallow on
those paths with an explicit "SDK method missing" error so a contract break is observable. Migrate
`removeQueued`/`syncQueue` off `getPendingQueuedMessages` (deprecated) and off the private
`enqueueUserMessage`.

### F4 — CONFIRMED (Medium): soft-delete leaves the SDK session resident; schedules/sub-agents orphaned

```js
// engine.ts:1253-1259
async deleteSession(sessionId, reason){
  const st = this.sessions.get(sessionId);
  try { st?.unsub?.(); } catch {}
  this.prefs.trashSession(sessionId, reason);
  this.sessions.delete(sessionId);
  this.emit({ type:'session/removed', sessionId });
}
```
`st.unsub()` only detaches cockpit's listeners — it does **not** null `st.sdk`, clear
`inflightTasks`, abort in-flight sub-agents, or clear the persistent schedule index. `trashSession`
(`prefs.ts:137`) only writes the trashed mark; unlike `forgetSession` (`prefs.ts:236-247`, used by
`purgeSession`) it does **not** `delete scheduledSessions[id]`. So a trashed session that had a
per-session schedule keeps its in-memory `ScheduleRegistry` timers firing `send()` inside the now
orphaned `SdkSession` — **invisible scheduled turns against a "deleted" session's workspace** — and
any background sub-agents keep running untracked. (Post-restart `loadScheduledSessions`,
`engine.ts:603-610`, is harmless because the id isn't in the map; the leak is pre-restart.)

**Fix.** Make soft-delete genuinely inert: `if (st) { this.unloadState(st); }` before
`sessions.delete`, and `this.prefs.setScheduleCount(sessionId, 0)` (clears the index key,
`prefs.ts:223-225`). Optionally refuse/last-warn a soft-delete while `engineSessionBusy(st)` (F1).

### F5 — CONFIRMED + REFINED (Medium): `removeQueued` is lossy and built on deprecated+private SDK shape

`engine.ts:1720-1734`: reads `getPendingQueuedMessages()` (deprecated, returns `string[]`), coerces
`String(x)`, calls `clearPendingMessages()` (clears the **entire** itemQueue), then re-enqueues only
the message survivors via the **private** `enqueueUserMessage`. Non-message queued items
(command/model-change/resume-pending) and message options other than `prompt` are destroyed; and
`syncQueue` (`:816`) already defends an object shape (`r.options?.prompt ?? r.prompt`) the two paths
disagree on. The `private`/`@deprecated` facts (F3) make this the most fragile mutating path.

**Fix.** Share one element-extractor with `syncQueue`, read `getPendingQueuedItems()`, and rebuild
**all** surviving items in their original kind/options — or use a positional SDK removal if exposed.

### F6 — REFUTED (negativity) / CONFIRMED-by-design (clear semantics): `inflightTasks` cannot underflow

`activeSubagents` is always `st.inflightTasks.size` (a `Set`), so it **cannot go negative**, a
duplicate `tool.execution_start` is idempotent (`Set.add`), and a `tool.execution_complete` for an
id not in the set is a harmless no-op (`Set.delete`). The "complete/abort without a matching start
→ negative" hypothesis is REFUTED structurally. The `abort` branch wholesale-clears (`:804`); this
is correct for turn-level aborts — confirmed by real logs (66 `abort` events, **all
`user_initiated`, 0 with `agentId`**). The SDK schema *permits* `agentId` on an `abort` event
(`sdk/index.d.ts:60-78`), so a hypothetical sub-agent-scoped abort would over-clear siblings, but
that is unobserved; note only.

---

## Subagent accounting conservation table

`inflightTasks: Set<string>` (toolCallId). Projected to `SessionMeta.activeSubagents` only when size
changes. Conservation = every `add` is eventually matched by a `delete`/`clear`.

| # | Site (file:line) | Mutation | Trigger | Emits patch? | Matched / leak path |
|---|---|---|---|---|---|
| 1 | engine.ts:144,338,1556 | `new Set()` | session built / loaded / new | n/a | init, balanced |
| 2 | engine.ts:374 (replay loop) | **none** (replay calls `foldEvent` only, not `trackSubagents`) | history replay on load | n/a | ✓ correct — a freshly loaded session starts at 0 (prior-process sub-agents are dead); on-disk ghost starts do **not** inflate the count |
| 3 | engine.ts:799 | `add(toolCallId)` | `tool.execution_start{toolName:'task'}` | yes (`:809`) | matched by #4 on normal completion |
| 4 | engine.ts:802 | `delete(toolCallId)` | any `tool.execution_complete` | yes if size changed | removes #3; non-task id no-op (safe) |
| 5 | engine.ts:804 | `clear()` | `abort` **event** | yes if non-empty | turn-level abort clears all (correct; 0/66 real aborts carried `agentId`) |
| 6 | engine.ts:863 | `clear()` | `cancel()` (user) | `:866` (silent, only if `hadTasks`) | mirrors #5 for cockpit-initiated abort |
| 7 | engine.ts:435 | `clear()` + `activeSubagents=0` (`:442`) | `unloadState` (unload/evict/reload) | **NO** — `evict` `:470` / `unload` `:564` emit `{loaded,status,attention}` **without** `activeSubagents` | server meta correct (snapshot reads 0); **client keeps a stale sub-agent badge** |
| — | — | (no site) | `task` start whose `tool.execution_complete` never arrives + no abort/unload | — | **LEAK (F2)** — pins count, holds restart gate; 1/124 in real logs |

Net: no underflow, no double-count; two real defects — the unload/evict **patch omits
`activeSubagents`** (stale client badge), and the **missing-completion leak** has no reaper.

---

## assertSdkContract coverage gap (used vs asserted)

**Asserted (7, bootstrap.ts:48-56):** `resolveAuthInfoFromToken`, `createLocalFeatureFlagService`,
`getAvailableModels`, `AutoModeSessionManager`, `internal`, `internal.LocalSessionManager`,
`internal.NoopTelemetryService`. All module-level construction symbols.

**Used-but-UNASSERTED** (called at runtime; a moved symbol either silently no-ops via `?.` or
throws mid-session — never fail-fast at boot):

| SDK symbol (call site) | sdk-types decl | Failure mode if moved | Severity |
|---|---|---|---|
| `manager.getSession` / `createSession` / `listSessions` / `deleteSession` | required | throws mid-call (not boot) | high |
| `session.send` (`engine.ts:843`) | required | throws | high |
| `session.respondToUserInput` (`:1676`) | required (`:26`) | throws | high |
| `session.respondToExitPlanMode?` | optional | **silent no-op** — drops plan answer | high |
| `session.respondToElicitation?` | optional | **silent no-op** — drops answer | high |
| `session.abort?` (`:852`) | optional | **silent no-op** — cancel doesn't cancel | high |
| `model.switchTo` / `getCurrent` (`:884,891`) | optional | **silent no-op** — UI patched, model unchanged | high |
| `mode.get` / `set` (`:391,…`) | optional | silent / throws in try | med |
| `history.compact` / `truncate` | optional | silent | med |
| `scheduleRegistry.add/addCron/addAt/stop` (`:1339,1356`) | optional | **silent** — schedule never created | high |
| `getPendingQueuedMessages` (`:816,1726`) | optional + **`@deprecated`** | silent → empty queue projection | med |
| `clearPendingMessages` (`:1730`) | optional | silent | med |
| `enqueueUserMessage` (`:1731`) | optional, but **`private` in SDK** | silent → `removeQueued` loses survivors | high |
| `sessionFs.sessionDatabase.getTodoStatus/getCurrentIntent` | optional | silent (todos best-effort) | low |
| `ensureMcpLoaded`/`getMcpServerSummaries`/`enable/disable/reloadMcpServers` | optional | silent | med |
| `ensureSkillsLoaded`/`enable/disable/isSkillDisabled/clearLoadedSkills` | optional | silent | low |

Conclusion: the guard covers the half of the surface that **already** fails loudly (constructors)
and skips the half that fails **silently** (mutating session methods) — exactly inverted from where
fail-fast is most valuable. `enqueueUserMessage` (private) and `getPendingQueuedMessages`
(deprecated) are the two symbols most likely to move in a minor bump.

---

## undefined-serialization / attention desync analysis

**Mechanism (confirmed end-to-end).** `patch()` builds `out = { ...fields }` and emits
`session/patch` (`engine.ts:1848,1861`). The SSE writer is `JSON.stringify(ev)`
(`apps/server/src/index.ts:39`), which **drops keys whose value is `undefined`**. The client merges
only the keys present: `const { type, ...patch } = ev; return { ...s, ...patch }`
(`apps/web/src/net/store.ts:236-238`). So any field set to `undefined` in a patch **never clears on
the client** — it retains its previous value until a full reconnect/snapshot.

**Which fields are exposed.** Optional-**non-nullable** `SessionMeta` fields (protocol
`index.ts:439-442`) cannot be cleared with `null` (zod would reject it) and so can only be "cleared"
to `undefined` — the trap. Enumerating the patch sites:

| Field | Nullable? | Patched-to-undefined site | Desync? |
|---|---|---|---|
| `attention` | **yes** (`.nullable()`) | `out.attention = att` (att may be `null`) | **No** — `null` serializes; attention clears correctly. First-pass "attention is single-source/safe" CONFIRMED. |
| `intent` | yes | `intent: null` on idle/cancel (`:713,866`) | No |
| `todo`/`planRequest`/`elicitation`/`ask` | yes | set to `null` | No |
| `currentReasoningEffort` | **no** | **setModel success** `:895` (`cur.reasoningEffort` is `undefined` on a non-reasoning model — SDK `getCurrent` returns `reasoningEffort?`); rollback `:900`; load `:415` | **YES** |
| `currentContextTier` | **no** | setModel success `:896`; rollback `:900`; load `:416` | **YES** |
| `currentMode` | no | rollback `:973` (prev usually defined); load `:417` if `mode.get()` failed | edge |
| `currentModelId` | no | load `:414` if `getCurrent` failed | edge |

**The concrete new desync (first pass missed it).** Switching from a reasoning model
(`reasoningEffort:'high'`) to a non-reasoning model: `model.getCurrent()` returns
`{modelId, reasoningEffort: undefined, contextTier: undefined}` →
`patch({ currentModelId, currentReasoningEffort: undefined, currentContextTier: undefined })`
(`engine.ts:893-897`) → those two keys dropped by `JSON.stringify` → the client keeps showing the
**stale `high` reasoning-effort / long-context badge** on a model that has neither. This is the
*success* path on a normal user action — broader than the first pass's L-finding, which only flagged
the error-rollback at `:899-901`. Server-side `st.meta` is correct (Object.assign copies the
`undefined`), so the truth/projection split is purely the wire omission — a direct breach of
"frontend is a pure projection".

**Root fix (ties to the cross-cutting M1/T5 fix).**
1. Protocol: make the model sub-fields explicitly clearable —
   `currentReasoningEffort: z.string().nullable().optional()`,
   `currentContextTier: ContextTier.nullable().optional()` (and consider `currentMode`/`currentModelId`).
2. Engine: emit `null` (not `undefined`) when clearing, e.g. at `:894-897`
   `currentReasoningEffort: cur.reasoningEffort ?? null, currentContextTier: cur.contextTier ?? null`,
   and likewise the load/rollback sites.
3. Belt-and-suspenders, kills the whole class: normalize in `patch()` before emit — for every key in
   `out` whose value is `undefined`, replace with `null` (requires the corresponding field to be
   nullable in the protocol). One change at `engine.ts:1848` closes every future occurrence.

---

## New findings (adjacent, missed by first pass)

- **N1 (High).** setModel **success-path** desync of `currentReasoningEffort`/`currentContextTier`
  (above). First pass caught only the error-rollback variant.
- **N2 (High).** `enqueueUserMessage` is a **private** SDK method (`sdk/index.d.ts:13893`) yet
  `removeQueued` calls it through the `as any` boundary (`engine.ts:1731`) — no type signal on a
  minor bump.
- **N3 (Medium, real-data).** The missing-completion leak (F2) is not just theoretical: **1 of 124**
  real task starts has no terminal event. No reaper exists.
- **N4 (Low).** `projectButlerMeta` is **set-only** (`engine.ts:1396,1398`): `if (spawnedBy)` /
  `if (n > 0)`. On reload of the same `SessionState` (reload reuses `st`; `unloadState` does not
  clear `hookCount`/`spawnedBy`/`scheduleCount`), a `hookCount` that dropped to 0 while the session
  was unloaded is **not reconciled to 0** by `projectButlerMeta` — only the live `refreshHookCount`
  path (`:1635`, which does send 0) covers it. Make `projectButlerMeta` assign the resolved value
  unconditionally (including 0/absent) so the lifecycle-edge projection is authoritative.
- **N5 (Low).** `evict()`/`unload()` emit `attention: null` directly (bypassing `patch()`), which is
  correct, but they also omit `activeSubagents`, `intent`, `compacting`, `queue` from the wire patch
  even though `unloadState` cleared them in `st.meta`. The client thus keeps stale
  sub-agent/intent/queue projections after an eviction until reconnect. Include the cleared fields in
  the emitted patch (or route eviction through `patch()` with the full cleared set).

---

## Recommended fix order

1. **F1** — single `engineSessionBusy` predicate shared by `apps/server` + Engine eviction/unload/
   reload guards. Highest blast radius (kills live background fleets under memory pressure) and
   removes the duplicated "busy" definition for good.
2. **N1 / undefined-serialization** — protocol `.nullable()` on `currentReasoningEffort`/
   `currentContextTier` + emit `null`, plus the `patch()` undefined→null normalizer. Visible bug on a
   routine action; the normalizer closes the whole T5 class.
3. **F4** — make soft-delete inert (`unloadState` + `setScheduleCount(id, 0)`). Prevents invisible
   scheduled turns against "deleted" sessions.
4. **F2 / N3** — add a reconcile/TTL reaper for `inflightTasks` so a ghost task can't pin the restart
   gate forever.
5. **F3 / N2** — extend the contract self-check to the mutating session-method surface (post-first-
   load), and make the `?.`-and-swallow mutating paths surface an error; migrate off the private
   `enqueueUserMessage` and deprecated `getPendingQueuedMessages`.
6. **F5** — rebuild `removeQueued` on `getPendingQueuedItems()` preserving all item kinds/options.
7. **N4 / N5** — make `projectButlerMeta` authoritative (clear-to-0) and have eviction/unload echo all
   cleared fields in the wire patch (stale-badge cleanup).
