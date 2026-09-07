# Deep: Engine turn & queue

Scope: `Engine.prompt` (fire-and-forget), `cancel`/`resetTurn`, `syncQueue` vs
`removeQueued`, the queued-item id scheme, and turn `status` emission. Verified
against `packages/core/src/engine.ts`, `packages/protocol/src/index.ts`,
`apps/server/src/index.ts`, `packages/core/src/{attention,sdk-types,fold}.ts`, and
the **installed** SDK bundle `@github/copilot@1.0.63` (`.../sdk/index.{d.ts,js}`,
the version pinned in `packages/core/package.json:17`). `pnpm --filter
@cockpit/core test` re-run read-only: 137 pass, **none** touch engine turn/queue.

## Verdict summary

The first pass's two headline claims are **partly wrong in a useful way**: a
*thrown* turn does **not** pin `running` forever — the SDK swallows agentic-loop
errors into a `session.error` event and still emits `session.idle`, so cockpit's
optimistic `running` is reliably cleared (REFUTED as stated, REFINED into a real
"failed turns never surface as `status:'error'`" gap). The queue findings are
**CONFIRMED and worse than described**: `removeQueued` clears the entire SDK queue
(messages + the immediate steering queue + hidden non-message items) and rebuilds
via a method (`enqueueUserMessage`) that is **`private`** in the SDK `.d.ts` —
under an SDK rename the optional-chained rebuild becomes a no-op and removing one
queued item **wipes the whole queue**. The positional `q-<i>` id race is real and
reproducible (delete A then B → deletes A then C). New: `cancel` never drains the
SDK pending queue, so a cancelled-before-start prompt resurrects on the next send.

---

## Verified findings

### V1 — "stuck running" from a thrown turn — **REFUTED (as stated) / REFINED**

First-pass claim (02-engine.md:133–146): a turn that throws after the
`status→running` patch but before a terminal `session.idle` leaves status pinned
`running`, with `send().catch` as the only backstop.

**What the optimistic write is.** `prompt` flips status with no reconciliation:

```
engine.ts:833  const queued = st.meta.status === 'running';
engine.ts:835  if (st.meta.status !== 'running') this.patch(st, { status: 'running', error: null });
engine.ts:843  void st.sdk.send({ prompt: text, mode: mode ?? 'enqueue' }).catch((e) => {
engine.ts:844    this.patch(st, { status: 'error', error: (e as Error).message });
engine.ts:845  });
```

The only authoritative clear is the `session.idle` handler:

```
engine.ts:712  if (ev.type === 'session.idle') {
engine.ts:713    this.patch(st, { status: 'idle', intent: null });
```

**What actually happens when the turn throws.** In the SDK the per-message branch
of `processQueuedItems` wraps the agentic loop in a `try/catch` that **does not
re-throw** — it converts the failure into a `session.error` *event* and lets the
drain loop continue:

```js
// sdk/index.js  (processQueuedItems, message branch)
try{ this.turnActive=!0, this.mcpHost?.sendNotification("assistant.turn_start"),
     s=await this.runAgenticLoop(o.prompt, ... ,!1) }
catch(a){ w.error(`Agentic loop failed: ${k(a)}`),
          this.emit("session.error",{errorType: ... ,message:`Execution failed: ${k(a)}`, ...}) }
```

At loop end it emits `session.idle` (unless deferred — see V2):

```js
// sdk/index.js  (end of processQueuedItems)
this.isProcessing=!1; let e=this.abortController?.signal.aborted??!1;
... this.hasActiveBackgroundWork()
      ? (this.idleDeferredByBackgroundWork=!0, ...)
      : this.emitSessionIdle(e)
// emitSessionIdle(){ ... this.emitEphemeral("session.idle",{...}) }
```

So a thrown turn → `session.error` **+** `session.idle` → cockpit clears
`running` at `engine.ts:713`. **It does not stay pinned.** Because `send()`
returns a promise even for the early `throw new Error("Not connected")`
(`async send`), `st.sdk.send(...).catch(...)` always attaches — the posited
"throw before the catch attaches" cannot happen for an async method.

