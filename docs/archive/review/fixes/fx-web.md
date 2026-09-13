# Fix: Web pure-projection consistency (fx-web)

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../README.md) · [归档边界](../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/fixes/fx-web.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


Implements the three web-side items from the deep review
`docs/review/deep/dr-web-projection.md` (findings 1, 4a, and 3). Depends on
`docs/review/fixes/fx-engine.md` item **F**, which made the engine throttle-forward
the authoritative `lastActivity` as a bare `session/patch {sessionId, lastActivity}`
— so the client no longer needs (and must not have) a synthesized value.

**Scope honored:** only `apps/web/src/**` was modified. No protocol/server/core/
mcp/fold source was touched. No git ops, no server restart, no deploy (a frontend
deploy is a rebuild, left for the owner). Tests never touch the real `~/.copilot`.

All line numbers are **post-edit**.

---

## 1. Pure-projection leak — client-synthesized `lastActivity` (dr-web-projection §1)

**Problem.** The `msg/upsert` reducer fabricated `lastActivity: Date.now()` on the
client. `lastActivity` is server-owned domain truth that both *orders* and
*timestamps* the sidebar (`Sidebar.tsx` sort + `dialog-time`). Because the reducer
is gated on `s.materialized` (only the *viewing* device materializes a session),
the synthetic bump fired on exactly one device — guaranteeing two-device divergence
in list order and relative time, self-healing only on a full reconnect snapshot.
This is the exact bug class the pure-projection rule exists to kill.

**Change.** Dropped the synthesized field; the reducer now returns
`{ ...s, messages }` and projects nothing it doesn't own.

- `apps/web/src/net/store.ts:299` — `return { ...s, messages };` (was
  `return { ...s, messages, lastActivity: Date.now() };`). Comment rewritten to
  document that the engine forwards the value.

**Why no other client change is needed.** fx-engine F now emits a throttled bare
`session/patch {sessionId, lastActivity}` on genuine activity. The existing
`session/patch` reducer (`apps/web/src/net/store.ts:228-240`, `{ ...s, ...patch }`)
applies it to **every** matching session regardless of `materialized` — so all
devices reorder/timestamp identically from the single server authority. Ordering and
display therefore stay correct (and become *more* correct cross-device): the sidebar
keeps sorting by `lastActivity` and rendering `relTime(lastActivity)`, now fed only
server truth.

**Not touched (benign, per the report's complete-list table):**
- `store.ts:470` `openPreview` stub `lastActivity: Date.now()` — local-only scratch
  for the trash preview, never inserted into `sessions`, so never sorted/timestamped
  in the sidebar. Left as-is.
- `Sidebar.tsx` / `SessionInfoPanel.tsx` `relTime(...)` reads of `Date.now()` — a
  legitimate *display* derivation (server absolute timestamp + current clock), not
  held domain state. Left as-is.

## 2. Rename-dialog Enter stale-closure (dr-web-projection §4a)

**Problem.** `Dialog.tsx` registered a window `keydown` listener once on mount with
empty deps, capturing the mount-time `confirm`, which closed over the mount-time
`value` (= `input.initial`, the old title). Pressing **Enter** in the rename dialog
called `onConfirm(input.initial)` — silently renaming the session to its existing
name — while the user believed their typed text was applied. The confirm *button*
(fresh `confirm` each render) worked; only the Enter path was broken.

**Change.** Moved Enter handling onto the input's own `onKeyDown` (re-created each
render, so it reads the current `value`), mirroring the correct pattern in
`DirPicker.tsx`. The window listener now handles **Escape only**.

- `apps/web/src/components/Dialog.tsx:31-33` — `onKey` dropped the `Enter` case,
  keeps `Escape`.
- `apps/web/src/components/Dialog.tsx:52` — input gains
  `onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } }}`.

The empty-array effect now legitimately depends only on `input`/`onCancel`
(focus/select + Escape), so the existing `exhaustive-deps` disable stays accurate.

## 3. Dead `data:` image branch (dr-web-projection §3)

**Problem.** `MessageBody.tsx`'s `isImgSrcAllowed` accepted inline
`data:image/...;base64,` URIs, but react-markdown v10's `defaultUrlTransform` strips
any `src` whose protocol is not in `safeProtocol` (`https?|ircs?|mailto|xmpp`) to
`''` *before* this custom renderer runs. So a `data:` src always arrives empty and
fails the `!src` guard — the branch was unreachable dead code that implied support
that doesn't exist (a misleading XSS-surface signal).

**Change.** Removed the `data:image/...;base64,` regex branch and rewrote the
allowlist comment to describe only the live rule (same-origin `/`, `./`, `../`
paths) and to note explicitly that react-markdown neutralizes `data:`/`javascript:`
srcs upstream.

- `apps/web/src/components/MessageBody.tsx:5-18` — comment + function trimmed; the
  `/^data:image\/.../i` test deleted.

**No behavior change.** Security is unaffected (the branch was already inert and
stricter-than-intended). Same-origin `/uploads/` attachment rendering is unchanged:
that path flows through the fold's `/uploads/` same-origin allowlist
(`packages/core/src/fold.ts`, out of scope here and already verified safe by the
report's §4b), not through this markdown `img` renderer. The same-origin `/`-prefix
branch that real `/uploads/...` markdown images would use is retained.

---

## Verification

```
pnpm --filter @cockpit/web lint        # eslint: clean (exit 0)
pnpm --filter @cockpit/web typecheck   # tsc --noEmit: clean (exit 0)
node ./node_modules/vite/bin/vite.js build   # (run from apps/web) built OK; dist regenerated
```

(The build was run with `node ./node_modules/vite/bin/vite.js build` from
`apps/web` — the local vite binary — not the `pnpm exec` wrapper, which trips a
deps-check on the ignored `@parcel/watcher` script. The only build warning is the
pre-existing >500 kB chunk-size note, not an error.)

apps/web has no test suite (`package.json` exposes only dev/build/typecheck/lint),
so reducer behavior was reasoned through against the live `session/patch` path
rather than unit-tested. The report (§ New findings 6) recommends adding a vitest
store-reducer suite (feed-twice idempotency + reconnect-merge invariants) — left as
future work since adding a test toolchain is outside this fix's scope.

---

## Limited / deferred items

1. **No automated coverage of the store reducer.** The `lastActivity` removal relies
   on the engine's forwarded patch (fx-engine F) reaching the materialization-agnostic
   `session/patch` reducer; verified by reading both ends, not by a test. A store-level
   `live == replay` / reconnect-merge vitest suite would lock this in (report §6).
2. **MCP/Skills optimistic toggle** (`Manage.tsx`) flagged by the report (§5, Low)
   was **left untouched** — it is bounded panel state (not the SSE store) that
   self-corrects via `.then(load).catch(load)`, and it was not part of this task's
   three assigned items.
3. **Frontend not deployed.** Per the hard constraints, no rebuild-as-deploy was
   shipped beyond the local validation build; the owner performs the deploy.
