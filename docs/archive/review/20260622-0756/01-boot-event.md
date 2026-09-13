# Review — `engine.boot-complete` hook event (commit 97418f5)

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../README.md) · [归档边界](../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/20260622-0756/01-boot-event.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


**Scope:** review-only (no source edits). One-shot worker, single pass.
**Verdict:** Design is sound and lands its core promise. **No Critical/High issues.**
Findings are one Medium footgun, plus Low refinements (mostly comment/doc accuracy
and defense-in-depth). Tests pass locally: **core 179 / protocol 19**, all green.

---

## What was verified GOOD (checked explicitly, no change needed)

- **Self-re-drive works — the owner==source drop is correctly bypassed for globals.**
  `hookMatchesEvent` drops `ev.sessionId === hook.ownerSession` (`hooks.ts:96`). For a
  boot event the source is `''`, which never equals a real owner id, so a session CAN
  hook `engine.boot-complete` to re-drive *itself*. Covered by the new test
  "a boot hook matches the source-less boot event regardless of owner".
- **Auto-remove is per-hook-id scoped — no cross-owner mis-deletion.**
  `engine.ts:1655` removes via `hookReg.stop(d.hook.id)`; each delivery carries a
  distinct hook id and `matchHooks` emits at most one delivery per hook, so two owners'
  one-shot boot hooks are removed independently. No "错删别人的".
- **The restart-window promise holds.** The hook registry is persisted in prefs and
  reloaded at construction (`engine.ts:267–275`); a one-shot boot hook therefore
  survives a graceful restart and is fired on the *new* process's `start()`
  (`engine.ts:288`). The event IS the post-restart signal, so it cannot be "missed in
  the restart window" the way a timed tick can.
- **Failed boot does NOT fire the event (correct).** `fireEvent(boot)` is the last line
  of `start()`; `bootstrap()`/`refreshList()` are awaited before it (`engine.ts:249,255`),
  so if boot throws, `start()` rejects first and the event never fires. `main().catch →
  process.exit(1)` (`apps/server/src/index.ts:610,624`) lets systemd retry. The engine
  never claims boot-complete on a half-started engine.
- **Delivery ensureLoads the owner (the documented claim).** `fireEvent → prompt →
  ensureLoaded` (`engine.ts:1645,1017`); `refreshList()` is awaited (`engine.ts:255`)
  so even an unloaded owner exists as a cold `SessionState` in the map and is
  addressable. The daemon need not stay resident — confirmed.
- **`live == replay` projection is untouched.** `fireEvent` emits **no** `ServerEvent`
  on the bus; its only effects are ordinary `prompt()`/`runFlow()` events folded the
  normal way. No new projection path, no snapshot/replay divergence.
- **R1 anti-fork-bomb intact.** Boot is *engine*-triggered, not a session lifecycle, so
  it is not a "trigger source"; `spawnedBy` only gates `first-turn-complete` emission and
  is irrelevant here. Boot fires exactly once per process boot → no amplification loop.
- **Protocol/zod ↔ MCP consistency.** `SessionEventType` enum (`protocol/index.ts:206`),
  `SessionEventCtx`, `HookEntry`, the `hook/add` body (`:872`), and the MCP
  `EVENTS` enum (`apps/mcp/src/tools/hooks.ts:15`) all agree on the two-value set.
  Tests green.

---

## Findings

### 1. [Medium] A `cwd_prefix` / `source_session` filter on a boot hook makes it silently never fire
**Where:** `packages/core/src/hooks.ts:88–92` (matching) + `apps/mcp/src/tools/hooks.ts:88–89,97–103` (tool still accepts the filters for the boot event).

**Why it matters:** A global boot event carries empty source fields (`ev.cwd===''`,
`ev.sessionId===''`). In `hookMatchesEvent`:
- `if (f.sessionId && f.sessionId !== ev.sessionId) return false;` → any non-empty
  `source_session` ⇒ `x !== '' ` ⇒ **dropped**.
- `if (f.cwdPrefix && !ev.cwd.startsWith(f.cwdPrefix)) return false;` →
  `!''.startsWith(x)` is `true` ⇒ **dropped**.

So a boot hook created with *either* filter never matches, with **no error at creation**.
The MCP tool advertises both params generically ("Filter: only sources whose cwd starts
with this" / "only this exact source session id") with no note that they are meaningless
and fatal for `engine.boot-complete`. An operator who copies a first-turn-hook recipe and
adds `cwd_prefix` gets a silently dead hook — exactly the "本应触发的 hook 被漏掉" case.

**Fix (pick one):**
- Reject at the boundary: in `addHook` (`engine.ts:1808`) and/or the MCP handler, error
  if `event === 'engine.boot-complete'` and `filter.cwdPrefix`/`filter.sessionId` is set
  ("source filters don't apply to the global boot event"). Cleanest — fail loud.
- Or strip those filter fields for the boot event and document it.
- At minimum, amend the `cwd_prefix`/`source_session` `.describe()` text to say
  "ignored / must be omitted for engine.boot-complete (it has no source)".

(`excludeSelf` is harmless — it can never drop a `''` source — so no action there.)

---

### 2. [Low→Medium] A one-shot boot hook is removed *before* delivery is confirmed
**Where:** `packages/core/src/engine.ts:1653–1659` (auto-remove) relative to the
fire-and-forget dispatch at `:1643–1646`.

**Why it matters:** The removal runs synchronously right after `void this.prompt(...)`,
independent of whether the enqueue succeeded. `prompt()` rejections are only `.catch`-logged
(`:1646`). Consequences:
- If the owner session is gone (`prompt` throws "unknown session"), the once-hook is
  removed **without ever delivering**.
- If the engine restarts again before the owner's just-enqueued turn runs, the hook is
  already persisted-removed and will **not** re-fire — the verification never happens.

The "can't be missed" guarantee covers the *restart window* (the hook fires the instant
the engine is up), but **not** durability of the single firing. That's a reasonable
tradeoff for the canonical one-restart case, but the inline comment overstates it:
"robust even if the owner's follow-up turn fails" is true only for the owner's *follow-up*
turn, not for the *delivery* itself.

**Fix:** Either accept and reword the comment to scope the robustness claim to the owner's
turn (not the delivery), or — if stronger durability is wanted — remove the hook only after
`prompt()` resolves `ok` (a small change that keeps fire-and-forget for the turn while
gating removal on successful enqueue). Document whichever semantic is chosen.

---

### 3. [Low] `start()` comment overstates the ordering guarantee for boot delivery
**Where:** `packages/core/src/engine.ts:281–288` vs `:266`.

**Why it matters:** The comment says boot is "Fired last, so the list + **scheduled
sessions are loaded** and deliveries can ensureLoad their owner." But
`loadScheduledSessions()` (`:266`) is `void`-ed (not awaited), so scheduled sessions are
generally **not** loaded when `fireEvent` runs. This is harmless — delivery ensureLoads the
owner itself via the cold `SessionState` that the awaited `refreshList()` (`:255`) put in the
map — but the comment implies a guarantee the code does not provide, which can mislead a
future reader into depending on preload ordering.

**Fix:** Reword to credit the actual mechanism: awaited `refreshList()` seeds every session's
meta, and `prompt → ensureLoaded` loads the owner on demand; scheduled-session preload is
incidental, not relied upon.

---

### 4. [Low] Doc/comment implies `once` is a per-hook knob for source-keyed events — it isn't
**Where:** `engine.ts:1649–1652` (comment), `protocol/index.ts:237`, `apps/mcp/src/tools/hooks.ts:90`.

**Why it matters:** The new comment says "A source-keyed event's `once` is handled by its
own dedupe and is left alone," and the protocol/MCP docs frame `once` as "fire at most once
per source." In reality `hook.once` is **never read** on the `session.first-turn-complete`
path; that event is deduped by the global per-source `markWelcomed`/`isWelcomed` bit
(`engine.ts:1614,1620`), independent of any hook's `once` flag. So setting `once:false` on a
first-turn hook still fires only once per source. Pre-existing (not introduced by this
commit), but the new wording reinforces a wrong mental model now that a *second* event type
exists where `once` genuinely is a per-hook knob.

**Fix (doc-only):** Clarify that `once` is only operative for the global event
(`engine.boot-complete`); for `session.first-turn-complete` dedup is the persisted
welcomed-bit and `once` is effectively a no-op.

---

### 5. [Low] An empty `ownerSession` would make a boot hook self-drop (`'' === ''`)
**Where:** `packages/core/src/hooks.ts:96`.

**Why it matters:** If a hook ever had `ownerSession === ''`, then for a boot event
`ev.sessionId === hook.ownerSession` is `'' === ''` → `true` → the boot hook is dropped.
The MCP enforces `owner_session: z.string().min(1)` and the normal path always supplies a
real id, but the protocol `HookEntry.ownerSession`/`hook/add` body is `z.string()` with no
`.min(1)` (`protocol/index.ts:229,874`), so a malformed direct loopback intent could create
one. Low risk, defense-in-depth only.

**Fix:** Add `.min(1)` to `ownerSession` in the protocol, and/or guard the owner==source drop
with `ev.sessionId !== '' && ev.sessionId === hook.ownerSession`.

---

## Test evidence (read-only)

```
pnpm --filter @cockpit/core test      → tests 179, pass 179, fail 0
pnpm --filter @cockpit/protocol test  → tests 19,  pass 19,  fail 0
```
The added tests correctly assert the load-bearing behaviors: `isGlobalEvent` classification,
the source-less match-regardless-of-owner (self-re-drive), cross-event non-matching, and
boot-only delivery from `matchHooks`. Not directly covered by a test: the engine's
`once`→auto-remove loop (Finding 2) and the filter-drops-boot footgun (Finding 1) — both
exercised only indirectly. Worth a focused engine test if either fix lands.

## Bottom line
Ship-able as-is for the canonical "daemon verifies its own deploy restart" path. Recommend
addressing **Finding 1** (silent filter footgun) before wider use, and the comment/doc
tweaks in 2–4 to keep the mental model honest.
