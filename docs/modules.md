# Module catalog

Modules add features to Cockpit. Each is released separately and never enabled by
default. **This page is the only place that lists module versions and their host
pairing**; package format, install commands and APIs are in the
[module contract](module-contract.md).

## Versions and compatibility

Checked 2026-09-25 against the published Release assets and the accepted joint
deployment.

| Module | Latest release | Paired host release | Status |
| --- | --- | --- | --- |
| [Cockpit File](https://github.com/waksana/cockpit-file) | [v0.2.4](https://github.com/waksana/cockpit-file/releases/tag/v0.2.4) | [Cockpit v0.4.7](https://github.com/waksana/cockpit/releases/tag/v0.4.7) | Installable. |
| [Cockpit Notification](https://github.com/waksana/cockpit-notification) | [v0.1.17](https://github.com/waksana/cockpit-notification/releases/tag/v0.1.17) | [Cockpit v0.4.7](https://github.com/waksana/cockpit/releases/tag/v0.4.7) | Installable. |
| [Cockpit Speech](https://github.com/waksana/cockpit-speech) | [v0.9.2](https://github.com/waksana/cockpit-speech/releases/tag/v0.9.2) | [Cockpit v0.4.7](https://github.com/waksana/cockpit/releases/tag/v0.4.7) | Installable; needs Azure Speech configuration. |
| [Cockpit Task](https://github.com/waksana/cockpit-task) | [v0.2.0](https://github.com/waksana/cockpit-task/releases/tag/v0.2.0) | [Cockpit v0.4.7](https://github.com/waksana/cockpit/releases/tag/v0.4.7) | Installable. Requires host-provided MCP invocation identity and schema v9. The older v1.2.7 is a legacy pre-release ZIP. |
| [Cockpit WeChat Connector](https://github.com/waksana/cockpit-wechat-connector) | [v0.1.6](https://github.com/waksana/cockpit-wechat-connector/releases/tag/v0.1.6) (legacy ZIP) | — | Not yet adapted: uses `module.json` and a separate service protocol; the module CLI cannot install it. |

### Accepted pairing and upgrade boundary

These four module versions were accepted together on Cockpit 0.4.7. Host,
File, Notification and Task have new releases; Speech retains its existing
0.9.2 archive. Each published archive matches the package used by the accepted
deployment. Publication does not itself install or restart another instance.

Task v0.2.0 renames its public Task vocabulary and migrates schema v7 through
v8 to v9 in place. Cockpit v0.4.6 and older do not provide the invocation
metadata required by that module, while Task v0.1.13 and older refuse a v9
database. Downgrading therefore requires restoring the coordinated pre-upgrade
database backup and may discard later writes; it is not an automatic package
rollback.

The running host reports its own version at `/version`. Module capability checks
(for example `menuVersion`, `chatWindowVersion`, `composerInputVersion`) are
described in the [module contract](module-contract.md); pairings are not inferred
from version numbers. Exact SDK source pins live in each module's
`tooling/host-sdk.json`.

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
