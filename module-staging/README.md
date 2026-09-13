# Parked capability source - not runnable modules

These folders preserve code removed from the active Cockpit foundation.
They are not workspace packages, are not loaded by the application and must
not enter a main runtime archive. Do not run their scripts or tests as if
their former paths and dependencies had already been adapted.

These original snapshots are not current usage documentation. Start with
the [documentation index](../docs/README.md) for the active guides.
The new target uses same-process modules loaded on host startup, not the old
independent services described inside some snapshots. No original has been
adapted or rewritten by recording that decision. The old `graceful-restart/`
folder remains provenance, not a promise that a runnable restart or startup-
message module exists.
See [the module catalog](../docs/module-catalog.md) for scope, provenance and
future responsibilities, and [the base contract](../docs/module-contract-draft.md)
for native API and frontend composition boundaries.

| Folder | Parked capability |
| --- | --- |
| `files/` | File transfer/storage and all file UI, including chat rendering. |
| `notifications/` | Inbox, unread/seen, badges and Web Push. |
| `voice/` | Dictation, capture and recognition credentials. |
| `session-organization/` | Pinning and automatic naming policy. |
| `system-status/` | Optional version and external deployment dashboard. |
| `graceful-restart/` | Optional restart controls and convenience clients. |
| `context-reset/` | Self-clear tool/skill and local handoff workflow. |
| `assistant/` | Public assistant role and skill content. |
| `task/` | Former host-side task integration, not a copy of task business data. |
| `wechat/` | Former host-side channel integration, not channel state or credentials. |
| `_shared-originals/` | Complete pre-extraction mixed files; retained once for provenance. |
| `_legacy-host/` | Retired shared official-module host, not the future plugin implementation. |
| `_retired-governance/` | Inert historical Butler/Flow design material. |

Original imports and file organization are intentionally preserved.
Module adaptation, manifests, dependency restoration and publication are
separate future work. No folder here is an installed or enabled module.
The [source inventory](source-inventory.json) records the original commit,
path, file mode and SHA-256 for each preserved file.
