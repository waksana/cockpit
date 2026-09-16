# Cockpit development

Goal: preserve the [product acceptance criteria](product-requirements.md) while
letting source integration and fixed-commit builds proceed independently of
production. Update this guide and the executable config together when changing
engineering commands or package behavior.
The [documentation index](README.md) defines each topic's single canonical page.
The service provides Web/API and a public graceful shutdown operation.
The [module contract](module-contract-draft.md) describes planned capabilities;
its execution process model remains a design decision.

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
contracts separate from proposed module ABI; update links
instead of cloning a capability table into every guide. Check command/schema
claims against their actual source. A requirement/implementation mismatch is
an explicit gap, not authority to change either silently.

Documentation-only edits need link, anchor and factual checks, not unrelated
product builds or new testing tools. They may be committed/integrated without
deploying or restarting the application. Maintain the current installation
contract rather than compatibility aliases, archived pages or migration inventories.
Generated reviews and build artifacts do not belong in the product source tree.

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
In `ask` / `ask-queued`, the waiting header folds the answer composer with native
disclosure. The `下一问题` control replaces the synthetic request ID without
remounting the thread, so draft/editor identity and new-question opening can be
reviewed separately from ordinary streaming updates.
Use `history-loading` and its page-request toggle to inspect the persistent
history-start hint. The request can start/finish without changing the hint;
the existing history insertion/completion control reaches the beginning and
removes it. Neither control reads native history.

For current event ordering and process disclosure behavior, choose `ordered-events`.
Its controls feed synthetic historical/live/reconnect pages through the production
browser projection. The [native chat guide](native-chat.md#ordered-presentation)
owns the current grouping and update contract.

Choose `thought-markdown` for formatted thinking, code copying and incremental
thought updates through the production renderer; its append and end-turn controls
keep the same native-text fixture identity.

For the README screenshot, open `/chat-lab.html?scene=workspace` at a desktop
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

## Web installation metadata

`public/manifest.webmanifest` and the HTML install metadata describe the current
application and icons. The service serves them as ordinary static files.
There is no service worker, offline cache, push handler or old-registration
migration. Production builds have one HTML entry: `index.html`.

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
`PendingDecision` shares plan/elicitation framing and question content; questions
use the existing composer as their foldable outer card. Callbacks and native
action lists remain distinct. Chat read ownership and scrolling still
belong to the existing route/window and single scroll owner.
