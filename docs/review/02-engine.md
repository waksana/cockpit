# Module 2 — Core Engine & SDK bootstrap

Scope reviewed (only): `packages/core/src/engine.ts`, `bootstrap.ts`,
`sdk-types.ts`, `index.ts`. Read in full; fold treated as a boundary (not
deep-reviewed). SDK runtime shapes spot-checked against the installed
`@github/copilot@1.0.63` bundle; `pnpm --filter @cockpit/core test` run read-only
(137 pass).

## Summary

The Engine is well-structured and the load-bearing invariants are mostly honored:
a per-session load mutex, a single fold path for live==replay, attention derived
in exactly one place, and SDK calls wrapped so failures surface as session errors
rather than crashes. The biggest real risk is a **consistency gap between the
eviction/unload path and the graceful-restart "busy" definition**: eviction and
manual unload/reload gate only on `status==='running'` and ignore
`activeSubagents > 0`, so an *idle session with in-flight background sub-agents*
can be evicted — zeroing `activeSubagents`, which can let a pending graceful
restart fire and kill that background work (the exact failure `inflightTasks` was
built to prevent). Secondary risks are the shallowness of `assertSdkContract()`
(it guards bootstrap symbols but the per-session method surface fails *silently*),
an orphaned-SDK-session leak on soft-delete, and a brittle/lossy `removeQueued`.
Engine.ts itself has **no direct test coverage**.

## Findings

### [High] Eviction / unload / reload ignore in-flight background sub-agents (`activeSubagents`) — `engine.ts:452-471, 508-555, 559-565, 570-580`

- **What.** The graceful-restart gate (server `sessionBusy`, `apps/server/src/index.ts:67-68`)
  treats a session as busy when `status==='running' || awaitingChoice || activeSubagents>0 || compacting`.
  The Engine's eviction and lifecycle guards do **not** match this:
  - `evictIfNeeded` victims: `status==='idle' && !hasSchedule && !compacting` (`engine.ts:456`) — no `inflightTasks`/`activeSubagents` check.
  - `checkHeapPressure` candidates: `status==='idle' && !compacting` then `!hasSchedule` (`engine.ts:516, 519`) — same gap.
  - `unload()` refuses only `status==='running'` (`engine.ts:562`); `reload()` the same (`engine.ts:573`).
  Per the design (runtime.md, and `SessionState.inflightTasks` comment at `engine.ts:62-66`), a background
  `task` sub-agent **outlives its spawning turn — status returns to `idle` while it runs**. So
  `idle && activeSubagents>0` is a documented, expected state, and it is fully evictable here.
- **Why it matters.** When the count-cap or heap watchdog evicts such a session, `unloadState`
  clears `inflightTasks` and sets `activeSubagents=0` (`engine.ts:435, 442`). That (a) opens the
  graceful-restart gate, so a `restartPending` server can `process.exit(0)` and **kill the running
  background sub-agents** — defeating the very invariant the `inflightTasks` machinery exists to
  protect; and (b) drops the live tap, so the sub-agents' events are no longer folded/emitted and
  their in-flight work is lost from the live view. The automatic watchdog makes this fire without
  any user action, precisely under memory pressure (when long fleets are most likely). Manual
  `unload`/`reload` have the same hole if the user acts on an idle-but-working session.
  Additionally, `evict()` emits a partial patch (`{loaded, status, attention}` only, `engine.ts:470`)
  and never echoes `activeSubagents:0`, so clients keep a stale sub-agent badge after eviction.
- **Recommendation.** Make the Engine's "busy" test the single source of truth and reuse it
  everywhere a session may be torn down: exclude `(st.inflightTasks.size>0 || (st.meta.activeSubagents??0)>0)`
  (and `awaitingChoice`) from eviction victim selection, and refuse `unload`/`reload` for those
  sessions, mirroring `sessionBusy`. Factor a shared `engineSessionBusy(st)` helper so the gate
  and the eviction path cannot drift again.

### [Medium] `assertSdkContract()` guards bootstrap only; per-session SDK methods fail silently, not fast — `bootstrap.ts:47-65`, `engine.ts` (many `?.` call sites)