**The real refinement (the bug that IS here).** `onLive` has **no `session.error`
case** — it falls straight through to the fold (`engine.ts:757`). Consequently:

- A failed turn is projected as a **normal idle completion** (running→idle →
  `attention:'ready'`), never `status:'error'`. The `send().catch` error path
  (`engine.ts:844`) is effectively **dead for turn failures** — it only fires for
  an outright `send()` *promise rejection* (transport "Not connected" / auth),
  which is not how in-turn failures arrive.
- The error is not lost entirely: the fold renders `session.error` as a system
  error bubble (`fold.ts:591–601`, level `'error'`, persisted/replayed). So the
  user sees an error *row* but the session **status/badge says "ready", not
  "error"** — a small projection inconsistency and a missed signal.

**Precise fix.** Add a `session.error` branch to `onLive` (next to the
`session.idle` case at `engine.ts:712`) that records the turn error onto
`SessionMeta` without fighting the imminent `session.idle`:

```ts
if (ev.type === 'session.error') {
  const msg = typeof ev.data?.message === 'string' ? ev.data.message : 'turn failed';
  this.patch(st, { error: msg });   // keep status; session.idle (713) settles it next
  return; // still folded? -> fold.ts already renders the bubble on the same event;
          // either let it fall through (current) OR re-emit via fold. Do NOT double-handle.
}
```

(If you want the bubble too, don't `return` — fall through to the fold as today,
but still set `error`. The decision is whether a failed turn should read `error`
at the meta level; per the pure-projection invariant it should.)

---

### V2 — genuine indefinite-`running` window: idle-deferral by background work — **REFINED (real, recoverable)**

The first-pass "never-starting turn pins running" (02-engine.md:138) is real, but
the mechanism is the SDK's **idle deferral**, not a missing rollback:

```js
// sdk/index.js
hasActiveBackgroundWork(){ return this.hasRunningAgents() ? !0 : ... }
// loop end:
this.hasActiveBackgroundWork()
  ? (this.idleDeferredByBackgroundWork=!0, this.idleDeferredAborted=e, this.notifyBackgroundTaskChange())
  : this.emitSessionIdle(e)
```

…and `send()` itself can return **without draining** when background work is
notifying:

```js
// sdk/index.js  send()
this.enqueueUserMessage(e,e.prepend), this.emitEphemeral("pending_messages.modified",{}),
!this.isProcessing && (e.mode==="enqueue" && this.hasNotifyingBackgroundWork() || await this.processQueue())
```

So whenever a `task` sub-agent / attached shell is in flight at drain time,
`session.idle` is **withheld** and cockpit's optimistic `running` (engine.ts:835)
persists until that background work completes. This is consistent with
`SessionMeta.activeSubagents` (the session *is* still working) and is recoverable:
`cancel` (engine.ts:866) force-patches idle. **But there is no cockpit-side
watchdog** — a hung background tool pins `running` until a human cancels.

**Verdict:** acceptable-by-design for live work, but the optimistic flip at
`engine.ts:835` is the only un-reconciled write in the turn path. **Fix (cheap):**
drive the running transition from `assistant.turn_start` (already handled,
`engine.ts:702–703`) instead of optimistically in `prompt`, and/or arm a
bounded watchdog that clears a `running` that never saw a `turn_start`. Deriving
`running` from the SDK event keeps the "frontend is a pure projection" invariant
intact.

---

### V3 — `removeQueued` is lossy, double-deprecated, and depends on a **private** SDK method — **CONFIRMED + sharpened**

```
engine.ts:1720 removeQueued(sessionId: string, itemId: string): void {
engine.ts:1723   const idx = Number.parseInt(itemId.replace(/^q-/, ''), 10);
engine.ts:1726   try { pending = (st.sdk.getPendingQueuedMessages?.() ?? []).map((x) => String(x)); } catch { return; }
engine.ts:1728   const survivors = pending.filter((_, i) => i !== idx);
engine.ts:1730   st.sdk.clearPendingMessages?.();
engine.ts:1731   for (const text of survivors) st.sdk.enqueueUserMessage?.({ prompt: text });
```

Verified against the 1.0.63 bundle:

