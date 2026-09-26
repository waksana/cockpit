# Cockpit 0.6.1

Includes the final `ask_user` Markdown choice presentation (#242), the original
question/history support (#237), and the default-model and composer fixes (#235).
This patch assigns a new immutable identity to the final rendering correction.

- Each choice is one full-width native button. Non-interactive Markdown text
  is its label; there is no separate selection action, nested link, copy control
  or resource loading. Clicking the label or padding, or using Enter/Space,
  submits the complete original choice string, including Markdown and newlines.
- Pending questions and original questions in answered/restored records retain
  the full shared Markdown renderer, including links, code and tables.
- Default-model preferences use the versioned host configuration correctly.
  Existing sessions keep their native model behavior; explicit saves preserve
  unrelated values and unavailable defaults remain explicit errors.
- Accepted answers, clearing and question changes restore the composer's natural
  height without discarding failed or unaccepted drafts.
- Global module MCP/Skill rows use the native resource presentation, retaining
  provenance and connection/error details without redundant role slogans.

The host, Web, MCP, core and internal protocol report 0.6.1. The independently
versioned [module SDK](module-sdk.md) is unchanged and is not republished.
No host or Task data migration is introduced by this host release. Existing
schema v10 data must not be passed through the earlier v9 upgrade again.

Publication does not install or restart a service. The
[module catalog](modules.md#accepted-pairing-and-upgrade-boundary) records the
last accepted pairing, not an unverified deployment candidate. Synthetic coverage
does not establish real-device, microphone/Azure or push-delivery acceptance.
