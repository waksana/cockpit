# Deep: Prefs durability & R1

Scope: `packages/core/src/prefs.ts` (`save`/`load`/`empty`), `hooks.ts`
(`firstTurnEligible`), `engine.ts` (spawnedBy mark + welcomed recording +
`maybeFirstTurnComplete`), `prefs.test.ts`. Verifies the first-pass **[High]** in
`docs/review/04-orchestration.md:26`. Review-only; no source touched; the real
`~/.copilot/cockpit-prefs.json` was never read or written.

## Verdict summary

**CONFIRMED (with one refinement).** `save()` writes in place and `load()`
silently returns `empty()` on any parse error, so a truncated/partial prefs file
makes a restart drop the persisted R1 safety state (`spawnedBySession`,
`welcomedSessions`); the next mutation's `save()` then overwrites the still-
recoverable corrupt file with the empty object. Proven end-to-end against the real
`Prefs` class: losing `spawnedBy` flips `firstTurnEligible` from `false` → `true`
for a previously-spawned worker, re-opening the exact fork-bomb R1 exists to
prevent. Refinement: the safety break occurs **at the corrupted-load restart
itself** (`load()`→`empty()`); the subsequent `save()` does not *cause* the break,
it makes the loss **permanent/unrecoverable**.

## Verified findings

### F1 — Non-atomic `save()` (no tmp+rename) — **CONFIRMED** — `prefs.ts:93-98`

```ts
private save(): void {
  try {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  } catch { /* best-effort; prefs are not critical */ }
}
```

`writeFileSync` opens the live file with `O_TRUNC` and streams the new contents.
A crash, power loss, `SIGKILL`, or `ENOSPC` between truncate and full write leaves
the **live file** truncated — there is no tmp-file + `renameSync` to make the
swap atomic, and no backup. The `catch {}` also swallows `ENOSPC`/`EACCES`, so a
failed persist is invisible: in-memory state diverges from disk until the next
restart silently reverts it. Fix: write to `this.file + '.tmp'`, then
`renameSync(tmp, this.file)` (atomic on the same filesystem); surface the catch
via a logger instead of swallowing.

### F2 — `load()` silently returns `empty()` on parse failure — **CONFIRMED** — `prefs.ts:75-91`

```ts
private load(): CockpitPrefs {
  try {
    const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<CockpitPrefs>;
    return { /* …each field individually defaulted… */ };
  } catch { return empty(); }
}
```

`empty()` (`prefs.ts:57-63`) zeroes **every** field, including the two safety
fields:

```ts
function empty(): CockpitPrefs {
  return {
    mcpDefaultOn: [], mcpBySession: {}, skillsDisabledBySession: {}, trashed: {},
    pinnedSessions: [], hooks: [], welcomedSessions: [], spawnedBySession: {}, flowSchedules: [],
    scheduledSessions: {},
  };
}
```

`load()` is invoked **only** from the constructor (`prefs.ts:72`,
`this.data = this.load()`); `save()` is independent. Therefore a corrupt file does
not self-heal mid-process — it manifests as `empty()` at the **next process
start**. The `catch` cannot distinguish "file does not exist yet" (legitimate
first run) from "file is corrupt" (data loss) — both collapse to `empty()`,
which is why the destructive case is masked by the benign one. Fix: on a parse
failure (as opposed to `ENOENT`), preserve the corrupt bytes (rename to
`*.corrupt-<ts>`) and log loudly before falling back, rather than silently
zeroing safety state.

### F3 — corruption → load()→empty() → save() → wipe sequence — **CONFIRMED** — `prefs.ts` + `engine.ts:161`

The single engine-wide instance is `private readonly prefs = new Prefs();`
(`engine.ts:161`) — default path `~/.copilot/cockpit-prefs.json`, **no injected
logger**, so a swallowed failure has nowhere to surface. Exact sequence
(each step proven in the demo below):

1. Worker spawned → `setSpawnedBy(worker, flowId)` persists the R1 mark
   (`engine.ts:1542`); a real session is `markWelcomed` (`engine.ts:1417`).
2. A `save()` is interrupted / disk fills → live file is truncated (F1). The bulk
   of the JSON, including `spawnedBySession`/`welcomedSessions`, is still on disk
   but the document is now unparseable.
3. Process restarts → `new Prefs()` → `load()` parse throws → `empty()` (F2).
   **At this instant the safety state is already lost in memory**, while the
   corrupt-but-recoverable bytes still sit on disk.
4. The next mutation anywhere (any UI toggle, `setSpawnedBy` for a new worker,
   `markWelcomed`, etc.) calls `save()` → writes `empty()`+the one change → the
   recoverable file is **clobbered**; recovery is now impossible.

### F4 — `prefs.test.ts` does not cover the destructive interaction — **CONFIRMED** — `prefs.test.ts:92-103`

