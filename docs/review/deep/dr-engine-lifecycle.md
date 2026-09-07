# Deep: Engine lifecycle & eviction

Scope: `packages/core/src/engine.ts` (eviction / heap watchdog / unload / reload /
unloadState / trackSubagents / cancel / compact) vs `apps/server/src/index.ts`
graceful-restart gate (`sessionBusy`/`busyCount`/`maybeGracefulExit`). Verified
against the installed SDK bundle (`@github/copilot@1.0.63`,
`node_modules/.pnpm/@github+copilot@1.0.63_.../sdk/index.js`) and 44 real
`events.jsonl` session logs under `~/.copilot/session-state/`. `pnpm --filter
@cockpit/core test` re-run read-only: **137 pass**. No source edited.

## Verdict summary

The first-pass High finding is **substantially REFUTED at the level that made it
High**: its load-bearing premise — that a background `task` sub-agent leaves the
session **idle** while it runs — is contradicted by the SDK contract. The SDK
explicitly **defers `session.idle` while any background agent is running**
(`idleDeferredByBackgroundWork` / `hasActiveBackgroundWork()` →
`hasRunningAgents()`), so cockpit's `status` stays `'running'` for the entire life
of a background sub-agent, and **`idle && activeSubagents>0` is not reachable via
the natural lifecycle**. Eviction's `status==='idle'` filter therefore already
excludes such sessions, and the "eviction zeroes `activeSubagents` → graceful
restart `process.exit(0)` kills live background work" catastrophe cannot occur
today. The first-pass's *code observations* are accurate (the eviction / unload /
reload guards do not consult `activeSubagents`/`inflightTasks`, and `evict()`
emits a partial patch), but their danger is currently **masked** by an implicit,
undocumented invariant ("status stays `running` while sub-agents or choices are
live"). The genuinely actionable residue is (1) a **latent fragility** — the
eviction safety silently depends on that SDK timing guarantee — and (2) a **new,
real divergence the first pass missed: `unload()`/`reload()` do not guard
`compacting`**, unlike both eviction and the server gate. Net: keep the
recommended shared-predicate refactor, but as defense-in-depth + a `compacting`
fix, and **downgrade the finding from High to Low/Medium**.

## Verified findings

The first-pass High decomposes into four sub-claims. Verdicts:

### (a) "idle && activeSubagents>0 is reachable — a background task sub-agent keeps the session idle while running" — **REFUTED**

This is the premise the whole High rests on, and it is false for the current SDK.

**Engine side — `status` only leaves `running` on `session.idle`/cancel/unload.**
`status` is set `'running'` on `assistant.turn_start` and returns to `'idle'`
*only* on the `session.idle` event (or `cancel`, or `unloadState`). There is no
handler that idles the session on `assistant.turn_end`:

```ts
// engine.ts:702-713
if (ev.type === 'assistant.turn_start') {
  if (st.meta.status !== 'running') this.patch(st, { status: 'running', error: null });
  ...
}
if (ev.type === 'session.idle') {
  this.patch(st, { status: 'idle', intent: null });
```

So `idle && activeSubagents>0` requires the SDK to emit `session.idle` while a
`task` sub-agent is still tracked in `st.inflightTasks`.

**SDK side — `session.idle` is contractually emitted only when no background agent
is in flight, and is actively *deferred* otherwise.** The event schema:

```js
// sdk/index.js (session.idle schema)  type:"session.idle", ephemeral:true
.describe("Payload indicating the session is idle with no background agents or attached shell commands in flight")
```

And the emit path defers idle when background work exists:

```js
// sdk/index.js  (agentic-loop completion)
... this.hasActiveBackgroundWork()
      ? (this.idleDeferredByBackgroundWork = true, this.idleDeferredAborted = e, this.notifyBackgroundTaskChange())
      : this.emitSessionIdle(e)
// hasActiveBackgroundWork(){ return this.hasRunningAgents() ? true : ... hasRunningAttachedCommands() }
// hasRunningAgents(){ return this.taskRegistry.list({includeCompleted:false})
//                       .some(e => e.type==="agent" && e.status==="running") }
// emitDeferredSessionIdleIfReady(){ if(!(!this.idleDeferredByBackgroundWork || this.isProcessing
//                       || this.hasActiveBackgroundWork())){ ... } }
```

`hasRunningAgents()` is exactly the `task`-spawned sub-agent set. So while a
background sub-agent runs, `session.idle` is withheld → cockpit `status` stays
`'running'`. A pending **choice** (`ask_user`/`exit_plan_mode`/`elicitation`) is
likewise an in-flight tool call, so the loop is still processing and `session.idle`
does not fire — the engine's onAsk/onPlanRequest/onElicitation listeners set
`ask/planRequest/elicitation` but never touch `status` (`engine.ts:628-666,
695-700`). This matches the engine's own comment that a choice "is raised while
status stays running."

**Real-log corroboration.** Across the 44 persisted `events.jsonl` logs there are
**79 `mode:"background"` `task` invocations**; pairing each `task`
`tool.execution_start` with its `tool.execution_complete` by `toolCallId` and
counting `assistant.turn_start`/`turn_end` events strictly between them yields
**0 turn-boundary crossings** — in every recorded case the spawning turn stayed
open until the sub-agent finished. The completes are *staggered and track actual
sub-agent completion* (not an immediate handle-return), e.g. session `96c3db7a`:

```
395-400 tool.execution_start (task) ×6   ← 6 background tasks spawned
401-406 subagent.started ×6
409,415,418,421,424,427 tool.execution_complete ×6   ← staggered, real completions
437 assistant.turn_end                    ← turn ends AFTER all six complete
```

(`session.idle` itself is **live-only/ephemeral and never persisted** — 0
occurrences in any log — which is why it cannot be observed here directly; the SDK
contract above is the authority.)

**Reload cannot create the state either:** `loadSession` replays history through
`foldEvent` *directly* (`engine.ts:372-376`), never `trackSubagents`, and
`unloadState`/new-session start with an empty `inflightTasks` — so a freshly
(re)loaded session is `status:'idle'` with `activeSubagents:0` regardless of
history.

→ **REFUTED.** The only way to reach `idle && activeSubagents>0` is a *stale/leaked
count* (a `tool.execution_complete` dropped without an `abort`), and in that state
the sub-agent has already finished — there is no live work to kill, and clearing
the stale count is in fact beneficial (it is exactly the leak that would otherwise
pin the restart gate open forever; `cancel`/`unloadState` already clear it).

### (b) "eviction / unload / reload gate only on status and ignore activeSubagents" — **CONFIRMED (code fact) / REFINED (impact: currently masked)**

The literal code observation is correct:

```ts
// engine.ts:455-456  evictIfNeeded victim filter
.filter((s) => s.meta.sessionId !== keepId && s.meta.status === 'idle' && !hasSchedule(s) && !s.meta.compacting)
// engine.ts:516,519  checkHeapPressure candidate filter
const idle = [...].filter((s) => s.materialized && s.sdk && s.meta.status === 'idle' && !s.meta.compacting);
const evictable = idle.filter((s) => !hasSchedule(s)) ...
// engine.ts:562  unload guard      // engine.ts:573  reload guard
if (st.meta.status === 'running') throw new Error('运行中,无法卸载');
if (st.meta.status === 'running') throw new Error('运行中,无法重载');
```

None reference `inflightTasks`/`activeSubagents`. **But** because of (a) the
omission is *masked*: a session with genuinely-live background sub-agents has
`status==='running'`, so the eviction `status==='idle'` filter excludes it and the
unload/reload `status==='running'` refusal blocks it. The three non-status
server-gate conditions are all covered transitively *today*:

| Server-gate busy condition | How eviction/`status` covers it today |
| --- | --- |
| `status==='running'` | direct |
| `awaitingChoice` | choice = in-flight tool call ⇒ status stays `running` (not idle) |
| `activeSubagents>0` | SDK defers `session.idle` ⇒ status stays `running` (proof (a)) |
| `compacting` (auto) | auto-compaction runs mid-turn ⇒ status `running` |
| `compacting` (manual) | status is **idle** ⇒ only the explicit `!s.meta.compacting` saves it (eviction has it; **unload/reload do NOT** — see New finding 1) |

→ The eviction filter is **safe today**, but only by relying on the implicit
invariant "status stays `running` while sub-agents/choices are live," which is an
SDK guarantee cockpit never asserts. If a future SDK emits `session.idle` while a
background agent runs, or cockpit ever keys `status` off `assistant.turn_end`, the
eviction path silently becomes the bug the first pass described. Severity of the
*omission* is **Low** (latent), not High.

### (c) "unloadState zeroes the count and the server restart gate can then fire" — **CONFIRMED (mechanics) but the dangerous trigger is unreachable**

Mechanically true:

```ts
// engine.ts:435,442  unloadState
st.inflightTasks.clear(); ... st.meta.activeSubagents = 0;
// apps/server/src/index.ts:67-69  sessionBusy reads activeSubagents
return s.status === 'running' || awaitingChoice(s) || (s.activeSubagents ?? 0) > 0 || !!s.compacting;
// index.ts:75-82  maybeGracefulExit → busyCount()===0 ⇒ setTimeout(()=>process.exit(0),500)
```

So eviction *does* zero the count and the gate *does* read it. But per (a) the
precondition — an **idle** session carrying **genuinely-live** sub-agents — is not
reachable, so eviction never zeroes a *live* count. (Note the server gate is read
off `engine.snapshot()`, i.e. in-memory `st.meta`, so after eviction the snapshot
already reflects `activeSubagents:0` — the projection and gate agree.) The
catastrophic outcome the first pass describes does not occur in current operation.

### (d) "evict emits a partial patch that leaves a stale sub-agent badge" — **REFINED (partial patch real; no stale badge in practice)**

```ts
// engine.ts:470  evict()
this.emit({ type: 'session/patch', sessionId: st.meta.sessionId, loaded: false, status: 'unloaded', attention: null });
// engine.ts:564  unload() — same omission of activeSubagents
```

The frontend applies `session/patch` as a **field-merge**
(`apps/web/src/net/store.ts:236-238`: `return { ...s, ...patch }`), so an omitted
`activeSubagents` is *not* reset. The first pass is right that the patch is
incomplete. However, because an evictable session is idle, its projected
`activeSubagents` is **already 0** (proof (a)), so no stale badge actually
materializes. This is a **robustness gap, not an active bug** — it would only bite
if `activeSubagents` could be non-zero at eviction (future SDK change or the
leaked-count edge). Cheap to close by having `unloadState`'s callers echo
`activeSubagents:0` (or emit a fuller patch).

## New findings

### N1 — [Low/Medium] `unload()`/`reload()` do not guard `compacting`; divergent from both eviction and the server gate (`engine.ts:562, 573` vs `932-943`)

Manual compaction sets `compacting=true` while **`status` stays `'idle'`** — by
design and explicitly commented:

```ts
// engine.ts:928-929
// Manual compaction is NOT a turn (status stays 'idle' — the SDK never emits
// session.idle for it), so the compacting flag is what the UI and restart gate key off.
// engine.ts:936-942
this.patch(st, { compacting: true });
try { await st.sdk?.history?.compact(...); } finally { this.patch(st, { compacting: false }); }
```

Both the heap/count eviction filters (`!s.meta.compacting`, `engine.ts:456, 516`)
and the server gate (`!!s.compacting`, `index.ts:68`) treat this as busy. But
`unload()`/`reload()` refuse **only** `status==='running'`, so a session in manual
compaction (`status:'idle', compacting:true`) is freely unloadable/reloadable —
via the UI, the cockpit MCP `cockpit_unload_session`/`cockpit_reload_session`, or
`rewind()` which calls `reload()` internally (`engine.ts:956`). Consequences:
`unloadState` drops the live SDK handle and flips `compacting:false` mid-operation,
and — because it clears the only remaining busy signal — a **pending graceful
restart can now fire and `process.exit(0)` during an in-flight manual compaction**,
discarding that compaction's work. Impact is bounded (the SDK event log is
append-only, so it reloads cleanly — only the compaction effort is wasted), hence
Low/Medium, but it is a *real* present-day divergence in the "busy" definition that
the first pass did not flag. The shared predicate (below) fixes it for free.