1. **`getPendingQueuedMessages()` is `@deprecated`** and returns message-only
   strings — so it never even *sees* non-message items:
   ```
   sdk/index.d.ts:14094  @deprecated Use getPendingQueuedItems() instead ...
   sdk/index.d.ts:14096  getPendingQueuedMessages(): ReadonlyArray<string>;
   // sdk/index.js: getPendingQueuedMessages(){ return this.itemQueue.filter(e=>e.kind==="message").map(e=>e.options.prompt) }
   ```
   `String(x)` is a no-op **today** (already strings); if a future SDK aliases it
   to the items shape, every survivor becomes `"[object Object]"`. `syncQueue`
   (engine.ts:819–822) already defends an object shape — the two paths disagree on
   the element type.

2. **`clearPendingMessages()` is *also* `@deprecated`** and clears **everything**,
   not just messages — including the **immediate steering queue**:
   ```
   sdk/index.d.ts:14117  @deprecated Use clearPendingItems() instead.
   sdk/index.d.ts:14119  clearPendingMessages(): void;
   // sdk/index.js: clearPendingMessages(){ this.clearPendingItems() }
   //               clearPendingItems(){ this.immediatePromptProcessor.clearQueue(), this.itemQueue.length=0, emitEphemeral("pending_messages.modified",{}) }
   ```
   So removing one queued message also destroys any `QueuedCommandItem` /
   `QueuedModelChangeItem` / `QueuedResumePendingItem` (SDK `QueuedItem` union,
   `sdk/index.d.ts:20094`) **and** any in-flight `mode:'immediate'` steering
   message (which cockpit never even showed, since `getPendingQueuedMessages`
   filters to `kind==="message"` in `itemQueue` only). Surviving messages are
   rebuilt as bare `{prompt}` — `displayPrompt`, `source`, `mode`, `attachments`
   (the rest of `SendOptions`) are stripped:
   ```js
   // sdk/index.js: enqueueUserMessage(e,n=!1){ this.addItemToQueue({kind:"message",options:e}, ...) }
   ```

3. **`enqueueUserMessage` is `private` in the SDK surface** — the public enqueue
   API is `enqueueItem(item: QueuedItem)`:
   ```
   sdk/index.d.ts:13872  enqueueItem(item: QueuedItem): void;   // public
   sdk/index.d.ts:13893  private enqueueUserMessage;            // <-- cockpit calls THIS
   ```
   cockpit declares it optional (`sdk-types.ts:31 enqueueUserMessage?(...)`) and
   calls it optional-chained. **This is the sharp risk the first pass missed:** if
   an SDK bump renames/removes the private `enqueueUserMessage`,
   `st.sdk.clearPendingMessages?.()` (engine.ts:1730) **still fires and clears the
   whole queue**, but `st.sdk.enqueueUserMessage?.(...)` (engine.ts:1731) becomes a
   **silent no-op** → removing one queued item **deletes every queued message**,
   with no error. `assertSdkContract()` does not cover it (it is a private,
   per-session method).

**Precise fix (engine.ts:1720–1734).**
- Read with the non-deprecated `getPendingQueuedItems()` (or share `syncQueue`'s
  extractor) so the index space is explicit.
- Rebuild via the **public** `enqueueItem({ kind:'message', options:{ prompt } })`
  rather than the private `enqueueUserMessage`, so a rename is a typecheck failure,
  not silent total loss.
- Guard the destructive step: only `clearPendingMessages()`/`clearPendingItems()`
  **after** confirming the re-enqueue primitive exists, e.g.
  `if (typeof st.sdk.enqueueItem !== 'function') return;` before clearing — so a
  missing rebuild API fails closed (no removal) instead of wiping the queue.
- Note the irreducible SDK limit: the only *positional/targeted* removal primitive
  exposed is **LIFO** `removeMostRecentPendingItem(): boolean`
  (`sdk/index.d.ts:14115`); there is no by-id/by-index removal and no public
  getter returning raw `QueuedItem[]` with full options, so a fully faithful
  middle-removal is **not achievable** through today's public surface — document
  this and preserve at least message order + prompt text (current behavior),
  while stopping the queue-wipe and private-method risks above.

---

