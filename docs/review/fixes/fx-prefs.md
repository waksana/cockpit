# Fix: Prefs durability — atomic write + corrupt-load preservation (R1 safety)

Implements the **[High]** in `docs/review/04-orchestration.md:26` (`prefs.ts:93-98`
/ `prefs.ts:75-91`), as deep-verified in `docs/review/deep/dr-prefs-durability.md`
(F1–F4 + the R1 fork-bomb linkage). Scope honored: only
`packages/core/src/prefs.ts` and `packages/core/src/prefs.test.ts` were modified —
no other source file (notably **not** `engine.ts`), no git/server/deploy actions.

## Problem

`Prefs` is the on-disk home of the R1 anti-fork-bomb safety state
(`spawnedBySession` = the worker = non-trigger-source mark; `welcomedSessions` =
the per-source once-bit). Two defects made a transient disk hiccup able to wipe it
**permanently** and re-open the fork bomb R1 exists to prevent:

- **Non-atomic write (F1)** — `save()` did `writeFileSync(this.file, …)` directly
  over the live file (`O_TRUNC` then stream). A crash / power loss / `SIGKILL` /
  `ENOSPC` mid-write left the **live file truncated** = unparseable. The `catch {}`
  also swallowed `ENOSPC`/`EACCES`, so a failed persist was invisible.
- **Silent reset-to-empty on parse failure (F2)** — `load()` did
  `catch { return empty(); }`, conflating "file does not exist yet" (legitimate
  first run) with "file is corrupt" (data loss). On the corrupt-load restart the
  safety state is dropped to `empty()` **in memory** (the break point), and the
  next mutation's `save()` then **clobbers** the still-recoverable corrupt bytes
  (F3) — recovery becomes impossible.

R1 linkage (why this is a safety bug, not mere data loss): losing `spawnedBy` makes
`firstTurnEligible`'s `if (i.spawnedBy) return false` guard (`hooks.ts:36`) stop
firing, so a reloaded worker that finished exactly its one born-ready turn
(`userPrompts === 1 && assistantMessages >= 1`) passes the guard and fires
`session.first-turn-complete` → the welcome hook spawns another worker.

## Change — `packages/core/src/prefs.ts`

**1. Atomic write (`save()`, was `prefs.ts:93-98`).** Serialize to a sibling
`${this.file}.tmp`, then `renameSync(tmp, this.file)`. `rename(2)` is atomic on the
same filesystem, so a reader/restart sees either the whole old file or the whole
new one — never a truncated document. The truncation window is removed entirely, so
for the normal crash case the corrupt-load path is never even entered.

```ts
private save(): void {
  const tmp = `${this.file}.tmp`;
  try {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);          // atomic swap on the same fs
  } catch (e) {
    this.log(`cockpit-prefs.json save FAILED — in-memory changes were not persisted: ${(e as Error).message}`);
  }
}
```

**2. Stop swallowing save failures (loud log hook).** `Prefs` now takes an optional
`log: PrefsLogger` (`(msg: string) => void`, default `console.error`) — a
prefs-internal hook, **no `engine.ts` change required**. A failed persist (disk
full, EACCES) is now surfaced, not hidden (closes NF2).

**3. ENOENT vs parse-failure split + preserve-corrupt (`load()`, was
`prefs.ts:75-91`).** The read and the parse are split into two `try`s:

- read fails (ENOENT etc.) → `return empty()` **without touching disk** — a
  legitimate first run; nothing lost, nothing to preserve.
- read succeeds but `JSON.parse` throws → the file exists and very likely still
  contains the recoverable safety state. Rename the corrupt bytes aside to
  `${this.file}.corrupt-<ts>`, **log loudly**, and `return empty()`.

```ts
} catch (e) {
  const bak = `${this.file}.corrupt-${Date.now()}`;
  try {
    renameSync(this.file, bak);
    this.log(`cockpit-prefs.json is CORRUPT — preserved the recoverable bytes at ${bak} … restore by hand … ${(e as Error).message}`);
  } catch (renameErr) {
    this.log(`cockpit-prefs.json is CORRUPT and could not be preserved (${(renameErr as Error).message}); started from EMPTY. Parse error: ${(e as Error).message}`);
  }
  return empty();
}
```