### N2 — [Note] The gate's `activeSubagents>0` clause is, given the SDK defer, almost entirely redundant — and that should be documented

Because the SDK defers `session.idle` until `hasRunningAgents()` is false,
`activeSubagents>0` essentially never holds independently of `status==='running'`.
Its only *independent* trigger is a stale/leaked count (status idle, completion
dropped) — which is precisely a leak the code already neutralizes by clearing
`inflightTasks` on `abort` (`engine.ts:862-863`) and `unloadState`
(`engine.ts:435`). The practically load-bearing protection for background
sub-agents is therefore `status==='running'`, *not* `activeSubagents`. This is
worth a one-line comment so a future maintainer doesn't "simplify" the gate by
removing the `status` term trusting `activeSubagents`, nor treat `activeSubagents`
as the primary guard. (It also means the `inflightTasks` machinery's main present
value is the **projection/badge** and leak-safety, not gate correctness.)

## Demonstration (what I traced/ran)

1. **Engine status state-machine** read end-to-end: `status` ← `running` only at
   `assistant.turn_start` (`engine.ts:703`), ← `idle` only at `session.idle`
   (`713`), `cancel` (`866`), `unloadState` (`437`). Choice listeners never set
   status (`628-666`). `loadSession` replays via `foldEvent`, not `trackSubagents`
   (`372-376`).
