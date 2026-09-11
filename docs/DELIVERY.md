# Explicit immutable delivery

This document defines the opt-in `github-actions-v1` integration. Source files
alone do not mean the host has migrated; installed runner configuration and the
authenticated request result are the authority.

## Build and submission

The private repository is `waksana/cockpit-foundation`, target `refs/heads/main`.
`.github/workflows/delivery-ci.yml` validates/builds a fixed SHA on push and on
explicit workflow dispatch. A push builds only. Authenticated toolkit `submit`
dispatches a named request; `.github/workflows/delivery-transfer.yml` transports
only successful explicitly requested artifacts. No PR requirement, paid
environment gate, production self-hosted GitHub runner or public listener is
introduced.

Toolchain: Ubuntu 24.04 x64, Node 24.20.0, pnpm 10.34.5, frozen lockfile. Workflow
actions are pinned to commits. Full CI runs configured lint/tests/build and
isolated native SDK contract fixtures. Failed builds never deploy.

The reviewed toolkit is vendored under `.delivery/toolkit` with source commit
recorded in `.delivery/provenance.json`. Refresh only from an explicitly reviewed
module commit with `scripts/vendor-delivery.mjs`; never silently follow its main.
The host control plane must use that compatible module version.

Project config's complete runtime closure includes Web, server TypeScript,
core/protocol TypeScript, built MCP and locked dependencies. Server/core builds
are no-emit; publishing only assumed `dist` directories would be incomplete.
Runtime links cannot point back to a development worktree. The same verified
archive moves from CI to a content-addressed release directory.

## Installed host boundary

The runner is an external singleton, not a Copilot task, native schedule or
Commander service. Its private config maps this project's repository/config
hash/environment to host paths, launch argv and exact health/version authority.
The restricted SSH account accepts only `receive REQUEST_ID RUN_ID ARTIFACT_ID`;
the host re-verifies GitHub run and artifact digest instead of trusting SSH
arguments. No source checkout executes in the privileged transfer job.

Approval is a server-retained record bound to project, SHA, environment and
expiry. Per-owner submit credentials identify the request owner and optional
completion callback; the request JSON itself cannot self-authorize. Credentials,
approvals and runner SQLite are private and must not enter Git or CI artifacts.
The operator explicitly approved reuse of the existing personal `gh` login for
this installation. That credential is broader than the preferred single-repo
Contents-read/Actions-write token; the installation must not be called
least-privilege GitHub authentication. SSH and HTTP roles remain restricted.

The backend's existing `/admin/restart` owns safe-idle exit. It protects active
turns, queues, decisions, subagents and native operations. A pending request
returns promptly; it is not completion. A finite busy deadline can fail a
candidate without forcing the service down. Systemd's fixed singleton launcher
selects the approved immutable package only after the old backend exits.

`GET /version` reports captured `sha`, `artifactSha256`, `requestId` and a fresh
`instanceId`; `/health` reports that same instance, both with no-store caching.
Source-mode `/version` returns 503 rather than inventing a SHA from moving Git
HEAD. `queued`, `building`, `built`, `waiting-idle`, `verifying` and `succeeded`
are distinct. Only matched runtime identity plus healthy same-instance readback
can produce `succeeded`.

Web/API/MCP are one coherent release. Future MCP processes use the current
package's fixed entry; existing MCP connections are not forcibly reloaded.
Their older tool descriptions can remain until native reconnect/resume.
The service is single-instance: rolling duplicate backends do not make native
session state safely shareable.

## Data, recovery and first migration

Native home/session history, preferences, credentials, uploads, logs and
Work Commander SQLite/credentials/bindings stay outside releases. Static hashed
assets are retained separately for existing browser clients. Compile cache is
external; rollback does not delete or restore live data.

Deployments serialize by accepted order, not GitHub workflow completion order.
Each activation rechecks its fence, expiry, authorization and current ancestry;
an old build cannot roll production back after a newer healthy release.
Uncertain effects block later activation until explicit evidence-based recovery.
There is no cancel-in-progress deployment kill or automatic redispatch.

Binary fallback requires an actually known-good package and compatible live
data. A still-running unhealthy/busy candidate is not killed; explicit rollback
requests safe idle. Failed rollback is a failed/unknown recovery, not success.
First migration must preserve the original source-mode service as an explicitly
identified bootstrap recovery option, never fabricate a previously successful
immutable result. Installing a drop-in or arming restart is not migration
acceptance.

