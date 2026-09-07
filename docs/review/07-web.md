# Module 7 — Web frontend

## Summary
The frontend is in strong health and lives up to its charter: the Zustand store
is a disciplined pure projection (deletes/pins/model changes are non-optimistic,
the "needs-you" signal derives purely from server `attention`/`attnId`/`seenId`,
reconnect resumes from a durable message-id cursor with id-deduped merging) and
`MessageBody` is XSS-safe (react-markdown v10, no `rehype-raw`, all URL
attributes sanitized upstream). No Critical or High issues. The notable risks are
narrower: one genuine pure-projection leak in the store (`lastActivity` is
synthesized client-side), one optimistic mutation in the MCP/Skills toggles, a
stale-closure bug in the rename dialog's Enter handler, and a stray emoji that
breaks the no-emoji rule. The biggest structural gap is process, not code: there
are **zero automated tests** for the app, including the reconnect/merge logic.

## Findings

### [Critical] — none
No Critical issues found. No `dangerouslySetInnerHTML`, no `rehype-raw`, no raw
HTML rendering, no un-sanitized markdown sink, no eval/Function, no auth/secret
handling on the client.

### [High] — none
No High issues found.

### [Medium] Store synthesizes `lastActivity` on the client — `net/store.ts:294`
- **What** The `msg/upsert` handler returns `{ ...s, messages, lastActivity: Date.now() }`. `lastActivity` is server-owned domain state (`SessionMeta.lastActivity`, `packages/protocol/src/index.ts:436`). The `msg/upsert` event carries **no** `lastActivity`, and the engine deliberately omits it from patches (`packages/core/src/engine.ts:1845` — "forwarded ONLY when a patch sets it"). The client invents the value from its own clock.
- **Why it matters** This is the exact bug class the pure-projection rule exists to kill. The bump only happens on a *materialized* session (the early `if (!s.materialized) return s;` at `store.ts:286`), so the device viewing a streaming turn floats that session to the top of the sidebar and shows "刚刚", while a second device that isn't viewing it keeps the stale snapshot value — divergent sidebar ordering and relative-time across devices. It self-heals only on a full reconnect snapshot (which re-spreads the server value), not at turn end.
- **Recommendation** Stop deriving it: drop `lastActivity: Date.now()` from the `msg/upsert` reducer and let ordering reflect the server's value (forwarded via snapshot, or via an explicit `session/patch` if the protocol/engine owners decide the list should reorder live). If a live "active session floats up" affordance is wanted, it should be server-driven so all devices agree.

