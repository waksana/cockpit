# Fix record — fx-web-sessionid

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../../README.md) · [归档边界](../../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/20260622-0756/fixes/fx-web-sessionid.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


- **Source review:** `docs/review/20260622-0756/02-web-sessionid.md` (commit `5b45dcd`, web: session id in info panel)
- **Verdict in report:** APPROVE — no Critical/High/Medium. 2 Low cleanups actioned, 1 Low deferred.
- **Files allowed / touched (file-ownership isolation respected):**
  - `apps/web/src/components/SessionInfoPanel.tsx`
  - `apps/web/src/styles/components/info-panel.scss`
- **Out-of-scope (master does this):** no git commit, no server restart, no deploy, no nginx, no `apps/web/dist` artifacts staged.

---

## L1 — Redundant `.selectable` class on the ID line  (Low → fixed)

- **Problem:** The session-id row carried `selectable`, but the whole `.info-panel-body`
  is already `user-select: text` (`base.scss:50`), and the cwd row directly above has no
  `.selectable` yet is equally selectable. The class was a no-op that implied selection is
  opt-in on this one row, which can mislead the next editor.
- **Change:** Dropped `selectable` from the ID row's className only (left every other
  `.selectable` usage untouched).
- **File:line:** `apps/web/src/components/SessionInfoPanel.tsx:363`
  - before: `className="info-section-content info-meta-id selectable"`
  - after:  `className="info-section-content info-meta-id"`

## L2 — Dead `padding-top: 0;` in `.info-meta-id`  (Low → fixed)

- **Problem:** `.info-section-content` already resolves to `padding: 0 1rem 0.7rem`
  (`info-panel.scss:94`), so top padding is already `0`; the override was a no-op (and
  could not have tightened the gap to the cwd row anyway — that spacing comes from the
  cwd row's own `padding-bottom`).
- **Change:** Removed the `padding-top: 0;` declaration from the `.info-meta-id` block.
- **File:line:** `apps/web/src/styles/components/info-panel.scss:106` (removed)

## L3 — Shared `--font-mono` token  (Low → DEFERRED)

- **Status:** Deferred, intentionally not done in this fix.
- **Reason:** Introducing a `--font-mono` token (or shared `.mono` selector) and pointing
  `.info-meta-cwd`, `.info-meta-id`, and `dialog.scss` at it is a repo-wide refactor that
  reaches beyond commit `5b45dcd` and beyond the two in-scope files. The current monospace
  stack *follows* existing precedent (`.info-meta-cwd`, `dialog.scss`) rather than
  introducing a new hardcode, so there is no token-violation to remediate here. Track as a
  separate repo-level cleanup.

## L4 — Mixed-language "ID" label  (Informational → no change)

- No action requested by the report (idiomatic in zh UIs, consistent with the raw UUID).

---

## Verification

- `pnpm --filter @cockpit/web lint` → **pass** (eslint, exit 0)
- `pnpm --filter @cockpit/web typecheck` (`tsc --noEmit`) → **pass** (exit 0)
- `git diff` confirms exactly the two intended hunks (one line changed in the TSX, one line
  removed in the SCSS) and nothing else. No `apps/web/dist` artifacts staged.

## Deferred items

- **L3** — shared `--font-mono` token / `.mono` selector across `info-panel.scss` + `dialog.scss`
  (repo-wide DRY cleanup, out of scope for this commit).