Because the original path is renamed away, the **next `save()` writes a fresh file
and cannot overwrite the preserved `.corrupt-*` evidence** (closes F3's clobber) —
the bytes stay on disk for manual recovery.

**`forgetSession` (purge, `prefs.ts`):** unchanged — its many field mutations end in
the single `save()`, so it inherits the atomic write for free (NF1).

### Decision: preserve + warn + `return empty()`, NOT `throw`

The deep report's sketch `throw`s on corruption (fail-hard). I deliberately took the
report's stated *minimum bar* instead — **preserve the `.corrupt-*` file + loud log
+ return `empty()`** — per the implementation brief, because a hard refuse would
crash cockpit-server boot on a single bad prefs file (the SDK history, sessions, and
all live work are still fine; only the small prefs JSON is bad). The safety property
is still met: the corrupt bytes are **preserved and never clobbered**, so the R1
state is recoverable, and the loss is **loud** rather than silent.

**Residual (documented, accepted):** for a *genuinely corrupt-on-disk* prefs file
(as opposed to a crash-mid-write, which atomic write now prevents outright), the
in-memory state is still `empty()` until an operator restores the backup — so R1 is
re-opened **in memory** for that window. This is the explicit trade vs `throw`. It
is mitigated three ways: (a) atomic write makes the realistic crash case never
produce a corrupt file at all; (b) the corruption is now loudly logged, not silent;
(c) the evidence is preserved and recoverable. If operations later prefer fail-hard
for the safety fields, switching the `return empty()` to `throw` is a one-line
change — see the note for downstream tasks below.

## Tests added — `packages/core/src/prefs.test.ts`

A new "Durability" section (3 tests); imports `firstTurnEligible` from `./hooks.ts`.
All use an injected temp file — the real `~/.copilot/cockpit-prefs.json` is never
read or written.

1. **`interrupted write leaves the prior prefs file intact (tmp+rename semantics)`**
   — persists `spawnedBy`/`welcomed`, asserts a completed `save()` leaves **no stray
   `.tmp`** (rename consumed it), then writes a partial `.tmp` (a crash before
   rename) and asserts the live file is **byte-for-byte unchanged** and a fresh
   `Prefs` reads the intact safety state back. (The old non-atomic write would have
   truncated the live file here.)
2. **`corrupt prefs with safety state is preserved as .corrupt-* and not clobbered
   by next save`** — writes invalid JSON that still textually contains
   `spawnedBySession`/`welcomedSessions`; asserts the load **logs loudly** (injected
   logger), starts from `empty()`, creates exactly one `*.corrupt-*` backup holding
   the bytes verbatim, and that a subsequent `setSpawnedBy()` save **does not**
   overwrite the backup.
3. **`R1 guard stays closed for a known worker across a crash-mid-write then
   reload`** — the end-to-end safety lock: marks `worker-A` as `spawnedBy`,
   simulates a crash (partial `.tmp`), reloads, and asserts
   `firstTurnEligible({ spawnedBy: reloaded.spawnedByOf('worker-A'), … })` is still
   **`false`** for a worker at `userPrompts === 1` — proving the fork-bomb guard is
   NOT re-opened by the durability event.

## Verification

- `pnpm --filter @cockpit/core test` → **PASS**:
  `tests 144 | pass 144 | fail 0 | cancelled 0 | skipped 0 | todo 0`.
  `prefs.test.ts` alone: `tests 27 | pass 27 | fail 0` (was 24; **+3** durability
  tests). The three new cases are listed in the run as passing.
  (The full-suite total moved 137 → 144 during this work; +3 are mine, the other +4
  are unrelated `fold.test.ts` D1 tests added concurrently in the shared workspace —
  see `docs/review/fixes/fx-fold.md`. No interaction with prefs.)
- `pnpm --filter @cockpit/core build` (`tsc -p tsconfig.json`) → **PASS** (exit 0).

## Notes for other fix tasks

- **`engine.ts` logger wiring (out of my scope, optional follow-up).** `Prefs` now
  accepts an optional `log` and defaults to `console.error`, so the swallow is
  already observable without any engine change. If the engine owner wants prefs
  durability failures routed through the engine's own logger/telemetry instead of
  raw `console.error`, pass it at the single construction site
  `private readonly prefs = new Prefs();` (`engine.ts:161`) →
  `new Prefs(undefined, (m) => /* engine log */)`. Purely additive; the default
  already satisfies the "fail loud" requirement.
- **Fail-hard option.** If a later policy decision wants the safety-critical fields
  to refuse boot on corruption (the deep report's stricter `throw` variant), change
  the final `return empty();` in `load()`'s parse-failure branch to a `throw` after
  the rename+log. The `.corrupt-*` preservation already in place makes that safe
  (bytes are kept before throwing).
- **No protocol/fold/SSE surface touched** — this is a pure persistence-layer
  hardening; `CockpitPrefs` shape and all public `Prefs` methods are unchanged, so
  no downstream consumer (engine projection, MCP, web) needs updating.
