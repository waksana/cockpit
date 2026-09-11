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
