# Official modules and session roles

This document specifies the module-system scope authorized on 2026-09-11.
It is not permission to migrate an existing installation, enable a paused channel,
publish a repository, or replace the current private delivery authority.

## Ownership and storage

Cockpit owns installation and role composition, not Task's business state or the
WeChat protocol. Official modules remain separately versioned projects; services
run in separate processes. The Web application remains part of Cockpit.

The configurable `COCKPIT_USER_ROOT` defaults to `~/.cockpit`:

```text
config.json                         # host configuration and publisher trust
modules/<id>/releases/<version>/     # immutable program files
module-config/<id>.json              # versioned configuration references
data/<id>/                          # module-owned business data
logs/<id>/
session-modules/<sessionId>.json     # chosen/applied roles and incomplete operations
session-module-history/             # retained role receipts after confirmed deletion
config-backups/                     # configuration revisions, not business DB rollback
module-updates/                     # explicit download/install operation receipts
```

The main installation and native Copilot storage are independent. Installing a
module never copies native databases, credentials, private conversations, or
workspace memory into a release. Legacy data can remain in place through explicit
absolute references; tidy directories are not a reason to migrate live data.

Files containing configuration and references are owner-only. A reference is a
path, not the credential contents. Same-user processes remain within the existing
local trust boundary: role selection is not a malicious-agent sandbox.

## Role semantics

| Module | Session content | Side effect |
| --- | --- | --- |
| Assistant | Appended role instructions and `cockpit-assistant` skill | None during installation/creation/resume/reset. Personal files are created only when the conversation needs them and the user agrees. |
| Task Commander | Commander instructions, module-only skill, version-pinned MCP entry | Protected Task-side caller provisioning after the native session exists. The session receives a stable access-file reference, never a token. |
| Task owner | Owner instructions, module-only skill and MCP | Selected explicitly by managed Task dispatch. No caller provisioning and no implicit Assistant/Commander inheritance. |
| WeChat | No instructions, skills or MCP | Connector-owned unique binding to the selected native session. |

New-session selection is multi-select, with at most one role per module.
Unavailable choices carry a reason and, when relevant, the already bound session.
Only capabilities declared by an installed role are invoked.

The interactive creation flow waits for the first real message before allocating
a native session ID. Directory/role selection alone is form configuration, not
a native session or a WeChat prebinding. Sending text, voice-transcribed text or
retained files creates the native session, prepares the selected environment and
required module connections, and only then submits that first message to the
model. No hidden initialization message is sent. The first message originates
from Cockpit in this initial workflow; WeChat cannot address a session that does
not yet exist.

Creation uses a stable operation identity, distinct from the native session ID.
An uncertain result is inspected through the original operation, never retried
by silently creating another session or resending the first message. Acceptance
means the native message was accepted, not that the model completed its answer
or read every file. Existing low-level `session/new` remains available to legacy
clients and Task's already-admitted dispatch sequence; a bare empty native session
does not carry a persistence guarantee. In runtime 1.0.83, explicit save did not
make a never-messaged empty session recoverable after unload.
Explicit module reapplication therefore refuses an empty native session before
changing its role record or closing it. A Task owner created with its role already
applied must be verified read-only, not closed and reapplied before its first
dispatch message.

The host uses native session-scoped `systemMessage` in **append** mode,
`skillDirectories`, and `mcpServers`. Existing engineering instructions remain.
Before composition, names are checked against project/global discovery and other
selected modules. Native discovery silently deduplicates same-name skills, so its
combined result alone is not a conflict detector.

The product persists the last applied selections separately from pending ones.
It marks application complete only after the selected skill paths and MCP
connections, plus required module-side binding/provisioning, are confirmed.
Failures preserve the session and operation identity; an uncertain mutation is
not retried under a fresh identity or replaced by a newly created session.

Cold loading supplies the bound immutable version again. It does not replay an
initialization message or silently use the newest installed module. Native
terminal context reset retains the role configuration; it does not need an extra
business prompt. Old model context is not erased by installing a new skill.
Later skill reads and relative references resolve from the same pinned release.
An ordinary cold-load discovery/readiness error does not turn a previously
completed application into a permanently unfinished one. It remains a runtime
loading error. A partially loaded, unconfirmed handle cannot accept messages
until an explicit safe reload succeeds.

Applying a new environment is explicit. The session must be loaded and idle,
without active schedules; the host does not cancel timers, queues or work on the
user's behalf. A safe close and cold resume replace the environment. Already
applied operation IDs return their retained result rather than repeating the
lifecycle. A module-aware MCP reload also restores the bound role configuration,
while unrelated temporary native switches still follow native cold-load rules.

## Optional session unbind

The 2026-09-11 17:22 decision makes session unbind an optional, explicit capability:

```json
{"sessionLifecycle":{"unbind":{"entry":"src/module-control.js"}}}
```

An absent capability means no notification and no unbind call, even if the
session used that module's instructions, skills or MCP. The host does not
broadcast every native deletion to every module. Assistant and Task do not
declare this hook by default. WeChat declares it to release its target binding
without deleting account configuration, business history or unknown sends.