- **What.** `assertSdkContract()` checks 7 bootstrap/manager symbols
  (`resolveAuthInfoFromToken`, `createLocalFeatureFlagService`, `getAvailableModels`,
  `AutoModeSessionManager`, `internal(.LocalSessionManager/.NoopTelemetryService)`). It does **not**
  check any of the *per-session* methods the Engine depends on at runtime: `respondToUserInput`,
  `respondToExitPlanMode`, `respondToElicitation`, `abort`, `model.switchTo`/`getCurrent`,
  `history.compact`/`truncate`, `mode.get`/`set`, `scheduleRegistry.*`, `getPendingQueuedMessages`,
  `enqueueUserMessage`, `clearPendingMessages`, `ensureMcpLoaded`, etc. In `sdk-types.ts` almost all
  of these are declared optional (`?`), and in the Engine they're called with optional chaining
  inside swallowing `try/catch` (e.g. `respondAsk` `engine.ts:1676`, `setModel` `engine.ts:884`,
  `cancel` `engine.ts:852`, `addSchedule` `engine.ts:1328`).
- **Why it matters.** The stated design (skill + `bootstrap.ts:42-46`) is **fail-fast at boot** so an
  SDK upgrade that moves a symbol throws a clear message instead of breaking mid-session. That holds
  for the manager-construction half, but for the larger session-method half a moved/renamed method
  becomes a **silent no-op**: `setModel` would patch the UI optimistically and never switch;
  `respondAsk`/`respondPlan` would drop the user's answer; `cancel` would not abort. None of these
  surface an error. This is the most fragile coupling in the module (undocumented internals) and it
  is exactly where the guard is thin.
- **Recommendation.** After the first real session loads (or in a lightweight boot self-check),
  assert the presence of the key session methods on a live `SdkSession` and throw/log loudly if any
  expected one is absent. At minimum, replace the silent `?.`-and-swallow on the *mutating* paths
  (`respond*`, `model.switchTo`, `abort`, `scheduleRegistry`) with an explicit "SDK method missing"
  error so a contract break is observable rather than a quiet behavioral regression.

### [Medium] Soft-delete leaves the SDK session resident (schedules/sub-agents keep running orphaned) — `engine.ts:1253-1259`

- **What.** `deleteSession` (the soft/trash path) only does `st?.unsub?.()` then removes the entry
  from the map and emits `session/removed`. It does **not** call `unloadState`, never nulls/teardowns
  `st.sdk`, does not clear `inflightTasks`, and does not clear the persistent scheduled-sessions
  index (`prefs.setScheduleCount`). `purgeSession` (`engine.ts:1663`) properly calls
  `manager.deleteSession`, but soft-delete does not.
