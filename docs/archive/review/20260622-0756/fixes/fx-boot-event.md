# Fix record — `engine.boot-complete` hook event (review 01-boot-event.md)

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../../README.md) · [归档边界](../../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/20260622-0756/fixes/fx-boot-event.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


One-shot fix worker, single pass. Source review: `../01-boot-event.md` (commit 97418f5).
Edit scope (file-ownership isolation): `packages/core/src/engine.ts`,
`packages/core/src/hooks.ts`, `packages/core/src/hooks.test.ts`,
`apps/mcp/src/tools/hooks.ts`, `packages/protocol/src/index.ts`. Nothing else touched.

---

## Finding 1 [Medium] — silent dead boot hook with a source filter → fail loud

**Problem:** A global `engine.boot-complete` event carries empty source fields
(`ev.sessionId === ''`, `ev.cwd === ''`), so any `cwd_prefix`/`source_session`
filter can never match → the hook silently never fires, with no error at creation.

**Change:** Reject at the boundary in BOTH places (defense in depth):
- Added a pure, single-source-of-truth guard `bootFilterRejection(event, filter)` to
  `hooks.ts` and used it in `engine.addHook`.
- Added the same check inline in the MCP `cockpit_hook_add` handler (the MCP package
  doesn't depend on `@cockpit/core`, so it can't import the helper — kept a parallel
  inline check rather than add a cross-package dep that would touch out-of-scope
  `apps/mcp/package.json`).
- Error message: `source filters (cwd_prefix/source_session) don't apply to the global
  engine.boot-complete event (it has no source)`.
- `excludeSelf` is intentionally NOT rejected (harmless on a `''` source).

**file:line:**
- `packages/core/src/hooks.ts:31-39` — new `bootFilterRejection`.
- `packages/core/src/engine.ts:36` — import; `engine.ts:1829-1834` — guard in `addHook`.
- `apps/mcp/src/tools/hooks.ts:96-101` — inline guard in the tool handler.

---

## Finding 5 [Low] — empty `ownerSession` self-drops a boot hook (`'' === ''`)

**Problem:** `hooks.ts` dropped `ev.sessionId === hook.ownerSession`. On a global
boot event (`ev.sessionId === ''`), a hook with `ownerSession === ''` would self-drop.

**Change:**
- `protocol/index.ts`: `HookEntry.ownerSession` and the `hook/add` body `ownerSession`
  are now `z.string().min(1)`.
- `hooks.ts`: tightened the owner==source drop to
  `ev.sessionId !== '' && ev.sessionId === hook.ownerSession` (defense-in-depth for a
  malformed direct loopback intent that bypasses the schema).

**file:line:**
- `packages/protocol/src/index.ts:229` (`HookEntry.ownerSession`),
  `packages/protocol/src/index.ts:878` (`hook/add` body).
- `packages/core/src/hooks.ts:114` — the guarded drop.

---

## Findings 2 / 3 / 4 [Low] — comment/doc accuracy only (NO behavior change)

**Finding 2 — one-shot removal vs delivery durability** (`engine.ts` `fireEvent`
auto-remove comment): reworded so the robustness claim is scoped to the *restart
window* (the hook fires the instant the engine is up) and the owner's *follow-up*
turn failing — explicitly NOT durability of the single delivery (a `prompt()`
rejection or a second restart before the enqueued turn runs is not re-fired, since
the hook is already persisted-removed).
- `packages/core/src/engine.ts:1653-1662`.

**Finding 3 — `start()` boot-delivery ordering comment**: removed the false "list +
scheduled sessions are loaded" guarantee. `loadScheduledSessions()` is `void`-ed (not
awaited); the real mechanism is the awaited `refreshList()` seeding every session's
meta into the map + each delivery's `prompt → ensureLoaded` loading its owner on
demand. Scheduled-session preload is incidental, not relied upon.
- `packages/core/src/engine.ts:281-292`.

**Finding 4 — `once` is only operative for the global event**: clarified that for the
source-keyed `session.first-turn-complete`, dedup is the persisted welcomed-bit
(`markWelcomed`/`isWelcomed`) so `once` is effectively a no-op there; `once` only
matters for `engine.boot-complete` (fire then auto-remove).
- `packages/protocol/src/index.ts:237-241` (`HookEntry.once` doc).
- `apps/mcp/src/tools/hooks.ts:88-90` (`once` + `cwd_prefix`/`source_session`
  `.describe()` text — boot-event notes added).
- `packages/core/src/engine.ts:1653-1662` (folded into the Finding 2 rewrite).

---

## Tests added

`packages/core/src/hooks.test.ts` (closest in-scope test file; `engine.test.ts` is
out of edit scope, so Finding 1 is unit-tested via the extracted pure
`bootFilterRejection` helper):

- **Finding 1**: `bootFilterRejection` rejects a boot hook with `cwd_prefix` or
  `source_session` (and both); allows a boot hook with no source filter / `excludeSelf`;
  allows source filters on the source-keyed first-turn event.
- **Finding 5**: a boot hook with an empty `ownerSession` does NOT self-drop on the
  source-less boot event (`hookMatchesEvent(... ownerSession:'' ...) === true`), while a
  real owner==source still drops on a source-keyed event.

---

## Verification results

```
pnpm --filter @cockpit/core test      → tests 183, pass 183, fail 0   (was 179; +4 new)
pnpm --filter @cockpit/protocol test  → tests 19,  pass 19,  fail 0
pnpm --filter @cockpit/core build     → tsc -p tsconfig.json, exit 0
pnpm --filter @cockpit/protocol build → tsc -p tsconfig.json, exit 0
pnpm --filter @cockpit/mcp build      → tsc -p tsconfig.json, exit 0
```

All green, no regressions. `git status` confirms only the 5 in-scope files changed
(the two `apps/web/*` modifications in the tree are pre-existing and were left
untouched).

---

## Deferred items (NOT done here — out of scope / left to master)

- No git commit / no server restart / no deploy / no nginx change (master does these).
- The MCP guard is a parallel inline copy of `bootFilterRejection` because `@cockpit/mcp`
  has no `@cockpit/core` dependency; unifying them would require editing the
  out-of-scope `apps/mcp/package.json`. Left as-is (both boundaries reject; behavior is
  identical).
- Finding 2's optional *stronger durability* variant (gate the one-shot removal on
  `prompt()` resolving `ok`) was **not** taken — per the review this is a reasonable
  tradeoff for the canonical one-restart case; the chosen semantic (fire-and-forget +
  accurate comment) is documented instead.
- The pre-existing `apps/web/src/components/SessionInfoPanel.tsx` and
  `apps/web/src/styles/components/info-panel.scss` working-tree edits belong to another
  worker's scope and were not touched.
