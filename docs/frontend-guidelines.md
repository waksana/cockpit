# Frontend guidelines: natural, simple, intuitive

Read and follow this page for any new or changed host Web or module UI. Content
should be easy to read and controls should behave as expected, using native
browser capabilities first and as little JS control as possible. Simple never
means hiding necessary errors, state or complete content, or only looking good in
screenshots.

This is the single home of general frontend principles, not a certification that
existing code conforms; check the interactions you touch without a repo-wide
cleanup. Product boundaries are in [product requirements](product-requirements.md);
themes, sizes, icon versions and public styles in the [module UI guide](module-ui-guide.md);
APIs, extension mechanisms and lifecycle in the [module contract](module-contract.md).

## Decision order

1. **Is it needed?** What does the user read or do? Remove decoration, repeated
   explanations, extra buttons or levels that carry no information — without losing
   state, recovery paths or complete content.
2. **Semantics before layout.** Use HTML and existing components matching the
   behavior; do layout, responsiveness and presentation in CSS. Do not derive
   clickable containers from a picture.
3. **JS only for gaps.** State what native/CSS lacks, who owns the state and events,
   and when they start, update and release. Reuse existing owners.
4. **Judge by real reading and operation.** Check narrow screens, long content,
   keyboard/touch and asynchronous changes; shorter code or smoother animation is
   not correctness.

## Semantics and native interaction

