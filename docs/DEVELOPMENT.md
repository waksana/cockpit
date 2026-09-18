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

## Interaction semantics and structural correctness

This is a confirmed development requirement for both the host Web UI and module
UI: invisible structure and behavior must make sense, not merely produce the
right appearance or respond to a mouse click. Visible affordances, HTML semantics,
accessible names, focus, event handling and state transitions must describe the
same interaction. This is ordinary engineering correctness, not a separate
accessibility feature request or a claim of full accessibility conformance.
Existing implementations are subject to review; this requirement does not certify them.

- Prefer native elements whose behavior matches the action: buttons for actions,
  links for navigation/downloads and native disclosure/dialog behavior where it
  fits. Keep independent actions separate; do not nest interactive controls or
  reconstruct native keyboard behavior without a concrete need.
- Keep DOM content models valid, including controls rendered inside Markdown or
  module slots. Give dialogs and overlays an appropriate mount location and clear
  ownership. ARIA cannot repair invalid nesting or contradictory interaction
  structure.
- Make the visible label, accessible name and actual result agree. Prefer a direct
  relationship between the control and its visible content; do not announce
  decoration as another action or add needless focus stops and repeated labels.
  ARIA remains appropriate where native/visible content cannot convey the needed
  name, description or state.
- Preserve logical focus entry, order and return across open/close, disclosure,
  submission and resource replacement. Do not hide a layout or focus defect by
  indiscriminate `blur()`, suppressed focus indicators or unexpected focus moves.
  Keep keyboard, pointer and touch paths consistent in meaning.
- Check event ownership and the full state cycle, including loading, disabled,
  pending, error, retry, unmount and late results. Secondary actions must not
  accidentally invoke the primary action; displayed availability must match
  actual execution guards. Do not invent a second state authority to make the UI
  look consistent.

Transparent hit-area overlays, `pointer-events`, event propagation control and
ARIA are not automatically defects. Use them for a concrete requirement, not to
patch an avoidably contradictory structure; explain necessary tradeoffs.
Prefer the simplest coherent composition over accumulating special cases.
Do not introduce a new UI framework, runtime service or module-specific host API
just to satisfy this principle.

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

Review rendered DOM and relevant interaction paths, not screenshots or static
selectors alone. Reuse the existing component fixtures and isolated review
harnesses; record evidence and uncovered boundaries. Separate reproducible defects,
structural simplifications and accepted tradeoffs, and keep audit findings in
issues rather than turning this guide into a stale component inventory.

## Isolated Chat component review

`COCKPIT_CHAT_LAB=1 pnpm --filter @cockpit/web dev --host 127.0.0.1 --port 47831 --strictPort`
opens the opt-in development-only `/chat-lab.html` entry. It mounts the production
Chat components with synthetic native inputs and local
callbacks, without initializing a native client or creating sessions. Normal
production builds do not include the entry. The lab exercises
native text, tools, decisions, queue and reading behavior.

Chat Lab is a maintained developer harness, not a product page, alternate chat
implementation or saved screenshot gallery. It imports the production components
and event projection; only session inputs and action callbacks are synthetic.
It does not cover backend integration; management resources have their own
component and API tests.

When changing a Chat component, update affected shared scenarios in the same
change and keep their contract tests current. Add a scenario only for a distinct
interaction or failure boundary; remove scenarios when that behavior is removed.
Do not add one-off HTML pages or copies of production components. Normal
component tests consume the same fixtures; visual interaction review uses this
single opt-in entry. Neither the Lab nor its fixtures are runtime-package inputs.

For focused input-bar review, open `/chat-lab.html?scene=ask&compact=1`
or choose `plan` / `user-time`. Stop temporary previews after review; do not leave resident
background work, open native sessions or publish user screenshots.
Add `&pane=narrow` to constrain the actual Chat pane to 456px while keeping a
desktop viewport. This reproduces the space available beside docked settings:
decisions and process rows must adapt to their own width, not the window width.
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
Production builds have one HTML entry: `index.html`.

## Web presentation boundaries

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
