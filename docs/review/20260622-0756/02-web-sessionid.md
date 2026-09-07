# Review 02 — web: session id in info panel

- **Scope:** frontend-only, review of commit `5b45dcd` ("feat(web): show the session id in the info panel"). Review-only — no source edited.
- **Files in scope:**
  - `apps/web/src/components/SessionInfoPanel.tsx`
  - `apps/web/src/styles/components/info-panel.scss`
- **Change:** adds one selectable monospace line under the cwd in the info-panel header section, rendering the session UUID with a de-emphasized "ID" label.
- **Verdict: APPROVE.** No Critical/High/Medium issues. The change is correctly a pure projection of a backend-authoritative field, the value is rendered as escaped text (no XSS path), and it follows the existing info-panel class/token conventions. Only a few Low / informational cleanups noted.
- **Read-only verification:**
  - `pnpm --filter @cockpit/web lint` → pass (exit 0)
  - `pnpm --filter @cockpit/web typecheck` (`tsc --noEmit`) → pass (exit 0)

---

## Focused findings

### F1 — Projection purity: clean (PASS)
`SessionInfoPanel.tsx:363` renders `{session.sessionId}`. `sessionId` is the first
field of the backend-authoritative `SessionMeta` schema
(`packages/protocol/src/index.ts:457`, `sessionId: z.string()`), populated by the
Engine and delivered via snapshot/`session/patch`. The frontend does not fabricate,
derive, or cache this value — it is the same authoritative id already used for
intents in this very component (e.g. `pinSession(session.sessionId, v)` at
`SessionInfoPanel.tsx:372`). No client-side state was invented; backend-owns-state /
pure-projection is preserved. No action needed.

### F2 — XSS / injection: safe (PASS)
- Severity: **Informational**
- The UUID is rendered as a React text child (`SessionInfoPanel.tsx:363`), so React
  auto-escapes it; there is no `dangerouslySetInnerHTML`, no `href`/`src`/URL context,
  and the value is never interpolated into HTML or a CSS value.
- The `"ID"` label is a static string literal, not data.
- Even though a session id is a system-generated UUID (effectively non-attacker-
  controlled), the render path is the correct text-node path regardless. Nothing to fix.

### F3 — Sensitive-data exposure: clean (PASS)
Only the session UUID is surfaced. No token, secret, or new filesystem path is
exposed — the cwd shown on the line above (`info-meta-cwd`) is pre-existing and
unchanged. A session UUID is the intended, low-sensitivity identifier (it is exactly
what MCP tools / debugging key on, per the commit message). No leak.

### F4 — Layout / overflow / selectable-copy: clean (PASS)
- `.info-meta-id` uses `word-break: break-all` (`info-panel.scss:105`), mirroring
  `.info-meta-cwd` (`info-panel.scss:99`). A 36-char UUID wraps inside the panel and
  cannot blow out its width even at the narrowest (<600 full-page) tier.
- The label is a separate `inline-block` box (`info-panel.scss:109`), so `break-all`
  on the parent does not chop "ID" mid-word; it stays anchored at the line start while
  the value wraps after it.
- "Selectable to copy" works: `.info-panel-body` already enables `user-select: text`
  for all descendants (`base.scss:50`), and the element additionally carries
  `.selectable` (also whitelisted at `base.scss:51`). Copy behaves as described.

### F5 — Consistency with info-panel / tweb conventions: good (PASS)
The new row reuses the established contract `info-section-content info-meta-*`,
identical in structure to the cwd row directly above it
(`SessionInfoPanel.tsx:362-363`). Tokens used — `--font-size-13`, `--font-size-12`,
`--tertiary-text-color`, `--secondary-text-color` — all exist
(`tokens.scss:68-69`, `:98`, `:142`) and are used the same way elsewhere in this
stylesheet. Colors come from tokens only; no new spacing/radii/timing invented. This
is a domain-specific info row layered onto the existing cwd precedent, so it does not
introduce a new visual language and is not (by itself) registry-worthy in
`docs/cockpit-tweb-diff.md`.

---

## Low / cleanup (non-blocking)

### L1 — Redundant `.selectable` class on the ID line
- Severity: **Low**
- `SessionInfoPanel.tsx:363` — the line carries `selectable`, but the whole
  `.info-panel-body` is already `user-select: text` (`base.scss:50`). The class adds
  no behavior here (the cwd line above it has no `.selectable` and is equally
  selectable).
- Why it matters: harmless, but it implies selection is opt-in on this row when it
  isn't, which can mislead the next editor.
- Suggested fix: drop `selectable` from the className for clarity, or knowingly keep
  it as a no-op signal of intent. Not blocking.

### L2 — Dead `padding-top: 0;` declaration
- Severity: **Low**
- `info-panel.scss:106` — `.info-meta-id` sets `padding-top: 0;`, but `.info-section-content`
  already resolves to `padding: 0 1rem 0.7rem` (`info-panel.scss:94`), i.e. top is
  already `0`. The override is a no-op.
- Suggested fix: remove the line. (If the real intent was to tighten the gap to the
  cwd above, note that the spacing comes from the cwd row's own `padding-bottom: 0.7rem`,
  not from this element's top padding — so this declaration can't achieve that anyway.)

### L3 — Duplicated hardcoded monospace font stack (DRY)
- Severity: **Low**
- `info-panel.scss:102` repeats the literal stack
  `ui-monospace, SFMono-Regular, Menlo, monospace`, copied from `.info-meta-cwd`
  (`info-panel.scss:96`); the same stack is also hardcoded in `dialog.scss`. There is
  currently no `--font-mono` token in `tokens.scss`, so this change *follows* existing
  precedent rather than introducing a new hardcode — hence Low, not a violation of the
  "no hardcoded value a token covers" rule (no such token exists yet).
- Suggested fix (optional, repo-wide): introduce a `--font-mono` token (or a shared
  `.mono` selector) and point cwd, id, and dialog at it. Out of scope for this commit;
  noted so it doesn't keep multiplying.

### L4 — Mixed-language label (informational only)
- Severity: **Informational**
- The label text is the Latin `"ID"` while the surrounding info-panel labels are
  Chinese (`会话信息`, `置顶`). This is idiomatic ("ID" is standard in zh UIs) and
  consistent with using the raw UUID, so no change is recommended — flagged only for
  completeness.

---

## Summary

Small, well-scoped, correct. The session id is a backend-owned field rendered as
escaped text, with layout and selectability that match the existing cwd row and the
inherited token set; lint and typecheck both pass. Approve as-is. The only follow-ups
are three Low cleanups (redundant `.selectable`, dead `padding-top: 0`, and an optional
shared monospace token) — none block merge.
