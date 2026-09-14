# Cockpit development

Goal: preserve the [product acceptance criteria](product-requirements.md) while
letting source integration and fixed-commit builds proceed independently of
production. Update this guide and the executable config together when changing
engineering commands or package behavior.
The [documentation index](README.md) defines each topic's single canonical page.
The service provides Web/API and a public graceful shutdown operation.
The [module contract](module-contract-draft.md) describes planned capabilities;
its execution process model remains a design decision.

Each owner uses an independent worktree and short-lived branch. Keep other
owners' source, unfinished trees and runtime data untouched. After implementation
and relevant local checks, integrate the latest local/remote main in that tree,
resolve conflicts and verify the affected behavior. Fast-forward main only if
its observed head still matches; a racing change requires reintegration, never
force-push. Do not paste deltas into the running source tree.

Main receives completed changes and triggers hosted checks/build. This project
does not require a PR or duplicate premerge hosted pipeline. Consequently main
can briefly be red: fix the source forward, while production stays at its last
healthy release. Main is not proof of the currently running version.

The [ordinary package contract](packaging.md) owns build outputs and provenance.
Keep the workspace injection/deduplication settings and lockfile together:
they let pnpm derive an offline runtime closure without re-resolving package ranges.
The current peer topology keeps workspace imports linked to source; build also
synchronizes any dependencies that require physical injection.
CI validates/builds/packages only; it does not transfer to a private host or
activate a production version. A push is not deployment authorization.
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
deploying or restarting the application. Keep migration notes, retired-interface
inventories, deployment history and old reviews outside the product repository,
with fixed source/version provenance. Keep original bytes separate from new explanations.

## Isolated Chat component review

`COCKPIT_CHAT_LAB=1 pnpm --filter @cockpit/web dev --host 127.0.0.1 --port 47831 --strictPort`
opens the opt-in development-only `/chat-lab.html` entry. It mounts the production
Chat components with synthetic native inputs and local
callbacks, without initializing a native client or creating sessions. Normal
production builds do not include the entry. The lab exercises
native text, tools, decisions, queue and reading behavior.

For focused input-bar review, open `/chat-lab.html?scene=ask&compact=1`
or choose `plan` / `user-time`. Stop temporary previews after review; do not leave resident
background work, open native sessions or publish user screenshots.

For current event ordering and process disclosure behavior, choose `ordered-events`.
Its controls feed synthetic historical/live/reconnect pages through the production
browser projection. The [native chat guide](native-chat.md#ordered-presentation)
owns the current grouping and update contract.

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
`PendingDecision` shares the ask/plan/elicitation card frame while their callbacks
and native action lists remain distinct. Chat read ownership and scrolling still
belong to the existing route/window and single scroll owner.
