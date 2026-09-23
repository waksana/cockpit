# Cockpit 0.4.4

Current-source deployment version for global MCP/Skills detail fixes
(#153), session settings layout (#156), unified resource rows and global-default
hints (#157), shared base controls and tokens (#160), Stylelint and class-name
guardrails (#161), native MCP server tags on tool rows (#162), and two-line
session cards with explicit overflow priority (#163).

The module host bridge now allows the existing `session/rename` intent (#165).
Full loaded-session reads expose optional `nativeName`; `nativeNameUserSet` is
included only when workspace provenance is available and agrees with that name.
List, snapshot and resource reads do not perform these provenance reads.
This additive capability leaves backend API v1,
Web API v2 and the existing UI capability versions unchanged.

All host workspaces and MCP self-report 0.4.4. Native SDK 1.0.13 / runtime
1.0.83 are unchanged. Modules remain independently versioned. This preparation
does not migrate user or Task data, replace installed 0.4.3 contents, select
modules, create a tag or GitHub Release, or install/restart a service.

---

# Cockpit 0.4.3

Current-source deployment version for resource presentation updates
(#139), the role picker (#141), removal of session connection-method display
(#143), one-click exit from global management (#146), and session settings
reload, unload, compaction and full-history fork controls (#147).

All host workspaces and MCP self-report 0.4.3. Native SDK 1.0.13 / runtime
1.0.83 and module API capability versions are unchanged. Session operations
retain native lifecycle protections and do not expand backend capabilities.
This preparation does not migrate host data or replace installed 0.4.2
contents. Modules are independently versioned; in particular, the separately
prepared Task schema v5 upgrade is not reversible by selecting Task 0.1.9.
No tag, GitHub Release, installation or service restart is performed by this
version-preparation change.

---

# Cockpit 0.4.2

Current-source deployment version for the MCP and Skills resource
redesign in #131 and compact process summaries in #133. Global resources use
compact master/detail lists; global and session resources share provenance
badges, with global module attribution only where identity is verified.
Chat process headers use distinct icon/count pairs for tools, thoughts
and Skills while retaining accessible labels, status and full nested details.

All host workspaces and MCP self-report 0.4.2. Native SDK 1.0.13 / runtime
1.0.83, module backend API v1, Web API v2 and existing UI capability versions
are unchanged; resource provenance and the titlePrefix extension are additive.
This new immutable version does not replace installed 0.4.1 contents, migrate
user data, change module selections or create a tag, GitHub Release or restart.

---

# Cockpit 0.4.1

Current-source deployment version for the list layouts in #122, the
SquareTerminal app icon in #124 and dialog focus fixes in #127.
These presentation fixes do not change native session controls or module business behavior.

All host workspaces and MCP self-report 0.4.1. Native SDK 1.0.13 / runtime
1.0.83, module backend API v1, Web API v2 and existing UI capabilities are
unchanged. Existing module selections, parameters, credentials and user data
are not migrated by this version preparation. Changed runtime contents use
this new version rather than replacing the installed 0.4.0 identity.
This preparation does not create a tag or GitHub Release or restart a service.

---

# Cockpit 0.4.0

Deployment preparation for the native session controls in #119. The
conversation now exposes active agent/terminal groups, scoped cancellation and
group clearing, native queue steering, request-bound decision cancellation and
an explicit global Stop. Sidebar and input controls share the overall activity
indicator; native partial outcomes, loaded-handle identity and newer-turn
ownership remain explicit.

This is a compatible capability addition, with unchanged native SDK 1.0.13 /
runtime 1.0.83, module backend API v1, Web API v2 and existing UI capabilities.
All host workspaces and MCP self-report 0.4.0. Module selections, credentials,
native session data and module versions are not changed by this preparation.
The versioned source can be packaged for the authorized deployment; this change
does not create a tag or GitHub Release or itself restart a service.

---

# Cockpit 0.2.7

Current-source deployment version for the shared UI and responsive pane
composition from #93. Existing session and management screens consume shared
controls, resource rows and pane headers/bodies; wide inspectors participate in
normal layout flow and narrower inspectors retain native dialog semantics.

Adds the independent `uiSurfaceVersion: 1` capability for public CSS surfaces.
Base UI v1 remains unchanged. New paired module consumers explicitly require
this capability; their SDK pairing to source
`9fd5204bda99a8bd65b2c5ef152cc47ce87837d5` remains valid. This version does not
claim that earlier 0.2.6 packages expose that capability.

All workspace and MCP versions are 0.2.7. Existing current-source role changes
described below are included. Native data, drafts, resource ownership and
module business behavior are unchanged by this version-preparation change.
The [delivery rules](packaging.md#delivery-versions) now make immutable module
versions and pre-deployment checks explicit in developer entry points.
This source preparation does not create a tag or Release.

---

# Unreleased source: explicit native tool-table recovery

Distinguishes uninitialized native tool metadata (`null`) from an initialized
empty or filtered tool table. Role readiness remains passive and fails explicitly
on unknown visibility or genuinely missing tools. Adds `session/tools-initialize`
through the existing API/generic MCP caller for a loaded idle target: resolve and
validate native tools without a prompt, cold reload, global writes, role application
or resource enablement. A successful initialization is not role readiness.

SDK 1.0.13/runtime 1.0.83 can invalidate the table after model/Skill changes;
the isolated native fixture covers fresh sessions, persisted-session reuse and
preserved native filtering. See [recovery boundaries](module-contract-draft.md#工具表失效与显式恢复).
This fix is not part of the already deployed 0.2.7/source `1dd38c6`. No version
publication, installation or restart is implied; allocate a new delivery version
before packaging/deploying changed contents.

---

# Unreleased source: guarded session resource preparation

Adds the strict public `session/resources-prepare` intent and only that narrow
addition to the module host bridge. The frozen facade advertises
`resourcePreparationVersion: 1`; resource-aware consumers must check it before
creating or preparing a session. Backend API v1 and the existing Task UI pairing
at `9fd5204` / `uiSurfaceVersion: 1` are unchanged.

On an already loaded idle target, one lifecycle guard protects complete selection
prevalidation, explicit disabled-resource activation, tool-table initialization
and native readback. Unrelated choices are preserved. Partial and unknown effects
remain in per-request receipts; no prompt, reload, authentication, connector retry,
global configuration or persisted resource mirror is introduced. Host preparation
is not role readiness or Task assignment; unfinished Task selection protection
remains solely in the Task module. Raw native MCP tool names are required, `"*"`
is rejected, and omitted/empty tool lists require at least one actual offered tool.
Tools initialize once after a confirmed resource enable or when metadata is null.
This repairs the native MCP-enable stale-table case in the same preparation even
when metadata is non-null. ToolSet/native filtering is preserved; genuine missing
tools still fail with confirmed enablement retained. Already-enabled selections
with non-null missing tools do not trigger speculative rebuilding.
See the [full contract](module-contract-draft.md#session-resource-preparation).

This is source-only, not deployed in 0.2.7/source `1dd38c6`. No per-commit version
bump, release, installation or restart is performed. A new immutable delivery
version is required before publishing/deploying changed contents.

---

# Unreleased source: append roles to an existing session

Adds `roles/add`, `cockpit_add_roles` and a Web session-settings action for
metadata-only append on the same session ID. Saving is allowed during main turns,
subagents, shells, queues, questions and schedules; unloaded sessions stay unloaded.
No native stop/reload/resume/prompt, copied session, busy waiting, new notification
mechanism or automatic retry. Native lifecycle load/close/delete conflicts may
reject. Catalog IDs and the combined 64-role limit are checked when saving;
composition, integrity and resource conflicts are validated at ordinary load.
This does not change Task ownership, delegation or role persistence.

New roles apply only on ordinary explicit reload or next cold load, under normal
native/global defaults without special retention of temporary switches or
session-only resources. Unavailable saved resources fail loading, not silently
fall back. Saved `roles`, live `appliedRoles` and `rolesNeedReload` distinguish
selection from application; unloaded sessions have next-load semantics and no
reload flag. Readiness remains a separate passive check.

**Compatibility:** the addition result now uses `saved | unchanged | uncertain`,
not `applied | unchanged | incomplete | uncertain`; `phase` and embedded
`readiness` are removed. `saved` is not proof of application or readiness.
Duplicate saved choices return `unchanged` without applying them. Unknown
persistence outcomes require inspection, never automatic retry or rollback. See the
[role contract](module-contract-draft.md#已有会话显式追加) for limitations.
No Task package adaptation, release, deployment or real-session mutation is implied.

---

# Unreleased source: explicit role capability checks

Simplifies the development role integration from #68 without creating a release
or authorizing deployment. `roles/readiness`, `cockpit_role_readiness` and the
typed module `context.host.call('roles/readiness', ...)` bridge remain explicit,
on-demand checks. Ordinary session metadata, lists, snapshots and Web panels no
longer carry `roleReadiness`; consumers must explicitly request capability
evidence and check busy/pending/subagent state separately.

The automatic `session/advance-queue` intent, `cockpit_advance_queue` tool and
`QueueAdvanceOperation` type are removed without aliases or receipt recovery.
Single main-turn interruption preserving the queue, per-ID pending removal,
prompt, ordinary Stop/cancel and lifecycle protections remain unchanged.
Role selection labels are not capability proof; readiness badges are deferred.
Creation-time role System Prompts, native Skill roots, shared MCP tool unions
and selected-role persistence/current-resource cold resume remain supported.
See the [module contract](module-contract-draft.md#44-创建时角色与模块-http-mcp).

---

# Cockpit 0.2.6

Adds public UI v1 input/status classes for paired Speech 0.3.1. The native
composer uses the same `ck-input-row` geometry available to consumers.
`ck-input-hint` follows the host input size; `ck-status-text` uses the auxiliary
text role. Full-width status rows, marker alignment and trailing status actions
are host-owned styles, not speech-specific slots or business dispatchers.
See [Module UI guide](module-ui-guide.md#public-classes).

Speech remains responsible for recording, timing, errors, retry and clear.
Queue/question layout and scrolling remain unchanged and host-owned.
No new font-size variable or private `.chat-*` dependency is required.
Existing UI v1 controls and modules remain compatible; Speech 0.3.1 requires
this paired host's additive styles. All workspace and MCP versions are 0.2.6.
This source change does not itself create a tag, Release or deployment.

---

# Cockpit 0.2.5

Unreleased source summary relative to 0.2.4. Workspace packages and MCP identify
as 0.2.5; this document does not create a tag, Release, installation or deployment.
Published assets and earlier summaries remain in their corresponding GitHub Releases.

## Breaking Composer contract

[#51](https://github.com/waksana/cockpit/issues/51) removes
`ComposerEditorProps.actions` and `composerActionsVersion`, without aliases or a
replacement position slot. Consumers of that contract must migrate together with
the host, even though this experimental 0.x release uses a patch version.

The new `composerInput` component middleware wraps the actual controlled textarea.
`composerInputVersion: 1` is checked independently of Web API v2 and UI v1.
Base retains native editing, IME, Enter shortcuts, controlled props/events and
the public textarea ref, including React 19 callback cleanup. The host retains
the independent native send button and rechecks captured draft/submission gates.
Editing remains available during pending sends; disabling submission does not
silently disable the textarea.

File's existing prompt-only leading content is unchanged. Natural DOM, keyboard
and visual order is File, textarea, input enhancement, native send. Modules can
put full-width feedback after the existing composer Base, not in an empty slot
or inside another interactive control.

## Paired consumers

**Cockpit Speech 0.1.1** requires this input contract and the independent
`chatWindowVersion: 1` read-only projection. Speech 0.1.0 and hosts lacking
`composerInputVersion: 1` are not compatible with the new pairing.
The speech repository's `tooling/host-sdk.json` records the exact reachable host
source SHA and SDK package version 0.2.5; its build receipt records that export.
Merge the host API before the paired speech PR. Neither merge authorizes deployment.

Speech owns recording, Azure transcription, context selection, leases and conflict
recovery. The host adds no speech backend, business dispatcher or button registry.
Menu/header/attachment actions and File 0.1.7 / Notification 0.1.5 contracts remain
unchanged; those modules are not rereleased here.

## Unchanged boundaries

Manifest/backend API v1, Web API v2, public UI v1 and menu capability 1 remain
independently versioned. Web/backend/MCP must come from the same release.
Node 24.20.0, pnpm 10.34.5, SDK 1.0.13, native runtime 1.0.83/protocol 3 and
Linux x64/glibc remain the supported baseline.

Modules are trusted, local and cold-loaded. Copilot remains authoritative for
native sessions/history. No automatic migration, release, restart or production
configuration change is included.
