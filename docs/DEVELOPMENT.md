# Cockpit development and delivery

Goal: preserve the [product acceptance criteria](product-requirements.md) while
letting source integration and fixed-commit builds proceed independently of
production. Update this guide and the executable config together when changing
engineering commands or delivery behavior.

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

## Isolated Chat component review

`COCKPIT_CHAT_LAB=1 pnpm --filter @cockpit/web dev --host 127.0.0.1 --port 47831 --strictPort`
opens the opt-in development-only `/chat-lab.html` entry. It mounts the production
Chat components with synthetic inputs, same-origin sample media and local
callbacks, without initializing a native client or creating sessions. Normal
production builds do not include the entry. See the [component coverage and
design review](chat-design-review.md) for scenarios, reference sources and limits.

For keyboard-equivalent geometry and external user timestamps, open
`/chat-lab.html?scene=ask&viewport=1` or choose `user-time`.
The [targeted composer rework](chat-composer-rework.md) separates synthetic
VisualViewport inputs from actual iOS/PWA evidence; the lab never opens a native
keyboard or publishes user screenshots.