### [Medium] Optimistic toggle mutation in MCP/Skills panels — `components/Manage.tsx:84,109`
- **What** Both `SessionMcp.toggle` and `SessionSkills.toggle` optimistically `setRows(... { ...x, enabled: on, status: ... })` *before* the server confirms, then reconcile with `.then(load).catch(load)`.
- **Why it matters** It contradicts the explicit owner doctrine ("at no time insert optimistically — check there are no optimistic inserts anywhere"). The mitigation is real — these rows are ephemeral request-response panel state, not the SSE store, and the follow-up `load()` reconciles to server truth on both success and failure — so divergence is short-lived and self-correcting. But it's the one place in scope that holds an unconfirmed domain value, however briefly.
- **Recommendation** Keep the discipline uniform: drop the optimistic `setRows` and reflect a per-row pending state until `mcpToggleSession`/`skillsToggleSession` resolves, then `load()`. (Enablement isn't SSE-projected, so a re-fetch is the honest source anyway.)

### [Medium] Rename dialog Enter handler uses a stale closure — `components/Dialog.tsx:24-38`
- **What** `confirm()` closes over `value`; the keydown listener is registered in a `useEffect(..., [])` (deps intentionally empty, eslint-disabled). The listener therefore captures the **mount-time** `confirm`, which captures the mount-time `value` (= `input.initial`). The confirm **button** uses the fresh `confirm` and works; the **Enter key** does not.
- **Why it matters** The only input-bearing dialog is rename (`App.tsx:197`). Typing a new name and pressing Enter calls `onConfirm(input.initial)` — i.e. renames the session to its *old* title (a silent no-op), while the user believes they renamed it. A real correctness bug on a common interaction.
- **Recommendation** Read the latest value via a ref, or include `confirm`/`value`/`input` in the effect deps, or move Enter handling onto the input's `onKeyDown` (where `value` is current — see `DirPicker.tsx:54` which does exactly this correctly).

### [Medium] Emoji in the subagent card breaks the no-emoji rule — `components/Thread.tsx:165`
- **What** `<span className="subagent-ico" aria-hidden="true">🤖</span>` renders a literal robot emoji. It's the only emoji actually rendered in the UI (the rest are in comments).
- **Why it matters** "No emoji in the UI" is a stated hard taste rule, and nothing in `docs/cockpit-tweb-diff.md` sanctions this. Every other glyph in the app is a `tgico` font icon via `<Icon>`; this one row is inconsistent.
- **Recommendation** Replace with an `<Icon>` glyph (the codebase already uses tgico for skills/tools/status), or a CSS monogram, consistent with the rest of the icon system.

### [Low] Info panel data doesn't live-refresh during a turn — `components/SessionInfoPanel.tsx:301-328`
- **What** Plan, todos, and changed-files are fetched on demand into local state and re-fetched only when the panel opens or `sid`/`scheduleCount`/`hookCount` change. There is no trigger tied to the agent updating todos/plan mid-turn.
- **Why it matters** With the info panel open while the agent works, the todo checklist / plan / changed-files can show stale content until the panel is closed and reopened or the session is switched. It's read-only derived data (not an optimistic mutation), so it's a consistency gap rather than a projection violation, but it can mislead.
- **Recommendation** Drive a re-fetch off a lightweight SSE-projected signal (e.g. a `todo`/plan revision counter on `SessionMeta`, mirroring the existing `scheduleCount`/`hookCount` pattern), or refetch on the session's `status`/`todo` patch.

### [Low] `data:image` allowlist in MessageBody is effectively dead — `components/MessageBody.tsx:11-16`
- **What** `isImgSrcAllowed` accepts `data:image/{png,jpeg,jpg,gif,webp};base64,` URIs, but react-markdown v10's `defaultUrlTransform` strips any `data:` URL to `''` *before* the custom `img` component runs (verified in `react-markdown@10.1.0/lib/index.js` — `data:` isn't in `safeProtocol`). So a data-URI image arrives as `src=''`, fails the allowlist, and always renders as "[image blocked]".
- **Why it matters** Purely functional: inline base64 images claimed to be supported never render. Security posture is unaffected (it's stricter than intended, not weaker). Worth correcting so the comment matches reality and the feature works if desired.
- **Recommendation** Either drop the dead `data:` branch (and the comment) to avoid implying support, or pass a custom `urlTransform` that preserves vetted `data:image/...;base64,` while still stripping everything else — then the existing allowlist becomes the real gate.

### [Low] `AttachmentView` trusts `att.url` without constraining origin/path — `components/Thread.tsx:50-68`
- **What** `href = ${BASE_URL}${att.url}` feeds both an `<img>` and a download `<a>`. In production `BASE_URL` is `''`, so an absolute `att.url` (e.g. `https://evil.example/x`) would resolve to that off-origin URL verbatim. `att.url` originates from the fold parsing a `<cockpit-attachment url="...">` marker, which an agent can emit.
- **Why it matters** Not XSS, but an agent-emitted (or tool-output-injected) marker could make the client hotlink an external image (IP/timing leak) or render an off-origin "download" card. The frontend assumes, but never enforces, that attachments live under `/uploads/`.
- **Recommendation** Constrain `att.url` in `AttachmentView` to a same-origin `/uploads/...` path (reject/escape otherwise). The marker parsing lives in `packages/core` (the fold), so the durable fix is cross-cutting — see Cross-cutting below.

### [Low] `Icon` sizes via inline style + hardcoded px — `components/Icon.tsx:45-55`
- **What** `<Icon>` sets `style={{ fontSize: size }}` from a numeric prop, and call sites pass hardcoded `size={15|18|22|24|26}` throughout.
- **Why it matters** Mild deviation from the "presentation is pure CSS / no inline style / no hardcoded px outside the token ladder" doctrine. It's pragmatic and pervasive (and distinct from the *sanctioned* JS positioning in `ContextMenu`/`AnchoredMenu`/`ModeMenu`, which genuinely needs runtime coordinates, and the avatar `--chip-h` bridge in `Sidebar.tsx:66`, sanctioned by deviation #3). Flagged only for completeness — likely an accepted pragmatic exception, but the icon scale isn't expressed as tokens.
- **Recommendation** If strict adherence is wanted, express icon sizes as a small set of CSS size classes/tokens rather than per-call px. Otherwise document it as an accepted exception.

## Test coverage assessment
**Effectively none.** `apps/web` ships no test runner and no `*.test.*`/`*.spec.*`
files; `package.json` exposes only `dev`/`build`/`typecheck`/`lint`. The
static gate (eslint + `tsc --noEmit`) passes clean, which catches type/lint
regressions but nothing behavioral. The highest-value, highest-risk logic is
entirely untested:
- the store's `onEvent` projection — snapshot rebuild, reconnect resume
  (`afterMsgId` cursor), the `session/history-page` append/latest/prepend
  dedup-merge, `session/reset`, and the attention/seen → badge derivation;
- the error-reporter storm-safety (dedup/cooldown/rate-cap/reentrancy);
- `lib/nav.ts` `parentOf`/`useUp` hierarchy math.
These are pure functions or pure reducers and are cheap to unit-test (vitest).
Recommend adding at least a store-reducer suite asserting the `live == replay`
analog on the client (feeding the same events twice is idempotent) and the
reconnect-merge invariants, since those guard the exact bugs cockpit exists to
prevent. The chrome-devtools MCP visual pass (per the frontend skill) covers the
responsive tiers and the doc-vs-bubble contract that unit tests can't.

## Positive notes
- **Store is genuinely pure-projection** outside the one `lastActivity` leak:
  deletes wait for `session/removed`, pin/model/mode are fire-and-forget with the
  value arriving back via `session/patch`, and unread/badge derive purely from
  server `attention`/`attnId`/`seenId` with **no** per-device flags (`store.ts:54`
  comment and the `seenActiveIfVisible` guard are well-reasoned).
- **Reconnect handling is careful**: client owns reconnect with backoff +
  online/visibility kick (`client.ts:89-110`), inbound events are
  `ServerEvent.safeParse`d (never silently dropped), and resume uses a durable
  message-id cursor with id-deduped append so the paginated scrollback and scroll
  position survive a blip.
- **`MessageBody` is XSS-safe by construction**: react-markdown v10 with no
  `rehype-raw` (raw HTML → text), `defaultUrlTransform` strips
  `javascript:`/`vbscript:`/`file:`/`data:` on every URL attribute *before* the
  custom renderers run, links get `rel="noopener noreferrer"`, and an image
  allowlist with a click-through fallback means nothing is silently lost.
- **`sw.ts` is correct**: badge updated first, banner suppressed when a client is
  visible (matches the in-page notifier gate), and notification clicks soft-route
  via `postMessage('open-session')` instead of a hard navigate that would drop the
  SSE stream.
- **`errorReporter.ts` storm-safety** (reentrancy guard + dedup + cooldown + rate
  cap, and excluding `prompt`/`speech/token`/transport errors) is exactly right
  for a self-reporting loop and is the kind of thing that's easy to get wrong.
- Effect/listener cleanup is consistently correct (EventSource, ResizeObserver,
  visibility/online listeners, menu-dismiss, voice controller all tear down).

## Cross-cutting (brief — noted, not investigated)
- **Attachment URL trust boundary (→ `packages/core` fold).** The durable fix for
  the `att.url` Low finding is to validate/normalize the `<cockpit-attachment>`
  marker `url` to a same-origin `/uploads/...` path where the fold parses it, so
  every consumer (not just `AttachmentView`) is safe.
- **`lastActivity` forwarding (→ `packages/core`/`protocol`).** The engine
  intentionally omits `lastActivity` from patches to avoid reordering on
  operational patches (`engine.ts:1845`). If the sidebar should reflect live
  activity ordering *consistently across devices*, that's a server decision to
  forward it on the turn's `msg/upsert`-adjacent patch — the client should not
  invent it. Flagged here only because the client-side symptom surfaced in this
  module; the fix lives server-side.
- Verified the document-vs-bubble CSS contract (`.message.is-doc` / `.message.is-out`)
  is correctly implemented in `styles/components/chat.scss`; the only borders in
  component styles are on tables (tweb-inherited) and card edges — no design-rule
  violation worth flagging.