### V4 — positional `q-<i>` id race → wrong item removed — **CONFIRMED (reproducible)**

```
engine.ts:817  items = raw.map((r, i) => ({ id: `q-${i}`, ... }));   // syncQueue
engine.ts:1723 const idx = Number.parseInt(itemId.replace(/^q-/, ''), 10); // removeQueued
```

The id is the *position* in the message-only filtered array. Both `syncQueue`
(read) and `removeQueued` (read) use the same `getPendingQueuedMessages()` view,
so they agree at any instant — but the array re-indexes on every drain or removal,
and the client holds stale ids. See the **Queue id-race analysis** section for the
exact two-remove and drain-race sequences. **Fix:** validate the target by content
before removing (compare `survivors`/`pending[idx]` against the text the client
intended), or carry an opaque per-render token; at minimum fold this into the V3
rework and document the race. The SDK exposes no stable per-item id, so position +
content re-validation is the best available handle.

---

## Stuck-running analysis — turn-promise exit paths → terminal patch guaranteed?

`prompt` (engine.ts:835) optimistically sets `status:'running'`. Authoritative
clears: `session.idle`→idle (engine.ts:713), `send()` promise-reject→error
(engine.ts:844), `cancel`→idle-silent (engine.ts:866). Eviction/unload cannot
fire on a `running` session (`evictIfNeeded` filters `status==='idle'`,
engine.ts:456; `unload` refuses running, engine.ts:562), so unload-mid-turn is not
a leak path. Enumerated:

| Turn-end path | SDK behavior | Terminal patch in cockpit? |
|---|---|---|
| Normal completion, no background work | drain loop → `emitSessionIdle` → `session.idle` | **YES** — engine.ts:713 idle |
| Agentic loop **throws** (tool/query/auth-in-loop) | caught, **not re-thrown** → emits `session.error`, loop continues → `session.idle` | **YES → idle** (engine.ts:713). `status:'error'` **never set**; error only as fold bubble (fold.ts:591). `send().catch` is dead here. (V1) |
| `send()` outright **promise rejection** (e.g. "Not connected", pre-loop auth) | promise rejects | **YES → error** — engine.ts:844 |
| User **cancel** | `abort()`→loop unwinds→`emitSessionIdle(aborted)` | **YES** — also force-patched idle-silent at engine.ts:866 (belt-and-suspenders) |
| Completion **with active background work** | `session.idle` **deferred** (`idleDeferredByBackgroundWork`) | **NO until bg work ends** — `running` pinned; recoverable via cancel (V2) |
| `mode:'enqueue'` **and** `hasNotifyingBackgroundWork()` | `send()` returns **without draining**; waits for bg notify turn | `running` pinned until bg drains; recoverable via cancel (V2) |
| Genuine **hang** in a tool/loop (no return, no throw) | no `turn_end`, no `session.idle` | **NO** — pinned `running`; recoverable via cancel |
| Synchronous throw from `send()` before `.catch` | impossible (`async send` always returns a promise) | n/a |

**Conclusion:** there is **no "pinned running forever with no recovery"** path
from a thrown turn — the SDK guarantees a `session.idle` on every
completed/caught-error drain (when no background work defers it). The optimistic
`running` only persists while *real* work (or a hang/deferred background task) is
in flight, and `cancel` always recovers it. The actionable defects are V1
(failed turn ≠ `status:'error'`) and V2 (no watchdog / optimistic write not
event-driven), **not** a stuck-running invariant break.

---

## Queue id-race analysis — concrete racing sequence + outcome

Setup: queue is `[A, B, C]`; `syncQueue` (engine.ts:817) projects
`A→q-0, B→q-1, C→q-2`. Ids are positions into the message-only array returned by
`getPendingQueuedMessages()`.

**Race 1 — two removes in flight (wrong item deleted).** User deletes A then B
back-to-back (client holds `q-0`, `q-1`):
1. `removeQueued(q-0)`: `idx=0`, `pending=[A,B,C]`, `survivors=[B,C]`,
   `clearPendingMessages()` wipes all, re-enqueue `[B,C]`. Queue is now
   `[B(idx0), C(idx1)]`; `syncQueue` re-emits `B→q-0, C→q-1`.