The only corruption test is "malformed/missing prefs file loads as empty (no
throw)" (`prefs.test.ts:92`), which asserts the *benign* `empty()` outcome
(`assert.deepEqual(p.mcpDefaultOn, [])`) and even writes a fresh value afterwards
without checking what the prior on-disk safety state was. There is **no** test
for: atomic write under interrupted `save()`, a corrupt file that still contains
`spawnedBySession`/`welcomedSessions`, or the subsequent-`save()` clobber. The
round-trip tests (`prefs.test.ts:206-239`) prove persistence on the happy path but
never the corruption path. The first-pass coverage note (`04-orchestration.md:170`)
is accurate.

## R1 safety linkage (proof the durability bug is a fork-bomb bug)

The butler anti-fork-bomb rule **R1** (`docs/butler.md:138`): a Flow-spawned
session is stamped `spawnedBy=flowId` and is a **non-trigger-source** — none of
its lifecycle events may fire a flow — which "根除…fork 炸弹" (eliminates the
welcome-worker-spawns-another-welcome-worker fork bomb). The mark is the *only*
thing enforcing this. The chain that consumes it:

- `firstTurnEligible` (`hooks.ts:35-44`) short-circuits on `spawnedBy`:

  ```ts
  export function firstTurnEligible(i: FirstTurnInputs): boolean {
    if (i.spawnedBy) return false;        // R1: workers never trigger
    if (i.alreadyWelcomed) return false;  // once per source session (persisted)
    if (i.cancelled) return false;        // not a natural completion
    return i.userPrompts === 1 && i.assistantMessages >= 1;
  }
  ```

- Both guards are fed **entirely** from prefs. In `maybeFirstTurnComplete`
  (`engine.ts:1409-1415`):

  ```ts
  const eligible = firstTurnEligible({
    spawnedBy: st.meta.spawnedBy,
    alreadyWelcomed: this.prefs.isWelcomed(st.meta.sessionId),
    cancelled: st.turnCancelled === true,
    userPrompts, assistantMessages,
  });
  ```

  `st.meta.spawnedBy` has no other source than prefs — `projectButlerMeta`
  (`engine.ts:1395-1396`) sets it from `this.prefs.spawnedByOf(...)`:

  ```ts
  const spawnedBy = this.prefs.spawnedByOf(st.meta.sessionId);
  if (spawnedBy) st.meta.spawnedBy = spawnedBy;
  ```

  and `alreadyWelcomed` is `this.prefs.isWelcomed(...)` directly. So wiping
  `spawnedBySession` ⇒ `spawnedByOf` returns `undefined` ⇒ `st.meta.spawnedBy`
  undefined ⇒ the `if (i.spawnedBy) return false` guard does **not** fire; wiping
  `welcomedSessions` ⇒ `alreadyWelcomed` false ⇒ the once-bit guard does not fire.

A worker that has completed exactly its one born-ready turn has
`userPrompts === 1 && assistantMessages >= 1`, so with both guards gone
`firstTurnEligible` returns `true`. On the corrupted-load restart, the reloaded
worker's next `session.idle` (`engine.ts:712-716`) runs `maybeFirstTurnComplete`,
which now fires `session.first-turn-complete` (`engine.ts:1418-1423`) → the
welcome hook matches → another worker is spawned. **The durability bug is
therefore a safety (fork-bomb) bug, not mere data loss.**

Blast dynamics (**REFINED**): one corruption event yields a *one-shot fan-out* —
each previously-spawned worker fires once and spawns one replacement, and each
replacement gets a fresh `setSpawnedBy` (`engine.ts:1542`) so it is re-suppressed
**iff that save succeeds**. It escalates to a genuinely *unbounded* fork bomb when
the durability failure persists across restarts — most plausibly **disk full**,
which simultaneously (a) truncated the original write, (b) makes every recovery
`save()` of the new workers' `spawnedBy` fail silently at `prefs.ts:97`, and
(c) re-yields `empty()` on each subsequent restart — so every restart spawns a new
generation. This is exactly the runaway R1 was designed to "根除".

## Demonstration

Throwaway script imported the **real** `Prefs` and `firstTurnEligible` via
`node --import tsx`, pointed `Prefs` at a temp file (real prefs untouched),
simulated a realistic crash-mid-write (tail of the JSON lost), and measured R1
eligibility before/after. Script + temp dir deleted after the run.