2. **SDK contract** extracted from the 1.0.63 bundle: `session.idle` schema
   description ("…idle with no background agents or attached shell commands in
   flight"); the deferral branch
   (`hasActiveBackgroundWork() ? idleDeferredByBackgroundWork=true : emitSessionIdle()`);
   `hasActiveBackgroundWork()`→`hasRunningAgents()`→`taskRegistry.list({includeCompleted:false}).some(agent && status==="running")`;
   `emitDeferredSessionIdleIfReady()`.
3. **Real-log scan** (throwaway Python over `~/.copilot/session-state/*/events.jsonl`,
   since deleted): 79 background `task` calls, **0** with a turn boundary between
   start and complete; dumped session `96c3db7a` showing 6 background tasks
   completing *before* `assistant.turn_end`; confirmed `session.idle` is never
   persisted (ephemeral).
4. **Frontend merge** confirmed: `store.ts:236-238` `{ ...s, ...patch }` (partial
   patch does not reset omitted fields).
5. **Server gate** confirmed to already include `activeSubagents` *and* `compacting`
   (`index.ts:67-69`), re-evaluated on every `session/patch`/`session/removed`
   (`index.ts:93-104`).
6. `pnpm --filter @cockpit/core test` → 137 pass (baseline, unchanged).

## Recommended fix

The fix is still worth doing — not to stop an active data-loss bug, but to (i) kill
the **duplicated, already-divergent** "busy" definition (server vs eviction vs
unload/reload), (ii) close the **`compacting` hole in unload/reload** (N1), and
(iii) make the eviction safety *explicit* rather than dependent on an undocumented
SDK timing guarantee. Keep `status==='running'` as a term (N2) — do not replace it.

### Shared predicate (single source of truth in `packages/core`)

Define one predicate over the projected `SessionMeta` fields (so the server, which
only has a `SessionMeta` snapshot, can consume the same function), and have the
engine additionally OR its authoritative in-memory `inflightTasks`:

```ts
// packages/core/src/lifecycle.ts (new, pure + unit-testable)
import type { SessionMeta } from '@cockpit/protocol';

// A session is "busy" — must not be evicted, unloaded, reloaded, or restarted —
// when any of: a turn is running; it is paused on a required user choice; it has
// an in-flight background `task` sub-agent (status stays 'running' during these
// today, but assert it rather than rely on it); or a (manual) compaction is in
// flight (status is 'idle' during manual /compact, so status alone misses it).
export function sessionMetaBusy(s: Pick<SessionMeta,
  'status' | 'ask' | 'planRequest' | 'elicitation' | 'activeSubagents' | 'compacting'>): boolean {
  return s.status === 'running'
    || !!(s.ask || s.planRequest || s.elicitation)
    || (s.activeSubagents ?? 0) > 0
    || !!s.compacting;
}
```

```ts
// packages/core/src/engine.ts — engine-authoritative wrapper (prefers the live Set)
private engineSessionBusy(st: SessionState): boolean {
  return sessionMetaBusy(st.meta) || st.inflightTasks.size > 0;
}
```

### Every call site that must consume it

| Site | Current code | Change |
| --- | --- | --- |
| `evictIfNeeded` victim filter (`engine.ts:455-456`) | `s.meta.status==='idle' && !hasSchedule(s) && !s.meta.compacting` | `!this.engineSessionBusy(s) && !hasSchedule(s)` |
| `checkHeapPressure` candidate set (`engine.ts:516`, normal + last-resort) | `...status==='idle' && !s.meta.compacting` | `... && !this.engineSessionBusy(s)` (then split on `hasSchedule`) |
| `unload()` guard (`engine.ts:562`) | `if (st.meta.status === 'running') throw` | `if (this.engineSessionBusy(st)) throw new Error('忙碌中,无法卸载')` |
| `reload()` guard (`engine.ts:573`) | `if (st.meta.status === 'running') throw` | `if (this.engineSessionBusy(st)) throw new Error('忙碌中,无法重载')` |
| server `sessionBusy` (`apps/server/src/index.ts:67-69`) | local re-impl | `import { sessionMetaBusy } from '@cockpit/core'` and delegate |
| `evict()` / `unload()` patch (`engine.ts:470, 564`) | omit `activeSubagents` | also emit `activeSubagents: 0` (close the stale-badge gap, finding (d)) |

Note `reload()` semantics: refusing a busy reload is consistent with eviction, but
`rewind()` calls `reload()` after `history.truncate()` (`engine.ts:954-956`) — that
path runs only after the truncate resolves, when the session is idle, so it is
unaffected; still, verify `rewind` is gated upstream against a running turn.

### Tests to add (would have caught both the masking and N1)

With a fake `SdkSessionManager`/`SdkSession` (seams are already clean — the Engine
takes a manager and folds events):

- Eviction victim selection vs `activeSubagents>0`, `awaitingChoice`,
  `compacting`, `hasSchedule` — assert a busy session is never a victim.
- `unload()`/`reload()` refuse a session that is awaiting a choice or compacting
  (the N1 regression).
- `trackSubagents` add/remove/abort accounting and the `evict()` patch including
  `activeSubagents:0`.
- A `sessionMetaBusy` truth-table unit test shared in spirit with the server.

### Severity

Re-rate the first-pass High → **Low (latent fragility / consistency)** for the
eviction/unload/reload-vs-`activeSubagents` gap, plus **Low–Medium** for N1
(`compacting` not guarded by unload/reload). The shared predicate addresses all of
it in one move and removes the duplicated definition the first pass correctly
flagged as the root cause.
