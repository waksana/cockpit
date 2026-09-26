# Module catalog

Modules add features to Cockpit. Each is released separately and never enabled by
default. **This page is the only place that lists module versions and their host
pairing**; package format, install commands and APIs are in the
[module contract](module-contract.md).

## Versions and compatibility

The table below is a historical accepted-pairing checkpoint, not an automatic
deployment catalog. New [Rolling releases](releasing.md) carry source-derived
compatibility and explicit database/migration declarations in
`cockpit-deployment.json`; each merge does not require editing this table.
Rolling prereleases are not Latest unless explicitly promoted as a Milestone.

Checked 2026-09-25 against the published Release assets and the accepted joint
deployment.

| Module | Latest release | Paired host release | Status |
| --- | --- | --- | --- |
| [Cockpit File](https://github.com/waksana/cockpit-file) | [v0.2.5](https://github.com/waksana/cockpit-file/releases/tag/v0.2.5) | [Cockpit v0.5.0](https://github.com/waksana/cockpit/releases/tag/v0.5.0) | Installable. |
| [Cockpit Notification](https://github.com/waksana/cockpit-notification) | [v0.1.18](https://github.com/waksana/cockpit-notification/releases/tag/v0.1.18) | [Cockpit v0.5.0](https://github.com/waksana/cockpit/releases/tag/v0.5.0) | Installable. |
| [Cockpit Speech](https://github.com/waksana/cockpit-speech) | [v0.9.3](https://github.com/waksana/cockpit-speech/releases/tag/v0.9.3) | [Cockpit v0.5.0](https://github.com/waksana/cockpit/releases/tag/v0.5.0) | Installable; needs Azure Speech configuration. |
| [Cockpit Task](https://github.com/waksana/cockpit-task) | [v0.3.0](https://github.com/waksana/cockpit-task/releases/tag/v0.3.0) | [Cockpit v0.5.0](https://github.com/waksana/cockpit/releases/tag/v0.5.0) | Installable. Requires host-provided MCP invocation identity and schema v10; existing v9 data needs an explicit reviewed migration. The older v1.2.7 is a legacy pre-release ZIP. |
| [Cockpit WeChat Connector](https://github.com/waksana/cockpit-wechat-connector) | [v0.1.6](https://github.com/waksana/cockpit-wechat-connector/releases/tag/v0.1.6) (legacy ZIP) | — | Not yet adapted: uses `module.json` and a separate service protocol; the module CLI cannot install it. |

### Accepted pairing and upgrade boundary

These four module versions were accepted together on Cockpit 0.5.0. All five
Releases were published as Latest at that checkpoint, and each downloaded archive's SHA256 matched the
original CI package used by the accepted deployment. Publication does not itself
install or restart another instance.

Task v0.3.0 introduces the incompatible schema v10 lifecycle and durable
prerequisite relations. Every existing v9 database needs a reviewed,
fingerprint-bound plan, even without legacy `blocked` or `in_review` Tasks.
The accepted deployment applied its plan with stopped writers and a
WAL-consistent backup, preserving Task identities, relationships and histories.
Follow the Task module's
[migration procedure](https://github.com/waksana/cockpit-task/blob/v0.3.0/docs/task-implementation.md#schema-v10-migration);
ordinary startup cannot replace inventory, review, preflight and explicit apply.
Task v0.2.0 cannot open v10. Switching binaries is not a database rollback;
restoring the pre-upgrade backup discards later writes and requires separate
authorization.

The [File Release publication record](https://github.com/waksana/cockpit-file/releases/tag/v0.2.5)
documents the operator-approved, one-time release-note-heading exception.
Its tagged `Required checks` passed, but the publish job rejected the source
preparation heading. The unchanged main CI archive was published manually with
all package identity checks retained; neither the tag nor archive was replaced.
The failed workflow record and future release gates remain unchanged.

Acceptance covered running package identities, Task migration integrity and
history, module activation and served Web/module assets. It did not exercise
real microphone/Azure recognition or real-device push delivery.

The running host reports its own version at `/version`. Module capability checks
(for example `menuVersion`, `chatWindowVersion`, `composerInputVersion`) are
described in the [module contract](module-contract.md); pairings are not inferred
from version numbers. File, Notification and Speech lock the independently
published [module SDK](module-sdk.md) and record separate integration-host pins
in their own repositories. SDK semver and those source pins do not replace the
accepted release pairing or runtime capability checks.

## Install

Download a module's `.tgz` and `.sha256` from the same release, verify with
`sha256sum -c`, follow the module's own README for configuration, then install
with the host's [local module CLI](module-contract.md#local-install) using
`--trust-local-code`. Installation, enable/disable and version selection apply on
the next cold start; the CLI never restarts the service. `list` distinguishes the
next-start selection from what is currently loaded.

## What each module does

- **File** — attach files by picker, paste or drag-and-drop; preview and download
  files and media. New uploads and new live replies capture a file version that
  later path changes do not overwrite. It does not scan or backfill old chats and
  is not a server file editor.
- **Notification** — unread markers for final assistant replies and pending
  questions, session counts, and device-controlled Web Push and app badges in the
  existing global menu. Read state follows actual on-screen presentation, not
  opening a session. Push and badges depend on browser, device and permission and
  are not guaranteed delivery.
- **Speech** — Azure speech dictation that wraps the real composer input: it
  records before the native send and writes text into the captured draft; it never
  sends automatically. The button stays visible but disabled when a native
  question disallows free text. Configuration is a file in the module's data
  directory; there is no settings page.
- **Task** — structured tasks, explicit assignment, and orchestrator/assignee reports.
  It is not an automatic scheduler.
- **WeChat Connector** — connects one authorized WeChat direct-message user to a
  chosen session for text and supported media; group chats and native voice are
  not supported.

Business behavior and limits of each module are documented in its repository.

## Shared rules

Modules use public product APIs and versioned frontend interfaces, and own their
configuration, secret references and business data. Native sessions, history,
queues, model context and MCP/skill switches remain Copilot's. A module that fails
to start is disabled and reported while the host keeps running; backends run
in the host process without a sandbox.

Graceful shutdown waits only for native sessions. Module activity does not block
exit, so modules handle their own recovery and never blindly resend operations
with unknown results.

## Possible future modules

Not released and not a commitment: more speech providers or sending recordings;
session organization (pinning, auto-naming via the native rename API); a system
status dashboard; a next-start message that is persisted before requesting exit
and reports acceptance, failure or unknown after restart; a self-only Context
Reset tool; and an Assistant bundle of roles, skills and templates applied
explicitly to native sessions.