2. `removeQueued(q-1)` (still the *stale* id for **B**): `idx=1`,
   `pending=[B,C]`, removes **index 1 = C**. **B survives, C is deleted.**
   → The user asked to delete A and B; the queue deletes A and C.

**Race 2 — remove vs drain (silent no-op / wrong item).** Queue `[A,B,C]`, client
sees `q-0..q-2`. The running turn drains the head (`this.itemQueue.shift()` in
`processQueuedItems`), emitting `pending_messages.modified` → `onLive`
(engine.ts:701) → `syncQueue` re-emits `B→q-0, C→q-1`. A `removeQueued(q-2)` (the
client's id for **C**) is already in flight:
- `pending=[B,C]` (len 2), `idx=2` ≥ len → out of range → **returns, no-op**
  (engine.ts:1727). The user clicked delete on C; nothing happens.
- Worse variant: a `removeQueued(q-1)` (client's id for **B**) arriving after the
  same drain → `idx=1` removes **index 1 = C**. **Wrong item deleted.**

Root cause: the id encodes array position, and the array re-indexes on every drain
(`shift`) and on every removal (clear + rebuild). There is no stable per-item
handle in the SDK. **Mitigation:** re-validate `pending[idx]` against the client's
intended text before removing (reject on mismatch), or carry the text in the
intent and match content-first; fold into the V3 rebuild.

---

## New findings (beyond the first pass)

### N1 — `onLive` ignores `session.error`; failed turns project as "ready", not "error" — `engine.ts:712` (no error case), `fold.ts:591`
The SDK delivers in-turn failures as `session.error` events, **not** `send()`
rejections (V1). cockpit handles neither at the meta level → a failed turn flips
to `attention:'ready'` like a success; the `status:'error'` write at
engine.ts:844 is dead for turns. Fix per V1.

### N2 — `cancel` never drains the SDK pending queue → a cancelled-before-start prompt resurrects — `engine.ts:849–867`
`cancel` calls `st.sdk.abort?.()` (engine.ts:852). In the bundle:
```js
// sdk/index.js
async abort(e){ this.pendingAbortReason=e?.reason, this.cancelProcessing("Session aborted") }
cancelProcessing(e,n){ this.abortController?.abort(n), this.sidekickAgentManager.cancelAll(),
  this.cancelActiveAgents(), ... rejectAllQueuedCommands(...), rejectAllCommandExecutions(...) }
onUserAbort(){ this.clearPendingItems() }   // <-- the ONLY path that clears itemQueue
```
`abort()`→`cancelProcessing` **does not clear `itemQueue`**; only `onUserAbort()`
(the MCP `user.abort` path, *not* what cockpit triggers) does. So: user sends a
prompt while a turn runs (mode `enqueue` → queued in `itemQueue`), then cancels.
cockpit aborts the *current* turn and force-patches idle (engine.ts:866), but the
**queued message stays in the SDK queue** and runs on the next `processQueue()`
kick — i.e. the next time the user prompts, the previously "cancelled" message
executes first. Repro: prompt P1 (runs) → prompt P2 (queued) → cancel → later
prompt P3 → SDK drains **P2 then P3**. **Fix:** in `cancel`, after `abort()`, also
clear the SDK pending queue (e.g. `st.sdk.clearPendingMessages?.()` /
`clearPendingItems`) and then `syncQueue(st)` so `SessionMeta.queue` and the SDK
agree — or, if the queue *should* survive a cancel, make that explicit and keep
the projection. Today the projection (`queue` cleared only on unload,
engine.ts:444) and the SDK state can silently diverge after a cancel.

### N3 — `removeQueued` fails *open* (wipes queue) on a missing rebuild API — `engine.ts:1730–1731`
Covered in V3: the clear (engine.ts:1730) is unconditional while the rebuild
(engine.ts:1731) is optional-chained on a **private** SDK method. A rename → full
queue loss on any single removal. Guard the clear behind a rebuild-API presence
check (fail closed).

### N4 — `removeQueued`/cancel also destroy the **immediate steering queue** — `engine.ts:1730`
`clearPendingItems` also calls `immediatePromptProcessor.clearQueue()` (V3 excerpt),
so an in-flight `mode:'immediate'` steering message — never shown in
`SessionMeta.queue` (it lives outside `itemQueue`) — is silently dropped when the
user removes an unrelated *visible* queued item. Low blast radius today (cockpit's
composer mostly enqueues), but it is invisible data loss.

### N5 — `queued` flag wrong for `mode:'immediate'`; `prompt` has no compacting/choice guard — `engine.ts:828–847`
`queued = st.meta.status === 'running'` (engine.ts:833) is computed regardless of
`mode`. For `mode:'immediate'` while a turn runs, the SDK routes the message to the
**immediate steering queue and returns** (it does *not* create a visible queue
item):
```js
// sdk/index.js send(): e.mode==="immediate"&&this.isProcessing -> addImmediateMessage(e); return;
```
…yet cockpit returns `queued:true`, mislabeling a steering message as queued.
Conversely `mode:'immediate'` while **idle** falls through to a normal fresh turn
(not "immediate" at all). Separately, `prompt` checks neither `compacting` nor a
pending choice before flipping `running` and calling `send()` — prompting mid-
compaction or while `attention:'choice'` is pending enqueues behind the blocked
turn without acknowledging it. **Fix:** derive `queued` from the actual
enqueue-vs-fresh decision (or from `isProcessing`), and decide explicitly whether
to reject/queue a prompt while `compacting`/awaiting a choice.

### N6 — `cancel` on an *idle* session with background sub-agents zeroes `activeSubagents` — `engine.ts:862–866`
`cancel` is unconditional (no `status==='running'` guard). On an idle session that
still has live background `task` sub-agents (`inflightTasks.size>0`, a documented
state), `cancel` clears `inflightTasks` and patches `activeSubagents:0`
(engine.ts:862–866), **opening the graceful-restart gate** even though `abort()`'s
`cancelActiveAgents()` may race the still-running agents. This is the turn-scope
twin of the lifecycle High in 02-engine.md (eviction vs `activeSubagents`). Double-
cancel and cancel-before-`turn_start` are otherwise harmless (abort is idempotent),
except for the queue-resurrection of N2. **Fix:** make `cancel` a no-op (or
narrower) when `status!=='running'` and there is no active turn to abort, or at
least don't zero `activeSubagents` unless the abort actually targeted them.

---

## Recommended fix order

1. **N3 / V3 — stop the queue-wipe foot-gun first.** Guard `removeQueued`'s clear
   behind a rebuild-API presence check and switch the rebuild to the **public**
   `enqueueItem(...)`; read via `getPendingQueuedItems()`. (Highest blast radius:
   silent total queue loss on an SDK bump.) — `engine.ts:1720–1734`.
2. **N1 / V1 — handle `session.error` in `onLive`** so a failed turn reads
   `status`/`error` correctly instead of "ready". — `engine.ts:712`.
3. **N2 — clear (or deliberately preserve) the SDK pending queue on `cancel`** and
   re-`syncQueue`, so the projection and SDK can't diverge and a cancelled prompt
   can't resurrect. — `engine.ts:849–867`.
4. **V4 — content-revalidate `removeQueued`** (or carry the target text) to kill
   the positional id race; folds into step 1. — `engine.ts:817, 1723`.
5. **V2 / N5 — make the `running` transition event-driven** (lean on
   `assistant.turn_start`, engine.ts:702) and fix the `queued` flag + the
   compacting/choice guards in `prompt`. — `engine.ts:828–847`.
6. **N6 — narrow `cancel`** for the idle-with-subagents case (consistent with the
   lifecycle "busy" predicate the first pass recommends centralizing). —
   `engine.ts:849–867`.
7. **Tests** — none of the above is covered. Add a fake-SDK harness asserting:
   `prompt` fire-and-forget acceptance + `queued` semantics per mode;
   `session.idle`/`session.error` → status reconciliation; `cancel` →
   resetTurn + inflightTasks.clear + queue drained; `syncQueue`/`removeQueued`
   round-trip with a non-message item present and a concurrent drain (would catch
   V3+V4+N2 directly).
