# Cockpit incremental review — run 20260622-0756

**Type:** incremental (first marker-based run). The previous full 3-pass review was
committed at `675d1df` (`docs/review/*.md`). This run reviews only the code that
landed **since** that review: `675d1df..97418f5` — 2 commits, ~98 lines, 7 files.

| commit | what | surface |
|--------|------|---------|
| `5b45dcd` | feat(web): show the session id in the info panel | `SessionInfoPanel.tsx`, `info-panel.scss` |
| `97418f5` | feat(butler): add `engine.boot-complete` hook event | `protocol/index.ts`, `core/hooks.ts`, `core/engine.ts`, `mcp/tools/hooks.ts`, `hooks.test.ts` |

## Module reports

| # | Module | Scope | Verdict | Highest sev | Report |
|---|--------|-------|---------|-------------|--------|
| 1 | boot-complete event | protocol + core + mcp | Design sound, lands its promise | **Medium** | [01-boot-event.md](01-boot-event.md) |
| 2 | web session-id panel | apps/web | APPROVE as-is | Low | [02-web-sessionid.md](02-web-sessionid.md) |

## Severity rollup

- **Critical: 0. High: 0.** Both reviewers verified the load-bearing behaviors with
  passing tests (core 179 / protocol 19; web lint + typecheck).
- **Medium: 1** — boot hook + `cwd_prefix`/`source_session` filter silently never
  fires (no error at creation). The one real footgun.
- The rest are Low / defense-in-depth / comment-doc accuracy.

## Pass 2 (deep verification) — intentionally skipped, with rationale

Pass 2's gate is **High/Critical** findings (it confirms/refutes catastrophe
hypotheses with a working repro). This run produced **none**. The single Medium and
the Lows are not hypotheses — they are direct, by-inspection logic facts that the
Pass-1 reviewer already proved against the exact code paths and existing tests:

- Finding 1 (Medium): `f.sessionId && f.sessionId !== ev.sessionId` with the boot
  event's `ev.sessionId===''` drops any non-empty `source_session`; likewise
  `!''.startsWith(cwdPrefix)` drops any `cwd_prefix`. Self-evident; no repro needed.
- Finding 5 (Low): `'' === ''` self-drop only reachable if `ownerSession===''`,
  which the MCP already prevents (`z.string().min(1)`); protocol lacks the bound.

A full deep fleet would be disproportionate to a 98-line diff with zero
catastrophe-class findings. Proceeding directly to a tight, evidence-backed fix wave.

## Fix plan (Pass 3 — 1 wave, 2 disjoint-file sessions)

### fix-boot-event (backend) — owns `engine.ts`, `hooks.ts`, `hooks.test.ts`, `mcp/tools/hooks.ts`, `protocol/index.ts`
1. **[Medium] Finding 1** — fail loud: reject a `engine.boot-complete` hook created
   with `cwd_prefix` or `source_session` (boundary check in the MCP handler + engine
   `addHook`), since those filters can never match a source-less event. Add a focused
   test.
2. **[Low] Finding 5** — add `.min(1)` to `ownerSession` (protocol `HookEntry` +
   `hook/add` body) and guard the owner==source drop with `ev.sessionId !== ''`.
3. **[Low] Findings 2–4** — comment/doc accuracy only (no behavior change): scope the
   one-shot "can't be missed" claim to the restart window (not delivery durability);
   correct the `start()` ordering comment (scheduled-session preload is `void`-ed, not
   awaited — delivery ensureLoads the owner via the awaited `refreshList()` seed);
   clarify `once` is operative only for the global boot event.

### fix-web-sessionid (frontend) — owns `SessionInfoPanel.tsx`, `info-panel.scss`
1. **[Low] L1** — drop the redundant `.selectable` class (the whole `.info-panel-body`
   is already `user-select: text`).
2. **[Low] L2** — remove the dead `padding-top: 0;` (no-op; top padding already 0).
3. **L3 (shared `--font-mono` token)** — deferred: repo-wide refactor, out of scope
   for this commit.

Fix sessions change code + tests only; they do **not** commit/deploy. The master
commits once and graceful-restarts the backend (protocol/core changed) after a full
green regression.

## Method
- Pass 1: 2 dedicated cockpit sessions (autopilot, `claude-opus-4.8`), `cockpit`
  skill (web also `cockpit-frontend`); red-line orchestration skills disabled;
  welcome hook paused for the wave, restored after both first turns; both unloaded
  after their report landed.
