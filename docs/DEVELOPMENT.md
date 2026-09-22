# Cockpit development

Goal: preserve the [product acceptance criteria](product-requirements.md) while
letting source integration and fixed-commit builds proceed independently of
production. Update this guide and the executable config together when changing
engineering commands or package behavior.
The [documentation index](README.md) defines each topic's single canonical page.
The service provides Web/API and a public graceful shutdown operation.
The [module contract](module-contract-draft.md) describes the implemented local,
trusted, cold-loaded package model: backend API v1, Web API v2 and public UI v1.
Backends run in the host Node process; `publish`/`onEvent` data events are implemented.
Unimplemented capabilities are listed separately at the end of that contract.
Creation-time roles, metadata-only existing-session role additions, and the narrow backend `host.call` bridge are additive
development capabilities (backend API remains v1). The module contract owns their
manifest, explicit on-demand capability readiness and cold-resume semantics.
Ordinary session reads expose saved/applied role identity and reload state, not
readiness; there is no readiness cache, badge or automatic queue advancement.
Web settings and the sidebar show one saved-role collection, with unapplied or
unconfirmed roles muted; applied does not mean ready. The role-header refresh
reads only `session/resources` identity (including persisted selections), without
loading the session or inspecting MCP/Skills/tools. An uncertain addition remains
locked until this explicit read confirms the saved selection; it never retries
automatically. Creation and addition share native checkbox role cards.
`roles/add` saves selections even during active work without native lifecycle
calls. New roles apply on ordinary explicit reload or next cold load, under
normal lifecycle restrictions and native/global defaults; temporary switches and
session-only resources receive no special preservation. The result uses
`saved | unchanged | uncertain`, with no `phase` or embedded `readiness`.
Modules remain cold-loaded: installation and version selection take effect on
the next host start. Hot loading, hot enable/disable and hot updates are not product goals.
Do not reserve a hot-switching framework or change the trusted main-process model
for that purpose. The separate planned native system page is not part of the
menu-registry change and does not introduce arbitrary module page registration.

Use a short-lived branch and a pull request against `main`; an independent
worktree is optional. Keep other contributors' unfinished trees and runtime data
untouched. Before submitting, integrate current `main`, resolve conflicts and
run the relevant local checks. Do not paste deltas into running source or
force-push `main`.

`CI / Required checks` runs for pull requests, main pushes and release tags
through the same reusable workflow. It installs the frozen lockfile, lints,
tests, builds, exercises isolated native contracts and verifies the runtime
archive. Fork PRs use read-only permissions and no production credentials;
there is no `pull_request_target` execution path.

