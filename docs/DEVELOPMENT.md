# Cockpit development and delivery

Goal: preserve the [product acceptance criteria](product-requirements.md) while
letting source integration and fixed-commit builds proceed independently of
production. Update this guide and the executable config together when changing
engineering commands or delivery behavior.
The [documentation index](README.md) defines each topic's single canonical page.
Deployment observations belong only in [deployment records](deployments.md),
not in a moving source implementation guide.

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

`service-delivery.json` contains the authoritative committed build configuration.
The connected route is described in [DELIVERY.md](DELIVERY.md). A user may deliver
code only, request a build-only artifact, or explicitly authorize deployment of
a full SHA. A push is not a deployment request. Source merges and A/B builds
may run concurrently; activation has a separate durable per-environment order.

Use the installed `service-development` commands to prepare, submit and read back
the stable request ID. The pipeline owns build, artifact transfer and safe
restart, not the development model. End a turn hosted by Cockpit after submitting
its restart-dependent work; do not keep it busy with a background waiter.
Only after authoritative runtime evidence and business acceptance is the
owner's complete runtime goal done. A verified descendant can satisfy the
business goal if it still includes the owner's changes; do not rewrite the
original exact-SHA request to pretend that SHA deployed.

Clean only owned, fully integrated and no-longer-in-flight branches/worktrees
and fixture resources. Never clear native sessions, queues, uploads or another
owner's work as cleanup.

## Documentation maintenance

Follow the [documentation ownership rules](README.md#维护规则). Keep current
contracts separate from proposed module ABI and archived evidence; update links
instead of cloning a capability table into every guide. Check command/schema
claims against their actual source. A requirement/implementation mismatch is
an explicit gap, not authority to change either silently.

Documentation-only edits need link, anchor and factual checks, not unrelated
product builds or new testing tools. They may be committed/integrated without
deploying or restarting the application. Do not alter archived module-source
bytes to make historical prose match the present.

## Isolated Chat component review

`COCKPIT_CHAT_LAB=1 pnpm --filter @cockpit/web dev --host 127.0.0.1 --port 47831 --strictPort`
opens the opt-in development-only `/chat-lab.html` entry. It mounts the production
Chat components with synthetic native inputs and local
callbacks, without initializing a native client or creating sessions. Normal
production builds do not include the entry. See the [component coverage and
design review](archive/chat-design-review.md) for historical reference sources and limits.
File/voice scenes and the old fixed-version static review builder are parked;
they are not active lab capabilities. The normal lab exercises the remaining
native text, tools, decisions, queue and reading behavior.

For focused input-bar review, open `/chat-lab.html?scene=ask&compact=1`
or choose `plan` / `user-time`. The [CSS-first composer rework](archive/chat-composer-rework.md)
documents the historical original/v3/v4 comparison and real-device limits.
The former global VisualViewport controller and its simulated-geometry lab
are removed. Stop temporary previews after review; do not leave resident
background work, open native sessions or publish user screenshots.