- **Why it matters.** If the trashed session had an active per-session schedule, its in-memory SDK
  `ScheduleRegistry` timers live inside the now-orphaned `SdkSession`; with cockpit's live tap removed
  but the SDK object still timer-rooted, those timers keep firing `send()` — running **invisible
  scheduled turns against the workspace of a "deleted" session**. Likewise any in-flight background
  sub-agents keep running untracked, and because the session is gone from the map the restart gate no
  longer counts it as busy. (On the next process restart `loadScheduledSessions` is harmless — the
  trashed id isn't in the map — but pre-restart the leak persists.)
- **Recommendation.** On soft-delete, first stop the session's schedules and fully `unloadState`
  (drop the SDK handle, clear `inflightTasks`), and clear the scheduled-sessions index for the id,
  so a trashed session is genuinely inert. Consider refusing/last-warning a soft-delete while the
  session is busy (running / awaiting choice / sub-agents in flight), consistent with the gate.

### [Medium] `removeQueued` is brittle and lossy; depends on a deprecated SDK shape — `engine.ts:1720-1734` (cf. `syncQueue` `engine.ts:813-826`)

- **What.** `removeQueued` reads `getPendingQueuedMessages()`, coerces each entry with `String(x)`,
  calls `clearPendingMessages()`, then re-enqueues the survivors via `enqueueUserMessage({prompt})`.
  Two problems: (1) `clearPendingMessages()` clears the **entire** itemQueue (verified in the
  1.0.63 bundle: `clearPendingMessages(){this.clearPendingItems()}` → `itemQueue.length=0`), but
  only the *message-kind* survivors are re-enqueued — any queued non-message items
  (`QueuedCommandItem`/`QueuedModelChangeItem`/`QueuedResumePendingItem`, per the SDK's
  `QueuedItem` union) are silently destroyed, and message options other than `prompt`
  (`displayPrompt`, `source`, `mode`, …) are stripped on rebuild. (2) `getPendingQueuedMessages()`
  is **`@deprecated`** in the SDK `.d.ts` (superseded by `getPendingQueuedItems()`); it returns
  `string[]` *today* (so `String(x)` is a no-op), but `syncQueue` already defends against an
  object shape (`r.options?.prompt ?? r.prompt`), so the two paths disagree about the element type.
  If a future SDK changes `getPendingQueuedMessages` to the items shape, `String(x)` would corrupt
  every survivor to `"[object Object]"`.
- **Why it matters.** Removing one queued prompt can drop unrelated queued state and strip metadata;
  the divergent assumptions between `syncQueue` and `removeQueued` are a latent corruption waiting on
  an SDK bump. Cockpit's own composer only enqueues plain messages, so today's blast radius is
  limited, but `resume_pending`/model-change items can originate SDK-side.
- **Recommendation.** Extract the queue element with the same logic `syncQueue` uses (single shared
  helper), prefer the non-deprecated `getPendingQueuedItems()`, and rebuild by re-enqueuing *all*
  surviving items in their original kind/options rather than message-prompts only — or, better, use
  a positional-aware SDK removal if one exists, to avoid the clear-and-rebuild entirely.

### [Low] Optimistic rollbacks that revert a field to `undefined` never reach the client — `engine.ts:899-901` (also `setMode`/`rename` patterns)

- **What.** `setModel`'s error path does `this.patch(st, { ...prev, error })` where `prev` may carry
  `currentReasoningEffort: undefined`/`currentContextTier: undefined`. `patch` forwards `{...fields}`,
  but `JSON.stringify` drops `undefined`-valued keys, so the revert of those fields is not sent.
- **Why it matters.** The client keeps the optimistic (non-undefined) value while the server reverts
  to `undefined` → a server/client desync, a small breach of the "frontend is a pure projection"
  invariant on this edge. Fields that revert to a defined value (`currentMode`, `title`) are fine.
- **Recommendation.** For nullable fields, revert to an explicit `null` (which serializes) rather
  than `undefined`, or include a sentinel so the projection can clear them.

### [Low] `prompt` sets `status:'running'` optimistically with no rollback unless `send()` rejects; `queued` can mislabel — `engine.ts:828-847`

- **What.** `prompt` patches `status:'running'` then fire-and-forgets `send()`. The only rollback is
  the `.catch` on an outright `send()` rejection. If an enqueued turn is accepted but never starts
  (no `assistant.turn_start`/`session.idle`), the session is pinned `running` until a manual
  `cancel`. Separately, `queued = status==='running'` is computed even when the caller passes
  `mode:'immediate'` (which interrupts rather than queues), so the returned `queued` flag can be wrong.
- **Why it matters.** Both are recoverable and low-probability (the SDK reliably starts an enqueued
  turn), but a stuck-`running` projection is the class of bug cockpit is designed to avoid, and the
  authoritative transition really comes from the SDK events — the optimistic flip is the only
  un-reconciled write.
- **Recommendation.** Rely on `assistant.turn_start` for the running transition (or add a watchdog
  that clears a never-started optimistic `running`), and derive `queued` from the actual
  accept/enqueue result rather than pre-send status.

### [Low] Positional queue ids (`q-<i>`) race against a mutating queue — `engine.ts:817, 1723-1728`

- **What.** `syncQueue` labels items `id: q-<index>`; `removeQueued` parses the index and removes by
  position. If the running turn dequeues the head (or another enqueue lands) between the client
  seeing the projection and the `queue/remove` intent arriving, the index now points at a different
  message.
- **Why it matters.** A user can delete the wrong queued message under normal concurrency. The SDK
  exposes no stable per-item id, so position is the only handle — but it is inherently racy.
- **Recommendation.** Match on content+position or re-validate the target text before removal; at
  minimum document the race. (Partly subsumed by the `removeQueued` rework above.)

### [Low] `refreshList` adds but never removes externally-deleted sessions — `engine.ts:292-306`

- **What.** The 8s reconcile only emits `session/added` for newcomers; a session deleted by an
  external terminal CLI is never pruned from the in-memory map.
- **Why it matters.** It lingers as `unloaded`; opening it triggers a load that fails ("session not
  found"). Minor, single-operator edge.
- **Recommendation.** Diff the listing and emit `session/removed` for ids that disappeared (guarding
  against trashed/just-created ones).

No Critical findings.

## Test coverage assessment

- **`engine.ts` (1889 lines) has zero direct unit tests.** The 137 passing core tests exercise only
  the helpers it composes (`attention`, `memory`, `prefs`, `hooks`, `flows`, `flow-schedule`,
  `mcp-config`, `fold`). The orchestration logic — the riskiest part — is untested.
- Highest-value gaps to cover with a fake `SdkSessionManager`/`SdkSession` (the seams are already
  clean — the Engine takes a manager and folds events):
  - Lifecycle: `ensureLoaded` mutex (concurrent callers load once), `loadSession` status/error
    broadcast, `unload`/`reload`/`evict` state transitions, and **eviction victim selection vs
    `activeSubagents`/`hasSchedule`/`compacting`** (would have caught the High finding).
  - Turn: `prompt` fire-and-forget acceptance + `queued` semantics; `cancel` → `resetTurn` +
    `inflightTasks.clear` + silent idle; `trackSubagents` add/remove/abort accounting.
  - `patch()`/attention edge cases (running→idle ready, choice escalation, worker silence,
    undefined-field serialization) and `markSeen` water-line.
  - `syncQueue`/`removeQueued` round-trip (including non-message queue items).
  - `planSupersede` → `restorePlanOnIdle` restore-on-idle; `refreshScheduleCount` index sync.
- `getMeta`/`listLive`/`snapshot` are pure projections and cheap to assert.

## Positive notes

- Per-session load mutex (`loadPromise`, `engine.ts:348-359`) and the single fold path for replay +
  live (`loadSession`/`onLive`) cleanly preserve the live==replay invariant at the Engine boundary.
- Attention is derived in exactly one place (`patch()`), with workers forced silent and a monotonic
  `attnId`/`seenId` water-line — a faithful single-source design.
- `inflightTasks` cleared on `abort` and unload (`cancel` `engine.ts:862-863`) correctly avoids the
  "background sub-agent never emits completion" leak — good reasoning, just not applied to eviction
  (the High finding).
- The compaction handler's deliberate **no-reload** (`engine.ts:741-755`) with a clear rationale
  (append-only log; avoid the "twin" second live session) is exactly right and well documented.
- `redactMcpConfig` (`engine.ts:102-112`) masks env/header values before they reach the client.
- `assertSdkContract()` + `ensureAgentDefinitions()` + `autoModeManager` are sound, idempotent, and
  re-applied each boot; the version is pinned consistently (`bootstrap.ts:24` == package pin 1.0.63).
- The adaptive heap watchdog (fast/slow cadence, hard-ceiling last-resort, `--expose-gc` confirmed in
  the systemd unit) is a thoughtful OOM safety valve.

## Cross-cutting (note only — not this module's scope)

- **Ephemeral choices vs durability:** ask/plan/elicitation requests are not written to
  `events.jsonl`, so a *hard* crash (e.g. OOM) loses any pending choice on reload; the graceful
  restart gate (`apps/server`) covers the orderly case but not a fatal abort. (Module 5/server.)
- **Restart-gate vs Engine "busy" drift:** the High finding is fundamentally a duplicated definition
  of "busy" living in two modules (`apps/server/src/index.ts:67` and the Engine's eviction filters).
  A shared predicate in `packages/core` consumed by both would prevent recurrence. (Modules 2+5.)
- **SDK-internal coupling** remains the structural liability (per the plan's SDK strategy); this
  review reinforces that the *session-method* surface, not just bootstrap, needs contract coverage
  before any SDK bump. (Project-wide.)
- **No intent idempotency:** `prompt` has no dedupe key, so a transport-level retry double-sends a
  turn. (Protocol/server.)