```
=== STEP 1: healthy prefs — a worker is spawned (R1 mark) + a real session welcomed ===
  spawnedByOf(worker-A)   = "welcome-flow"
  isWelcomed(real-1)      = true
  file has spawnedBySession key? true
  file has worker-A?             true

=== R1 BEFORE corruption: worker-A reaches idle on its 1st turn ===
  firstTurnEligible(worker-A) = false   (false = R1 suppresses, NO welcome fired)

=== STEP 2: simulate a truncated / partial write (crash mid-writeFileSync / disk-full) ===
  wrote 271/311 bytes (tail lost -> invalid JSON)
  truncated file still mentions worker-A?        true
  truncated file still mentions real-session-1?  true
  JSON.parse(corrupt) THROWS -> Unterminated string in JSON at position 271 (line 16 column 11)

=== STEP 3: process restarts -> new Prefs(file) -> load() catch -> empty() ===
  spawnedByOf(worker-A)   = undefined   (LOST)
  isWelcomed(real-1)      = false   (LOST)
  mcpDefaultOn            = []   (LOST)
  NOTE: corrupt bytes still on disk at this instant (recoverable by hand):
        worker-A present on disk? true

=== STEP 4: the NEXT mutation save()s empty()+the one change -> clobbers the recoverable file ===
  after save(): worker-A on disk?          false   (GONE — unrecoverable)
  after save(): real-session-1 on disk?    false   (GONE)
  after save(): spawnedBySession contents  = {}
  after save(): welcomedSessions contents  = []

=== R1 AFTER wipe: worker-A reloaded, projectButlerMeta reads empty prefs ===
  firstTurnEligible(worker-A) = true    (TRUE = R1 guard GONE -> fires session.first-turn-complete -> spawns another worker)

=== VERDICT ===
  R1 flipped false -> true purely from losing the persisted spawnedBy mark: true
```

Reading: STEP 2 proves the corrupt file is *unparseable yet still contains* both
safety records (recoverable). STEP 3 proves the restart drops them to `empty()`
(the safety break point). STEP 4 proves the next `save()` destroys the recoverable
evidence. The before/after `firstTurnEligible` (`false` → `true`) is the proof the
fork-bomb guard is re-opened by data loss alone.

## New findings

- **NF1 (Low) — `forgetSession` (purge) is non-atomic across many `save()`-less
  mutations but ends in one `save()`** — `prefs.ts:236-247`. Not a new bug, but
  note it mutates eight fields then a single `save()`; under F1 the same
  interrupted-write risk applies to purge. Folds into the F1 atomic-write fix.
- **NF2 (Info) — the swallow at `prefs.ts:97` also hides steady-state persist
  failures**, independent of corruption: on a full disk every butler mutation
  (`setSpawnedBy`, `markWelcomed`, `setScheduleCount`) appears to succeed in
  memory but never reaches disk, so the *first* restart silently reverts all
  butler state at once. The fix's "log on catch" half addresses this directly.
- **No contradicting evidence found.** The first-pass High is accurate; the only
  correction is the timing refinement (break at load, not at the later save) and
  the fan-out-vs-unbounded nuance, both captured above.

## Recommended fix

Three independent, additive changes, all confined to `prefs.ts` (plus an optional
logger inject at `engine.ts:161`). Sketch:

```ts
// 1. Atomic write: tmp + rename, and stop swallowing failures.
import { renameSync } from 'node:fs';

private save(): void {
  const tmp = `${this.file}.tmp`;
  try {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);            // atomic swap on the same fs
  } catch (e) {
    this.log?.(`prefs save failed: ${(e as Error).message}`); // surface, don't hide
  }
}

// 2. Preserve-corrupt-on-parse-fail + distinguish ENOENT from corruption.
private load(): CockpitPrefs {
  let raw: string;
  try { raw = readFileSync(this.file, 'utf-8'); }
  catch { return empty(); }                // ENOENT etc. — legitimate first run
  try {
    const parsed = JSON.parse(raw) as Partial<CockpitPrefs>;
    return { /* …unchanged per-field defaulting… */ };
  } catch (e) {
    // 3. Fail loud, keep the evidence: do NOT silently zero safety state.
    const bak = `${this.file}.corrupt-${Date.now()}`;
    try { renameSync(this.file, bak); } catch { /* ignore */ }
    this.log?.(`prefs CORRUPT — preserved at ${bak}; refusing to start from empty: ${(e as Error).message}`);
    throw new Error(`cockpit-prefs.json is corrupt (backed up to ${bak}); ` +
      `refusing to wipe butler/safety state. Inspect & restore.`);
  }
}
```

- **(1) Atomic write** removes the truncation window entirely — a crash leaves the
  *old good* file intact, so the corrupt-load path is never entered for the normal
  crash case. This is the highest-leverage change.
- **(2) ENOENT vs parse-fail split** stops conflating "first run" with "corrupt",
  so the destructive branch can act differently from the benign one.
- **(3) Fail loud for safety fields.** Because `spawnedBySession`/
  `welcomedSessions` are safety-critical (not "best-effort UX"), a corrupt prefs
  file should **preserve** the corrupt bytes (`*.corrupt-<ts>`) and refuse to
  boot from `empty()` rather than silently re-enabling R1. If a hard refuse is too
  strict operationally, the minimum bar is: rename-to-`*.corrupt` + loud log +
  **do not let the first `save()` overwrite the preserved file** (already
  guaranteed once the original is renamed away). Either way the engine should pass
  a logger into `new Prefs()` (`engine.ts:161`) so the swallow at `prefs.ts:97`
  becomes observable.
- **Tests to add** (close F4): interrupted-`save()` leaves the prior file intact
  (tmp+rename); a corrupt file with intact `spawnedBySession`/`welcomedSessions`
  is preserved (`*.corrupt` exists) and not clobbered by the next mutation; and a
  regression asserting `firstTurnEligible` stays `false` for a known worker across
  a corrupt-then-reload cycle.
