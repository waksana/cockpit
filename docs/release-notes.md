# Cockpit 0.6.0

Delivery candidate for the merged default-model and presentation fixes (#235)
and `ask_user` Markdown support (#237). This source preparation is not a
deployment or publication record. The minor version marks the new user-facing
Markdown capability rather than treating the delivery as patch-only.

- Render pending questions, choices and the original question in answered or
  restored records with the shared Markdown renderer. Existing links, code,
  lists, quotes and tables retain the same safety rules.
- Keep each choice's Markdown content separate from its selection button.
  Opening a link or copying code does not answer the question; selecting an
  option submits its complete original string, including Markdown and newlines.
- Read default-model preferences from the versioned host configuration without
  treating `schemaVersion`, `revision` or `values` as model settings. Explicit
  saves preserve unrelated values and use the host writer lease. Existing flat
  preferences remain readable and upgrade only on an explicit save.
- Let the answer composer return to its natural height after an accepted answer,
  clearing or question changes, while preserving failed or unaccepted drafts.
- Align global module MCP/Skill rows with the native resource list and remove
  redundant role-enabled slogans without removing provenance, connection/error
  state or existing detail interactions.

The host, Web, MCP, core and internal protocol report 0.6.0. The independently
versioned [module SDK](module-sdk.md) is unchanged and is not republished.
Default-model changes still apply only to newly created sessions; existing
sessions, resume/reload and fork retain their native model behavior. An
unavailable default or creation-time model mismatch remains an explicit error.

This candidate does not change module packages or introduce a Task database
migration. The [module catalog](modules.md#accepted-pairing-and-upgrade-boundary)
retains the last accepted pairing until this candidate is deployed and accepted.
Existing schema v10 data must not be passed through the earlier v9 upgrade again;
restoring a database backup discards later writes and requires separate
authorization.

Deployment acceptance, immutable tags and publication remain separate from
source preparation under the [release procedure](releasing.md#release-after-acceptance).
Synthetic component/browser and isolated native coverage do not establish
real-device, microphone/Azure recognition or push-delivery acceptance.