Keep the earlier disabled pipeline/old staged packages out of the new authority.
The first integration preserves the reviewed current product source and records
the obsolete private remote pipeline ancestry without publishing that old
product snapshot. Work Commander remains a separate unchanged service. Weixin's
unknown outcome remains paused; voice and recursive Commander work are outside
this delivery integration.

## Installed instance and operator commands

First accepted immutable deployment (2026-09-11):

| Evidence | Value |
| --- | --- |
| Source | `6fc9b641c19d1ecc01ffa5cc7a1678b1d818460b` |
| Production request | `cockpit-deploy-6fc9b64-20260911` |
| Hosted build / transfer | Actions runs `34547123281` / `34547354291`, both successful |
| Runtime archive SHA-256 | `d0449d70f936da588995994cb1a1aeeeefef2d95096aa1371f74e3a5cfea3eef` |
| Observed process instance | `7c3b6dbc-85ad-4e41-b27a-e4e22f927cf0` |
| Host toolkit commit | `d6de960e85f50471f719148a5baeb40d2eb90b25` (0.2.0, adapter/contracts v1) |
| Build-side toolkit commit | `.delivery/provenance.json`, compatible 0.2.0/v1 build interface |

These are historical acceptance identities, not a promise that later main or
production never advances. Read the authority for every subsequent request.
The installed host toolkit includes longer bounded archive-verification
acknowledgements and explicit truncated-response uncertainty; build-side
packaging semantics are unchanged.

This instance's control plane is `cockpit-delivery.service`, root-owned code at
`/opt/service-delivery-toolkit/current`, loopback `http://127.0.0.1:8791`.
Its private configuration is under `~/.config/service-delivery/cockpit/`;
its durable requests, immutable releases and retained assets are under
`~/.local/state/service-delivery/cockpit/`. No token values belong in this guide.
`cockpit.service` has a fixed next-start drop-in at
`/etc/systemd/system/cockpit.service.d/40-service-delivery.conf`.
Future Cockpit MCP starts use the same `current/apps/mcp/dist/index.js`.
Do not use an application `systemctl restart` to bypass the native busy gate.

Use the main toolkit checkout's documented CLI. The operator issues each owner
a submit credential using `issue-credential.mjs`; `OWNER_CREDENTIAL` below is
that explicit file path, never a shared caller/Commander credential.

```sh
TOOLKIT=/opt/service-delivery-toolkit/current
REPO=/home/honglai/cockpit-foundation
SHA=$(git -C "$REPO" rev-parse HEAD)
# The private plan path must be new; preserve it and its stable ID on uncertainty.
umask 077
node "$TOOLKIT/bin/service-delivery.mjs" prepare \
  --repo "$REPO" --sha "$SHA" --config service-delivery.json \
  --request-id "$REQUEST_ID" --intent build-only > "$PRIVATE_PLAN"
node "$TOOLKIT/bin/service-delivery.mjs" submit \
  --request "$PRIVATE_PLAN" --credential "$OWNER_CREDENTIAL"
node "$TOOLKIT/bin/service-delivery.mjs" lookup \
  --request-id "$REQUEST_ID" --credential "$OWNER_CREDENTIAL"
```

For an authorized deployment, the operator registers the exact-SHA approval
using the toolkit's `authorize` command, then the owner prepares with
`--intent deploy --authorization "$PRIVATE_APPROVAL"` and submits once.
Never convert a build-only request in place: that is a conflicting body.
Approval-file content alone does not register an approval. A changed committed
project config hash needs explicit review and a matching operator allowlist
update before submission. Push current source to this private main first;
the runner verifies requested/observed/main ancestry and never force-pushes.

Unknown dispatch or acknowledgement: read the original ID. Do not automatically
rerun a workflow or resubmit with a new ID. The first build-only transfer exposed
exactly this case: its job timed out, but authenticated lookup established the
verified `built` artifact. It was not replayed. The receiver now allows five
minutes for archive verification; interactive calls remain bounded at 30 seconds.
An operator can use `recover` for original-run/process reconciliation or explicit
compatible binary rollback as documented by the toolkit.

The initial bootstrap fallback has been removed after live acceptance; its
archived former-runtime snapshot remains retained, not selected or reported as
an immutable successful deployment. No automatic release/data cleanup is
installed. Work Commander is independently deployed: acceptance observed
v1.2.0/release `b3f0861fe5cb`, not the earlier v1.1.0 snapshot. This pipeline did
not deploy, downgrade or alter that service.