`session/delete/preview` reads only the associated declared capabilities.
The delete dialog identifies those modules and asks for explicit
"unbind and delete" confirmation. Both native deletion intents accept the
preview's `planId` and a stable operation ID in `unbind`. The host refuses a
changed plan, runs required unbind hooks at the native safe boundary, and only
then deletes the native session. Ordinary clients cannot bypass declared hooks
by sending only `confirm:true`. Busy/unknown required unbind outcomes block deletion;
partial success is retained and must not be misreported as a completed deletion.

The installed, integrity-checked hook receives bounded JSON stdin:
`{operation:"session-unbind",operationId,sessionId}`. It returns a confirmed
matching operation/session acknowledgement. This explicit operation is
idempotent: repeating it cannot detach another, newer session binding.
No hook creates or loads a native session, prompts a model, starts a channel or
replays a task/message. Completed steps and uncertain outcomes are retained;
operator continuation uses the same operation identity. Removing a session does
not erase the operation receipts, module data, user memory or managed uploads.
After native deletion is confirmed, the old role/application record is archived
before its live reference is removed. A failed or unknown role application with
no remaining required unbind does not leave an undeletable module reference.
The original completed module-deletion receipt remains readable through
`session/delete/preview` after native removal; reading it never recreates the
session or repeats an unbind.

Unload/load preserves the native session ID and does not invoke unbind.
Out-of-band deletion can leave an unavailable target; consumers still check
their target when used and must never silently create a replacement.

## Versions and updates

The UI distinguishes installed releases, the default for new role selections,
each session's applied version, and a shared service's actual version/instance.
An installed client does not create an imaginary private copy of a shared Task
or WeChat service. Compatibility must be confirmed through the service module
API, not inferred from a package directory.

Two source paths are deliberately separate:

1. A trusted local official catalog supplied by the installer. Assistant is
   shipped with Cockpit; additional exact directories can be supplied through
   `COCKPIT_MODULE_SOURCES`. This is explicit local source trust, **not** a claim
   that a self-computed inventory hash authenticates a remote publisher.
   `modules/list` advertises that source's exact `localRelease` version and
   inventory digest, or an explicit source error. `modules/install/local` pins
   those values and a durable operation ID. This keeps the bundled Assistant
   installable without configuring a remote publisher and without automatically
   installing or applying it.
2. An opt-in signed Release channel. Host configuration pins an Ed25519 public
   key, HTTPS metadata URL and permitted download origins. Metadata includes
   sequence, issue/expiry time and exact module/version/platform/source-SHA,
   archive size, digest and URL. Verification rejects stale sequence floors,
   expired metadata, ambiguous targets and untrusted origins. Changing trust
   roots remains an installer/operator action.

Private download credentials are local file references. Authorization is sent
only to the configured metadata origin, never blindly forwarded to asset
redirects. A same-origin checksum without a trusted signature is not publisher
authentication. This initial signed-channel format does not claim the complete
delegation/key-rotation machinery of TUF.

Publisher CI can produce the envelope with Node 24:

```sh
node scripts/sign-module-release.mjs metadata.json /protected/ed25519-private.pem stable.signed.json
```

The input follows `ModuleReleaseMetadata` in the shared protocol. Each digest
and size must describe the actual immutable ZIP, not a freshly repacked consumer
copy. The private key stays in the publisher's protected CI environment; only the
signed envelope and archive are uploaded to the existing private or public
Release destination. The script does not publish, change repository visibility,
generate trust roots, or enable a consumer updater. Consuming users need only
their own read access, never the publisher's CI/CD credentials.

Explicit check, download/install, service activation and session application are
different actions. None enables a periodic schedule or automatic installation.
The downloaded ZIP is consumed unchanged: it contains one bounded
`runtime.tar.gz`, extracted using the same safe extractor as the existing
delivery toolkit. The extracted module identity is compared with the signed
target, then a canonical inventory is installed into a new immutable directory.
Existing running files are not overwritten. Old releases remain available while
referenced; uninstall does not remove configuration or data.

Configuration changes use revision preconditions and keep backups. Incompatible
`configVersion` values require an explicit migration decision. Rolling back code
or a configuration file is not rolling back Task/WeChat business data. Unknown
WeChat sends are never replayed as part of install, recovery or activation.

The independent service runner is a separate process outside native sessions.
Only its explicitly managed children can be drained and switched. It must wait
for safe exit without force-kill deadlines, verify the new immutable identity and
same-instance health, and retain uncertain outcomes for inspection. The existing
private CD remains authoritative for installations already under its control;
two launchers must never compete for the same selection or data directory.
For a new consumer-owned main installation, the separate
[consumer installer and stable launcher](consumer-installation.md) consume the
same CI archive without private-CD access. That explicit authority is distinct
from this module runner; it neither adopts existing services nor starts a
second Task/WeChat supervisor.

### Managed service operations

`modules/service` submits one operation to the explicitly configured independent
runner. `start` and `apply` pin both an installed version and its inventory digest;
`stop` selects no replacement. Submission returns a job, not a running-service
claim. `modules/service/job` reads that same operation, and
`modules/service/status` reports the runner's actual ownership, version, digest
and instance. Installing a newer package does not change any of those facts.