Actions are `button`s; navigation and downloads are `a[href]`; forms use `form`,
labelled `input`, `select` and so on. Modals use `dialog`; host disclosure uses the
shared [disclosure primitives](#disclosure) rather than `details`/`summary`, so every
fold looks and announces the same; do not replace proven components wholesale. Native-first does not forbid React,
controlled inputs or necessary JS.

Keep the HTML content model valid: independent actions are siblings; never nest an
interactive control in a button or link. This applies to Markdown and composed
module DOM too; wrapping in a `span` or adding ARIA does not fix invalid structure.
Overlays need a valid mount point and clear component ownership; the top layer does
not change DOM validity. See [Markdown and modal composition](module-ui-guide.md#markdown-and-modal-composition).

Visible labels, accessible names and actual results must agree. Let controls own
their visible content; use ARIA only for names, descriptions or states that native
or visible content cannot express, without announcing decoration or making it
focusable. Icon buttons still need accessible names.

Focus entry, Tab order and return after closing, submitting or replacing resources
must be natural, with DOM, visual and keyboard order aligned. Keep `:focus-visible`
and native keyboard/touch behavior; never force `blur()`, hide focus or steal focus
to mask structure problems. Keyboard, pointer and touch express the same action;
critical actions are not hover-only. Focus restoration and menu keyboard handling
belong to the existing owning components, not repeated in children. Transparent
click layers, `pointer-events` and propagation control need a concrete reason and
must not patch avoidable primary/secondary action conflicts.

## CSS first; JS with clear ownership

Layout, wrapping, size constraints, responsiveness and ordinary visual states go to
CSS; adapt to the actual container width instead of measuring in JS and writing
styles back. Keep geometry stable across hover, pending and error states and reuse
existing themes and tokens.

Text inputs on touch devices use at least 16px font size so iOS does not zoom on
focus — independent of control height, and also in landscape and on tablets. The
public input style provides the minimum; keep larger sizes, never restrict viewport
zoom, and do not patch it by changing the viewport after focus, forcing blur or
scaling. Chrome touch emulation validates font size and layout only, not real iOS
keyboard and zoom behavior.

Asynchronous data, business state, controlled editing, focus restoration, reading
position and necessary measurement may need JS, when semantics/CSS genuinely cannot
do it. Each control has a clear state source, target identity, event owner and
cleanup: subscriptions, observers and async callbacks are released or isolated from
late results on replacement/unmount. Local drafts, expansion and pending are valid
interaction state, never a second native authority.

One reading area has one scroll owner; modules and children must not compete.
Automatic positioning follows real layout readiness; pre-paint measurement or size
observation may stay, but must not override a user who started scrolling up. No
polling, repeated DOM manipulation or effects correcting each other to hide layout
or data problems. Timers and polling needed for real business have a purpose, end
condition and cleanup.

**Never hide content, wait, then show it — nor use masks or fade-ins — to cover
first-screen positioning, flashes or races.** Fix the timing of data arrival, DOM
commit and layout; a correct next frame or final position does not make the first
visible content correct. Real loading placeholders and user-initiated collapse are
fine, but displayable content is never held back just to look stable.

## Reading first, truthful state

Body content comes before decoration and repeated hints; fewer levels and buttons
never means removing necessary actions. Long messages keep their complete content;
summaries/truncation must expose the full text to keyboard and touch, not only via
`title`. Narrow screens wrap or expand naturally instead of clipping text, shrinking
fonts or nesting scroll areas. The user's reading, selection and editing win over
background updates: refreshes never clear drafts, move focus or force scrolling to
the bottom. Chat following/sending rules are in [native chat](native-chat.md).

A first load without data may show a placeholder; a refresh keeps still-valid
content and shows progress in its own scope. Old values are never assumed current:
disconnection, failure and unavailable resources state their stale/unknown boundary,
and whether an action is allowed uses existing availability and execution guards.
See [Web presentation boundaries](development.md#web-presentation-boundaries).

Distinguish accepted, queued, awaiting effect, succeeded, failed, unknown and
partially succeeded; a sent request or settled Promise is not success. Provenance
and role labels are not proof of permission, connection, readiness or capability;
colors and icons must not imply unproven states. No "show success" state masking
real errors or faked optimistic enablement. Keep errors, the input needed to retry
and real recovery paths, with feedback in the owning scope.

Visual disabling matches behavior: native buttons/fields use real `disabled`;
intentionally focusable `aria-disabled` controls still need execution guards; links
have no native `disabled`. `aria-busy` expresses real waiting and does not replace
blocking duplicate mutations. Async results bind to their original resource/session
and never write into a target switched to later; cancellation and late results follow
the owning operation's contract — closing a menu or changing page does not cancel
accepted work.

<a id="error-ownership"></a>
### Error ownership

Each failure is shown once. A caller that renders its own result passes ownership
(`OWNED` for `NetClient`, `'caller'` for store mutations) and the global notice stays
silent; unowned failures fall back to the global notice. A mutation whose owner has
unmounted is reported globally once, instead of vanishing. Identical global notices
within a short window are merged.

<a id="error-boundaries"></a>
Render crashes follow the same rule. `RegionErrorBoundary` (`components/ErrorBoundary.tsx`)
owns a region's crash: it shows a failed `OperationResult` with a local 重试 in place,
records the cause only in the console and keeps the global notice silent; new input
for the region (its `resetKey`) retries automatically. A failed lazy module load
cannot be retried in place (React caches the rejection), so its fallback offers a
page reload instead. The classic UI isolates each
message and process group, the transcript, the conversation pane, each session row,
the session list and the session detail panels (settings, MCP, Skills). Only a crash
outside every region reaches the top-level `ErrorBoundary`, which reports globally
and offers a page reload. Module slots keep their own `ModuleErrorBoundary`.

<a id="operation-feedback"></a>
### Operation feedback

In-place results use `OperationResult`: icon, one sentence and at most one action,
with long causes folded into 详情. Wording comes from `lib/copy.ts`:

| State | Sentence |
| --- | --- |
| busy | 正在{动作}… |
| done | 已{动作} |
| failed (known not applied) | {动作}失败：{原因} |
| unknown (may have applied) | 结果未知：{原因}。刷新后确认，不会自动重试。 |

Only rejections and pre-send errors are *failed*; anything after a mutation was
sent, or unclassified, is *unknown* (`lib/operationErrors.ts`). Failed and unknown
results are alerts; the others are polite status. Visible copy says “Copilot” when
the source matters and never “原生”.

<a id="disclosure"></a>
### Disclosure

Two primitives in `components/Disclosure.tsx` cover folding:

- `Disclosure` / `DisclosureSection`: a row with a leading chevron (› collapsed,
  ⌄ expanded, or an owner icon) that shows or hides one region, with
  `aria-expanded`, `aria-controls` and a 展开/收起 name.
- `TextClamp`: clips text to 1–3 lines and offers 展开全文 only when the text is
  actually clipped; a one-line clamp keeps the toggle at the end of the line.

## Reuse components, icons and visual language

Look for existing components and tokens first. The host reuses host components and
internal visual roles; modules use only the public `ck-*` / `--ck-*` contract and
the host-provided React, never private host components or selectors, or another
React runtime. Do not build another UI framework, theme, runtime service or module
API for consistency. Sizes, touch targets and the existing compact reading
exceptions are in [public classes](module-ui-guide.md#public-classes); exceptions do
not let every standalone button shrink.

**Use an icon only when it aids recognition; not everything needs one.** The host
uses the existing Lucide / host `Icon`; modules use the same pinned SVG nodes and
public styles described in [icons and packaging](module-ui-guide.md#icons-and-packaging),
which alone owns version, paths, packaging and license. No hand-drawn replacements,
second icon set, CSS double-box shapes, emoji or private code points posing as UI
icons. Ordinary borders, radii, layout geometry and progress visuals are not icon
violations, and logos, user emoji, thumbnails and native media controls need not be
replaced.

Same meaning, same icon and wording; different meanings, different marks (Skill is
a book, thinking a light bulb). Icons do not replace needed text or accessible
names, and state is never color-only. Reuse semantic colors and text levels readable
in light and dark themes; no self-picked bright colors, extra badges or decorative
hover effects.

<a id="host-components"></a>
## Host components and page composition

New pages compose existing layers instead of copying header, button, field or
scroller styles. The single source of public appearance is
`styles/primitives/public-ui.scss`; the host also consumes `ck-button` /
`ck-icon-button` / `ck-input`. Private components own reusable semantic compositions,
not another button look; modules cannot import them. Host buttons use
`components/Button.tsx`: `Button` (`variant="primary"`, `danger`), `IconButton`
(required accessible name, 16/20/24 icon sizes, spinner only when really `busy`) and
the single refresh control `RefreshButton`. They only choose `ck-*` classes and native
semantics; owner classes add contextual layout. Do not hand-write `ck-button` class
strings or add unstyled marker classes. Native buttons with special roles
(`role=switch`, menu items, session rows with long-press/right-click) stay with their owners.

| Layer | Location and responsibility |
| --- | --- |
| Foundation | `tokens.scss` font roles, spacing, radii and `--host-color-*` semantic colors (old tweb names are aliases for ported styles); public `ck-*` controls, native disabled, inset focus-visible; `Button.tsx`. Lucide and public sizes stay in the module UI guide. |
| Page skeleton | `Shell` with `master`, `main`, `inspector`, `overlays` slots; reads no URL, session or resource state. Omit unused slots. |
| Lists and main content | `MasterPane` / `DetailPane` own narrow-screen visibility and inert; `PaneHeader` composes leading/title/actions; `PaneBody` declares scrolling and padding. |
| Settings/details | `InspectorPane` is a dockable detail frame, not a generic page wrapper; `SessionDetails` chooses business content; `ManagementShell` composes management pages. |
| Forms and content | `UI.tsx` fields, choice cards, switches, section headings and `Badge`; `ResourceRow.tsx` composes name/provenance/switch/status, full text and error disclosure without owning requests; `ExpandableText` expands truncated text. |
| State and overlays | `StateNotice` separates empty/loading/info/error, `ResourceStatus` is its inline form; `PanelPage` frames session panels with a close button; `SessionResume` explicitly resumes unloaded sessions; `Dialog` / `DirectoryModal` use native modals; menus keep their existing keyboard and closing owners. |

Host and module surfaces, headings, action rows and non-interactive badges share
`ck-surface` / `ck-heading` / `ck-actions` / `ck-badge`; native modals use `ck-modal`.
This is an [independently declared public CSS capability](module-ui-guide.md#compatibility-and-ownership),
not permission to import host components or turn ordinary pages into modals.
Components never infer operation success or resource readiness.

`PaneBody` scrolls by default with standard padding. The chat main content uses
`scroll={false} padded={false}` so Thread owns message scrolling; list headers,
detail headers and floating actions stay out of the content scroller. Do not reserve
padding or fixed widths for the third column in page CSS: a docked inspector takes
part in layout itself.

Responsive thresholds live in `styles/_responsive.scss` and the matching
`lib/layout.ts` queries, kept in sync by a contract test: the left list docks from
925px and the right details from 1200px; 600–1199px details are a native modal with
backdrop; below 600px they fill the page. Pages decide what narrow screens show and
how to go back; Shell owns no navigation state. Breakpoints are product policy, not
per-page choices.

Focus follows semantics: ordinary controls keep an inset visible outline; static
initial reading targets use the reading marker and do not pose as buttons. The
Inspector's persistent container is the native autofocus target so lazy content
replacement cannot remove a focused temporary close button; opening non-modally on
wide screens does not call `show()` or move focus. The directory dialog starts on its
static heading; confirmation/text dialogs keep the browser's default initial focus.
Refreshing data never moves focus; menu return, removed-control recovery and input
blur while touch-scrolling chat keep their own owners. `:focus-visible` is a browser
decision, not "Tab only"; F8 needs no input-mode tracker. One bounded exception:
WebKit produces real `:focus-visible` after pointer-driven `showModal()` and native
close restoration. The document entry observes the latest pointer/keyboard input and
`dialog.ck-modal` focus entry/return and puts a temporary private style marker on
non-editing focused elements; any keyboard input clears it, and inputs and unknown
input keep indication. It never calls focus/blur, replaces native focus targets or
traps, intercepts events or tracks dialog state, and also covers independent
modules' native `ck-modal` without module changes. It is a local fix for a
reproduced browser difference, not a JS reimplementation of `:focus-visible`.

Extend a shared layer only when several pages lack a way to express the **same
meaning**, not for a few pixels in one screenshot: add a typed, actually consumed
variant, migrate callers and delete duplicate declarations. Chat prose/code,
media/waveforms, resource row sections for native state, session avatars and role
provenance are content-specific and may keep their layout while reusing base
fonts/colors/controls; they must not reset public classes or shrink standalone
action targets.

Shared composition styles follow their actual owner, not the first page that used
them: `CopyButton`, `MessageBody` and `RolePicker` are maintained in
`styles/components/copy.scss`, `markdown.scss` and `role-picker.scss`, loaded at the
entry; pages keep only contextual layout and intentional differences. These are
internal host styles, not new public module interfaces. [Chat Lab](development.md#isolated-chat-component-review)
is the composition example and behavior entry; there is no second demo component set.

<a id="style-guardrails"></a>
### Style guardrails

`pnpm lint` runs Stylelint (`apps/web/stylelint.config.mjs`); `tokens.scss` is the
only place defining raw colors and old tweb names:

- No hex, named colors or `rgb()`/`hsl()` color functions — use `--host-color-*` roles.
- No old tweb names such as `var(--primary-color)`, except in the ported `base.scss`,
  `primitives/button.scss`, `primitives/menu.scss` and the dev-only `dev/chat-lab.scss`.
- Raw px of 3 or more in `margin`/`padding`/`gap`/`inset` is an error — use
  `--host-space-*`, `--ck-*` or component tokens. 0–2px hairlines/optical offsets and
  rem/em typographic rhythm are allowed.
- `z-index` accepts only a `--host-z-*` stacking token. The scale in `tokens.scss`,
  lowest to highest: `raised`, `sticky`, `fab`, `inspector`, `notice`, `dev`,
  `dialog`, `menu`. Place a new layer by its role in this order; add a token only
  for a genuinely new layer.

A single intentional exception uses `// stylelint-disable-next-line <rule> -- <reason>`;
disables without a reason or that are unneeded are errors.

`styles/classDefinitions.test.ts` (in `pnpm test`) checks that every static class
name in TSX is defined in host styles; exceptions (test/state hooks, owner semantic
names) are listed with reasons in its allowlist, and stale entries fail. It also
blocks the retired `dialog-btn`, `rp` and `primary` classes. Public `ck-*` classes
come from `public-ui.scss`; undefined `ck-*` names are still reported. These checks
cover style files and className literals only, not inline TSX styles.

<a id="type-guardrails"></a>
### Type guardrails

Web code compiles with TypeScript `strict` (`tsconfig.app.json`, `tsconfig.node.json`
and `tsconfig.e2e.json` for the browser smoke, all in `pnpm --filter @cockpit/web typecheck`). ESLint is
type-aware and rejects floating and misused promises: await, return or handle a
promise, or discard it explicitly with `void` when its failure is already owned
elsewhere (for example, a store mutation that reports its own error). Top-level
`node:test` calls are exempt.

## Short examples

| Scenario | Prefer | Avoid |
| --- | --- | --- |
| A file row that previews and downloads | Preview and download as named sibling controls | A clickable container around the download button plus stopPropagation everywhere |
| First history page arrives | The single scroll owner positions when layout is ready and respects later scrolling up | `opacity: 0` plus `setTimeout` until it "should be at the bottom" |
| Refreshing a resource or submitting a switch | Keep valid content, show real pending/result, state staleness | Drawing a success tick when the request is sent, or treating enabled as connected |
| Module provenance is already next to the name | Keep the short provenance text; if an action icon is needed, reuse public Lucide | Another double-box badge — or forcing an icon onto every label |

<a id="review-checklist"></a>
## Lightweight review checklist

- Is every control and decoration needed? Do label, action and accessible name agree, and can the full content be read?
- Is the composed DOM valid, with primary and secondary actions separate? Are keyboard, touch, focus order and return natural?
- Semantics/CSS/existing components first? For necessary JS: clear state source, target, lifecycle and scroll owner?
- Are loading, refresh, failure, unknown, partial success, disabled and late results truthful, with recovery paths kept?
- Are scrolling up, selection and editing respected, and is the first screen really positioned rather than hidden or delayed?
- Are components, tokens, icons and public contracts reused? Still readable at narrow widths, with long content and in both themes?
- Do the `pnpm lint` / `pnpm test` [style guardrails](#style-guardrails) pass, with reasons for any new exemption or disable?

For intentional exceptions, state the need, the shortfall of the native option and
the trade-off; there is no approval process. Review the actual composed DOM and
interactions, not only screenshots or selectors, using the [testing guide](testing.md),
[Chat Lab](development.md#isolated-chat-component-review) or module fixtures, and
state what was and was not covered without claiming full accessibility or
cross-platform compliance. Reproducible defects go to issues.
