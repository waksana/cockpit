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