The private Unix socket is local to the configured user root. Cockpit does not
spawn a second runner when its socket is absent. A stale singleton lock or an
unowned historical child needs host-side inspection, not automatic adoption.
Service control uses native loopback HTTP without browser `Origin`, `Referer`
or `Sec-Fetch-*` headers; it does not weaken the module's management credential
or nonbrowser checks.

A failed or unknown job blocks ordinary replacement operations. When the
authoritative status explicitly reports `canRecoverStop`, the user may submit
a new **stop-only** operation with `recoveryOf` naming the current unresolved
operation and `confirmRecovery:true`. The runner still requires the original
owned child's identity and safe exit; this is not a force-stop, blind restart,
or permission to adopt another process. The old job keeps its original outcome.
An earlier successful start job can remain `done` even when its process later
becomes unhealthy; current recovery eligibility comes from status, not that
historical job's phase alone.

### Installation receipts and recovery

Every module download/install keeps its original operation identity, including
after a later version is installed. `modules/updates/get` reads an old operation
without downloading again or selecting its old version. Successful operations
retain their private receipt while discarding only their own temporary archive
and extraction directory.
Local installations use the same per-module publication lock, unresolved-result
fence and history. Their operation carries `source:"local"`; its `sha256`
identifies the authorized inventory, not a downloaded ZIP or publisher
signature. Reconciliation checks that inventory and the actual selection,
without recopying a source that may since have changed.

`modules/updates/reconcile` is an explicit inspection of the current unknown
installation. It does not fetch, install, select a version, start a service,
or restore data. If the target is present, it checks the original retained
archive digest and full extracted inventory against the installed bytes.
A verified selected target can be confirmed successful; an absent or unselected
target is reported as failed with its remaining files preserved. Mismatches or
an existing operation lock remain unresolved rather than being silently repaired.

### Fresh Task configuration

An official release can explicitly declare
`configLifecycle.initialize: { entry, args? }`. An absent declaration is not a
default hook. The initial host endpoint supports Task only; Assistant remains
instructions/skills only, and this does not replace WeChat's account login flow.

`modules/config/initialize` requires a fixed operation ID, installed Task
version/digest, canonical HTTPS gateway origin and explicit confirmation.
It is for a fresh private `data/task` directory and unconfigured module only,
not adoption of an existing Task installation. Its module-owned initializer
creates the initial manager credential and read-only gateway viewer, returning
private file references rather than secrets. It creates no caller, native
session or task and does not start the service. Existing deployments continue
to use explicit references until a separately approved handoff.

The original operation is read through `modules/config/initialization`.
Unknown results do not authorize another initialization, and a configuration
publication conflict must preserve the newly created references without
overwriting the user's intervening changes. After confirmed initialization,
starting the service remains a separate explicit action.

## HTTP and authentication boundary

The public Task page is under `/modules/task/`, sharing Cockpit's authenticated
origin. The gateway exposes only the Task UI assets, read API and SSE allowlist.
It injects a viewer-scoped credential and the configured gateway host; it never
forwards the browser's cookies or authorization token to Task.
Task's CSP, referrer policy and `X-Accel-Buffering: no` survive the proxy.
The SSE path streams subsequent changes and propagates disconnects rather than
leaving a stale connection labelled ready.

Internal `/admin/*`, tool/mutation endpoints and lifecycle controls are not
published through that path. TLS, DNS and Passkey remain the host's
responsibility. The existing `task.rbym47.com` route must remain usable until an
explicit migration decision changes it.

WeChat binding control belongs to the module, including while the sender is
stopped. The control adapter must refuse concurrent double binding, running or
unknown-send transitions, preserve historical state when unbinding, and never
start a paused channel merely to display its configuration.

## Supported initial environment

| Surface | Initial prerequisite/boundary |
| --- | --- |
| Host | Linux x64, Node 24; native SDK/runtime versions follow Cockpit's existing contract. Windows/macOS are not claimed supported. |
| Archive extraction | Python 3 with the toolkit's safe tar extraction support. Actual CI packages can contain ordinary dependency filenames with spaces; declared executable/role entry paths remain strict. |
| Storage | Writable, canonical owner-only user root; immutable releases and separate configuration/data. No writes to an arbitrary user's project during installation. |
| Services | Explicit loopback addresses and data/credential references; Task also requires its existing `flock` runtime dependency. External authority is read-only until a separately confirmed handoff. |
| Process supervision | An independent launcher/runner must outlive the Cockpit/native session it may restart. Manual and service-manager launch need their own explicit installation arrangement. |
| Network | Trusted HTTPS publisher and download origins. Offline/failed checks mean newest version is unknown; no silent source, proxy or TLS bypass. |
| Existing clients | Cockpit-managed MCP connections can change at the safe application boundary. External MCP clients must reload through their own lifecycle. |

Production acceptance must separately demonstrate package consumption, real
native create/cold-load/reset/version application, Task caller/owner composition,
binding/unbinding failures, page/API/SSE routing, safe service replacement,
configuration recovery, and the actual running identity. A diagram, a mock,
an accepted operation or a healthy old process is not that acceptance.