Before preparing an installable delivery, follow the
[immutable delivery version rules](packaging.md#delivery-versions), including
the target's existing version/digest, synchronized metadata and post-restart
loaded identity. Ordinary tests check host workspace/MCP/release-note version
consistency, but CI cannot discover an operator's installed module versions.

Main requires a PR, the successful `Required checks` status on an up-to-date
base, and resolved conversations. A maintainer checks scope and evidence before
merging; there is no mandatory second-person approval while the project has one
maintainer. Merge commits preserve the checked branch history. Force pushes and
branch deletion are disabled; merged contribution branches are deleted.
A red main is a repair priority, not a release candidate. Branch identity alone
is not evidence of a validated or deployed version.

The [ordinary package contract](packaging.md) owns build outputs and provenance.
Keep the workspace injection/deduplication settings and lockfile together:
they let pnpm derive an offline runtime closure without re-resolving package ranges.
The current peer topology keeps workspace imports linked to source; build also
synchronizes any dependencies that require physical injection.
CI creates a short-lived development artifact. A `vMAJOR.MINOR.PATCH` tag invokes
the same checks and publishes their exact artifact through the
[release procedure](packaging.md#versioned-releases). Neither workflow transfers
to a private host or activates a production service. A push is not deployment authorization.
An operator chooses how to install/run the package, keeping native data and
credentials separate and preserving any existing installation during a transition.

Clean only owned, fully integrated and no-longer-in-flight branches/worktrees
and fixture resources. Never clear native sessions, queues, uploads or another
owner's work as cleanup.

## Documentation maintenance

Follow the [documentation ownership rules](README.md#维护规则). Keep current
source contracts separate from released contracts and future module goals; update links
instead of cloning a capability table into every guide. Check command/schema
claims against their actual source. A requirement/implementation mismatch is
an explicit gap, not authority to change either silently.

Documentation-only edits need link, anchor and factual checks, not unrelated
product builds or new testing tools. They may be committed/integrated without
deploying or restarting the application. Maintain the current installation
contract rather than compatibility aliases, archived pages or migration inventories.
Generated reviews and build artifacts do not belong in the product source tree.
The 0.2.4 release preparation includes module payload events and the independent
menu registry. **0.2.4 配套 / 发布资产以对应 Release 为准**; documentation does
not prove publication. It pairs with Notification 0.1.5; File 0.1.7 remains
compatible and is not being rereleased. Historical 0.2.3 / Notification 0.1.0
assets do not acquire these changes. Notification's `tooling/host-sdk.json`
retains the exact compatible SDK source pin exported from 0.2.3 development source:
the host's patch-version change does not alter those types. See the
[module contract](module-contract-draft.md) for the full SHA and independent
Web/UI/menu capability checks, not package-label inference.

The 0.2.5 input-component change pairs with Speech 0.1.1. It removes the old
Composer position slot without an alias; the real textarea is now wrapped through
`composerInput`. Preserve native controlled events, React 19 ref cleanup, and
separate editing/submission gates. The speech repository's exact SDK pin must be
reachable and exported from a clean host commit before consumer packaging.
See [release notes](release-notes.md); no tag, publication or deployment is implied.

## Interaction semantics and structural correctness

Before any host Web or module UI work, read and follow the
[frontend guidelines](frontend-guidelines.md). They are the single home for
native-first semantics, valid structure, focus/event ownership, minimal JS,
reading behavior, truthful state and the lightweight review checklist.
These are ordinary engineering requirements, not a separate accessibility feature
or certification of existing implementations. This entry keeps its public anchor;
the module integration details below remain governed by the module contract.

Keep the four module extension mechanisms distinct: menu declarations, real
semantic component middleware, state/service/draft and Markdown renderers.
Menu contributions use the host's existing global/session menus, not a navigation
HOC or page/router registration. The host owns menu keyboard/focus/closing and
rechecks current availability when selecting an action; module state stays in
its existing service. Validate original-target binding, stale callbacks, disabled
changes and late async results without redirecting work to the active session.
Normal menu closing and route changes do not cancel accepted work; target loss,
unknown connection or module stop aborts its signal without waiting for the action
Promise. Check per-command presentation/action error isolation separately from
activation-owned subscription setup and cleanup failures. The precise contract is in
[menu registration](module-contract-draft.md#65-菜单注册).

## Isolated Chat component review

Host confirmation and directory pickers use native modal dialogs. The directory
picker's non-input heading is the explicit autofocus target, including lazy
loading, so opening New Session does not start path editing or request a keyboard.
Session details compose the shared `InspectorPane`: the same mounted dialog is
modal below 1200px and nonmodal/in-flow docked above it without an entry focus
move. The persistent reading surface is the native autofocus target, so lazy
content replacement does not remove initial focus. The browser owns isolation, Tab and modal
return; errors from the shared local error store remain reachable inside host
modals. No body mutation observer or focus-in trap supplements native behavior.
Menus retain their command selection/arrow navigation and close restoration;
removed execution controls and dismissed errors retain scoped recovery only when
they owned focus. Management headers no longer focus themselves on navigation.
Visible outlines stay inside controls and the transcript viewport; pressing F8
may still make the browser's existing focus visible, without changing its target.

`COCKPIT_CHAT_LAB=1 pnpm --filter @cockpit/web dev --host 127.0.0.1 --port 47831 --strictPort`
opens the opt-in development-only `/chat-lab.html` entry. It mounts the production
Chat components with synthetic native inputs and local
callbacks, without initializing a native client or creating sessions. Normal
production builds do not include the entry. The lab exercises
native text, tools, decisions, queue and reading behavior.

Use `/chat-lab.html?ui=next&scene=workspace` for the independent new host, or
`?ui=next&scene=ask&compact=1` for its conversation flow. The small lab entry
loads only the selected presentation and its styles. The next fixture replaces
browser storage with in-memory storage before importing the real App, disables
application transports, and uses a `MemoryRouter`. No production bootstrap or
user session data is read. Its toolbar and typed `window.nextLab` controls hold,
fail or release synthetic operations, replace native decisions, navigate settings,
and deliver history in a late animation frame. `firstContent` records the first
content commit after the production layout effects, before paint.
On an App scene, run `await import('/src/dev/next-lab-checks.ts').then(m => m.runNextLabChecks())`
for maintained real-DOM focus, pending, request-identity and reading regressions;
use a 1440x960 desktop viewport and repeat at a 390x844 touch viewport.
Run `await import('/src/dev/next-workspace-checks.ts').then(m => m.runNextWorkspaceChecks())`
at 1440x960, 1000x800 and 390x844 to cover compact rows/headers, contextual
settings, mounted desktop chat versus released phone chat, in-dialog Select
portals, title-trigger focus restoration and retained drafts. Also resize with
an unapplied model selection open: call `prepareNextWorkspaceResizeCheck()` from
that module, retain its returned check function, and invoke it after resizing to
each of the three widths. The same inspector form must stay mounted.
`?ui=next&view=conversation&scene=readonly`
mounts the production conversation component without the App shell.

For combined File/Speech presentation review, first build and verify each module's
clean package with its own repository tooling, then extract the archives into
separate temporary directories. Start the same lab with their absolute package
roots (the directory containing `cockpit.module.json` and `module-build.json`):

```sh
COCKPIT_CHAT_LAB=1 \
COCKPIT_LAB_FILE_ROOT=/absolute/extracted/file/package \
COCKPIT_LAB_SPEECH_ROOT=/absolute/extracted/speech/package \
pnpm --filter @cockpit/web dev --host 127.0.0.1 --port 47831 --strictPort
```

Open `/chat-lab.html?ui=next&modules=1&compact=1&path=/session/fixture-next-workspace-0`.
The actual module runtime mounts the compiled new presentations with host components.
Only receipt-inventoried frontend assets are served; module backends never execute.
Uploads use a bounded in-memory File API. Names starting with `fail-once` fail once,
then permit explicit retry; `nextLab.modules.files(true/false)` holds/releases
uploads. Speech uses generated oscillator audio, the real recorder/AudioWorklet,
and a local synthetic protocol adapter, never a microphone, speaker, provider or
credential service. Its controls expose transcript, next-credential-failure,
held-final and resource diagnostics. Recognition/VAD and real provider behavior
are outside this fixture's coverage.

In a fresh document, run
`await import('/src/dev/next-lab-module-checks.ts').then(m => m.runNextModuleChecks())`
for actual module paste/drop/retry, preview/modal focus, F8 isolation, hidden-draft
leave protection, capture and original-draft attachment submission. Run with both
light/desktop and dark/touch layouts. A browser may require a user gesture to allow
the generated AudioContext; no actual media permission is needed. Reload between
the host and module checks, which intentionally leave different synthetic states.
`nextLab.draftRequests()` records the exact synthetic native submission bodies;
it is not a backend acknowledgement or provider integration test.
For first-input geometry, a browser driver can hold the synthetic `/_modules`
response before entry execution, then pass its release callback to
`runNextBootstrapCheck(release)`. This checks actual input position/size within
1px before and after bootstrap with a retained multiline-width draft, while
native reading remains visible. Repeat in fresh documents with empty text and
explicit newlines; do not substitute a settled screenshot for this transition.

Chat Lab is a maintained developer harness, not a product page, alternate chat
implementation or saved screenshot gallery. It imports the production components
and event projection; only session inputs and action callbacks are synthetic.
It does not cover backend integration; management resources have their own
component and API tests.

For module-role and resource presentation, open
`/chat-lab.html?scene=resources` (or add `&longNames=1`). This scene mounts the
real session list, role picker, settings and MCP/Skills panels against synthetic
resource callbacks. Session creation and toggles affect only the fixture store.
It includes multiple roles and similarly named non-module resources so visual
review can distinguish explicit module metadata from name-based inference.
Check desktop/mobile, native checkbox keyboard use, long names and both themes.
It is not evidence of native role assembly or production resource readiness.
This scene also exercises the real global MCP/Skills management pages: use the
global menu or `&page=mcp` / `&page=skills`. The fixture owns both global defaults
and per-session switches separately; changing one does not pretend to change
the other. Add `&empty=1` for empty catalogs, `&fail=1` for explicit resource
failures, or `&delay=1` for 1.2-second synthetic reads/mutations (initial loading,
retained refresh content and row pending). These switches never enable transport.
Use the same scene at 1600px, 1024px and 390px for three columns, overlay and
single-page navigation; cross the live breakpoints with an open inspector too.
The [shared component map](frontend-guidelines.md#宿主组件与页面组合) explains which
component owns each header, content scroller and optional layout slot.

When changing a Chat component, update affected shared scenarios in the same
change and keep their contract tests current. Add a scenario only for a distinct
interaction or failure boundary; remove scenarios when that behavior is removed.
Do not add one-off HTML pages or copies of production components. Normal
component tests consume the same fixtures; visual interaction review uses this
single opt-in entry. Neither the Lab nor its fixtures are runtime-package inputs.

For focused input-bar review, open `/chat-lab.html?scene=ask&compact=1`
or `/chat-lab.html?scene=activity-design` for the classic activity/tool design preview.
The latter uses synthetic session rows and the production Thread: compare concrete
activity icons with the fallback spinner, inspect built-in tool icons and extension
names, and expand the independent subagent card. Its explicit refresh hold/result
controls demonstrate retained presentation without a native transport; operation
hold/failure controls exercise Stop and interrupt feedback. This is a design preview,
not evidence of live native refresh integration.

For the existing input scenes, choose `ask`
or choose `plan` / `user-time`. Stop temporary previews after review; do not leave resident
background work, open native sessions or publish user screenshots.
For a separately authorized static activity-design review, use
`COCKPIT_ACTIVITY_DESIGN_REVIEW=1 COCKPIT_REVIEW_OUTPUT=/absolute/separate/output pnpm --filter @cockpit/web exec vite build --config activity-design-review.config.ts`.
This explicit build has only the synthetic design entry, no public directory or
source maps, and uses `/review/activity-design-20260922/` as its asset base.
Its bootstrap installs memory-only storage and disables application transports
before importing components. Publish only that output behind the existing review
authentication and a `connect-src 'none'` CSP; do not expose Vite or the worktree,
replace another review, or change the production application entry.

The published static control-review entry now mounts the complete production
`App` with a `MemoryRouter` and `installFullWebFixture`. It does not import
`chat-lab.scss`, override components, or construct a separate preview shell.
The same sidebar, routing, conversation, settings, global menus and resource
pages consume synthetic data and local callbacks. The real Thread now optionally
renders `SessionControlBar` when the fixture supplies browser-only `controls` and
`sessionControlAction`. Only this input dock changes; the full App remains the
same. The leading indicator is an independent overall state: a spinner coexists
with question, agent, terminal, queue and compaction icons whenever activity
remains. Idle, offline and errors retain distinct overall indicators. Browser storage
and application transports remain isolated before imports. Use
`/chat-lab.html?scene=full-web` for this scene in the development Lab;
`case=tool-loading` selects the last-tool reproduction in either entry.

The earlier proposed separated control area remains an opt-in component scene at
`/chat-lab.html?scene=control-design`. It reuses Thread's transcript, native
decision cards and composer through an alternate activity/queue composition.
Task cancellation, independent main-turn stopping, queue clearing and immediate
steering are local scenario transitions, not connected SDK commands. Use
`模拟纳入回合` to move accepted steering into a synthetic `user.message` with
`delivery: steering`; the event inspector distinguishes acceptance from history.
Hold/failure, reconnect, refresh, manual/background compaction and decision
scenarios remain explicit. For the separately authorized static preview, add
`COCKPIT_REVIEW_SCENE=control` to the build command above and use a new output
directory; its asset base is `/review/activity-design-20260922/control/`.
Do not overwrite the previous activity preview or deploy the main application.

The control scene now keeps a single native input-card frame: one status toggle,
grouped agent/terminal/queue rows, native question/decision content, and a bottom
editor. The normal editor is never collapsed with the task list. A new question
opens the list and positions its answer at the bottom once, before paint; later
task updates do not repeat that navigation. The preview retains the same textarea,
preserves separate prompt/answer drafts and carries editor geometry across purpose
changes. This alternate composition is opt-in; the production composer stays unchanged.
Full-Web steering first shows acceptance, then a 700ms synthetic runtime event
places the same message in history; Stop/clear/disposal fence delayed events.
The backend has no new mutation API and never receives these fixture actions.

Use `?scene=control-design&case=tool-loading` in Chat Lab, or `?case=tool-loading`
on the full Web static review, for a final active tool after scrollable static
history. Only the earlier component scene's `对比修复前图标` toggle restores the old inline SVG display.
The inline line box rotated with the tool status wrapper and changed scrollable
overflow, even while the message content height stayed fixed. A block SVG removes
that line box; keep the animation and the existing scroll owner, rather than
masking the jitter with timers or repeated scroll writes.
Add `&pane=narrow` to constrain the actual Chat pane to 456px while keeping a
desktop viewport. This reproduces the space available beside docked settings:
decisions and process rows must adapt to their own width, not the window width.
`input-states` also includes `问题（不允许自由回答）`: its native textarea remains
editable as before, while submission and input-enhancement recording stay blocked.
In `ask` / `ask-queued`, clicking the status header folds the entire input card
with native disclosure, without a visible folding arrow. Its queue, question,
choices and original editor share one content scroller; ordinary content fits
without scrolling. `更新当前问题` retains the request ID and manual fold state;
`下一问题` changes the ID and opens the same mounted card/editor afresh.
Use the existing hold/failure controls to observe submission in the header,
retained drafts and errors outside the collapsed card. `streaming` / `idle-queued`
exercise folding without a question; Stop from the folded header restores ordinary
input when no execution, queue or decision remains. Empty idle input has no header,
including during its short-lived send. Include short-height and narrow-pane views.
Use the existing hold/failure controls with `all` to review local-send following:
scroll upward while a button or keyboard submission waits, then release it. A
successful ACK resumes following; a failed send leaves the reading position alone.
Scroll upward again after success and append a synthetic remote message to confirm
that reading remains under user control. The mounted component regressions also
exercise the public module captured-send path and ACK-before-DOM ordering without
requiring a microphone, an external provider or a resident preview.
Use `input-states` and its `输入状态` selector to transition between idle, execution,
short/long questions, plans, tool confirmations and disabled input without changing
the session, draft or mounted editor. Compare the same multiline draft before and
after each transition, including the classic-scrollbar case; its dimensions must
not depend on execution/decision state.
Use `history-loading` and its page-request toggle to inspect the persistent
history-start hint. The request can start/finish without changing the hint;
the existing history insertion/completion control reaches the beginning and
removes it. Neither control reads native history.
Use `history-progressive` and click `插入历史 / 完成加载` to deliver a small first
page. The same bounded synthetic loader then supplies further pages as normal
viewport prefetch requests them. Each received page must already be visible
while the next one is pending; scroll upward to exercise retained reading anchors.

Use `/chat-lab.html?scene=initial-history&compact=1` for an empty mount followed by an asynchronous
first page. Add `&frame=1` to deliver it in a late-frame React commit, exposing
the difference between pre-paint positioning and a next-frame scroll correction.
Add `&short=1` for short content or `&cards=1` for a synthetic message middleware
card that grows after 1.8 seconds; these delays simulate fixture I/O only.
`reading` provides the same long history already cached at mount. Switch between
scenes to exercise SPA entry. Compare desktop/mobile and CPU throttling; record
actual first-content paint (for example text Element Timing intersection rectangles)
as well as scroll geometry. A RAF sample at zero or a correct final position alone
does not prove what was painted. Layout-shift totals also include initial content
insertion and containment changes, not only scrolling.
Continue recording after the initial message paint: the asynchronous card's new
detail paragraphs must first paint at their corrected positions, not below the
viewport followed by a next-frame jump. `frame=1` also applies to the progressive
history loader to exercise a late-frame prepend. Exercise it with a reader
anchor as well; initial positioning alone is not evidence of stable subsequent
layouts. A RAF probe can still see old offsets before ResizeObserver runs, even
when correction completes before the actual paint.

For current event ordering and process disclosure behavior, choose `ordered-events`.
Its controls feed synthetic historical/live/reconnect pages through the production
browser projection. The [native chat guide](native-chat.md#ordered-presentation)
owns the current grouping and update contract.

Choose `thought-markdown` for formatted thinking, code copying and incremental
thought updates through the production renderer; its append and end-turn controls
keep the same native-text fixture identity.

For the README workspace screenshot, open `/chat-lab.html?scene=workspace` at a desktop
viewport of 1600 x 1000. This scene mounts the real App, session list, Chat and
session settings with a synthetic store whose transport initialization is disabled.
It starts with the settings panel open and a local input draft. Expand the
`安装文档复核` agent and the latest `检查运行包入口与静态资源` tool; leave the earlier
process overview collapsed. Return to the latest message so the final tool row
is fully visible, then capture the browser viewport without the Lab controls.
All content is synthetic, including tool output and model choices; it is not proof
of a native execution. Keep the image in `docs/images/workspace.png` and update it
from this scene when the represented interface changes. Do not substitute private
session screenshots or add a second demo application.

For the answer-input screenshot, open `/chat-lab.html?scene=ask&compact=1` at
1040 x 650. Enter a short answer without submitting it, then capture only the
expanded input card, including its status, question, choices and editor, to
`docs/images/answering.png`. Do not include the Lab controls or unrelated
long-content fixtures. The README labels both screenshots as synthetic.
`docs/images/extensions.svg` is a hand-maintained architecture diagram, not a
screenshot; keep its frontend/backend labels aligned with the module contract.

## Web installation metadata

`public/manifest.webmanifest` and the HTML install metadata describe the current
application and icons. The service serves them as ordinary static files.
The host does not register a global service worker, cache offline pages or own
push subscriptions. A trusted module may declare a packaged worker served at a
stable module-specific URL with a narrow scope; registration, notification and
badge behavior belong to that module. Existing browser registrations do not
vanish on server shutdown. See the [module contract](module-contract-draft.md).
Production builds have independent classic `index.html` and new `next/index.html`
entries. Chat Lab is not a production entry.

## Web presentation boundaries

Apply the required [frontend guidelines](frontend-guidelines.md); the following
describes the current host component and resource ownership, not another set of
general UI principles.

### Independent new host

`src/next/App.tsx` owns the conversation-first shell, session navigation, dedicated
session settings, and explicit global MCP/Skills pages. `next/conversation`,
`next/settings` and `next/resources` compose the shared shadcn components; classic
presentation and styles remain on the default entry. There is no new System page.
Both presentations reuse native transport/projection, draft/schema ownership,
keyed resources/actions and the single transcript scroll controller. Shared
settings controllers live in `features/session-settings`; they do not store a
second authoritative model or resource inventory.

Only the entry starts the module runtime. App initializes native transport and
observes the module view; its `moduleBootstrap` prop gates module-sensitive input,
not readable native history. Settlement is not a claim that every module loaded.
Missing next presentations remain explicitly classic-only, never activate classic
UI as a fallback, and do not imply that their module backends are disabled.

Unknown persisted draft namespaces (including data from an absent or failed
module) block native submission until the owning schema can restore them. Text
edits, empty-text updates and retirement preserve opaque recovery data. This is
a shared draft safety rule, including classic: a missing module cannot silently
turn an attachment submission into a text-only send. The next composer provides
an explicit classic recovery link.

The next document entry must call `installHostLeaveProtection(window)` from
`src/lib/hostLeave.ts` before its first render, outside React and its error boundary.
Keep the returned disposer until entry teardown/HMR; do not call it when App
unmounts or startup switches to an error fallback. This installs conditional
native `beforeunload` protection for unpersisted
host drafts, genuinely dirty forms, and dispatched host mutations, including work
whose original view has unmounted. Known outcomes release their pending ownership;
uncertain outcomes retain conservative protection for the document lifetime.
The handler only requests browser confirmation and never cancels, retries or
changes work. Module activations separately protect their own in-memory work.
Ordinary in-app navigation does not cancel accepted native work; full-document
classic links use the browser's leave confirmation rather than a second router.

### Classic presentation

`PaneHeader` and `StateNotice` share presentation, not routing or resource state.
The management route keeps its header and back control during lazy loading.
First loads use a pane placeholder. Session settings refreshes retain content
and use the header indicator; a toggle mutation instead owns its row's feedback,
including its final readback, without additional page-level loading indicators.
Same-connection accepted data remains usable during a healthy refresh; errors,
reconnections and disabled resources do not imply usable current values.
MCP mutations keep the native per-session serial constraint (including reported
active operations and settling connections); Skills mutations are isolated per row.
No optimistic enablement, client mutation queue or native-state mirror is added.
Pending actions report submission without claiming native application.
Consumers must use the existing session resource's availability, including
closing and resume-required states, rather than infer readiness from old metadata.
`PendingDecision` shares plan/elicitation and question content inside the unified
input card; questions reuse the existing composer. Callbacks and native
action lists remain distinct. Chat read ownership and scrolling still
belong to the existing route/window and single scroll owner.
