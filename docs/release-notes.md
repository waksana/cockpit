# Cockpit 0.5.0

Delivery candidate for the host features merged after 0.4.7. The minor version
marks new user-facing capabilities and the changed default for newly created
sessions, rather than a patch-only update:

- open module-provided Skill details with validated module and Skill identity
  (#218);
- provide the independently published module SDK, with separate public entry
  points, generated wire contracts and isolated consumer checks
  (#219, #220, #222, #226); and
- configure the default model for future sessions from the global menu, shared
  by Web, HTTP/MCP and module-created sessions (#223).

Without a saved Cockpit default, new sessions use `gpt-6-astra`. An existing
saved default is preserved. Saving a default does not change existing sessions;
resume and reload retain their native model settings, and fork retains native
inheritance. An unavailable default or a creation-time model mismatch is an
explicit error, not a silent fallback.

The host, Web, MCP, core and internal protocol report 0.5.0. The published
`@waksana/cockpit-module-sdk` remains independently versioned at 0.2.0; this host
version does not republish it. Modules consume its documented public entry
points and continue to check host capabilities independently of SDK semver.

This candidate has not been deployed or accepted in production. The
[module catalog](modules.md) retains the last accepted pairing until a new
deployment is actually accepted. The planned Task schema v10 upgrade requires a
reviewed migration plan for every existing v9 database, a consistent backup,
stopped writers and explicit migration/cutover authorization; ordinary startup
is not a substitute. Older Task packages cannot open v10, and restoring a
historical database would discard later writes and requires separate
authorization. See the Task module's
[migration procedure](https://github.com/waksana/cockpit-task/blob/9dfdb1b14bd6541eecd6176b67517f20352ddacd/docs/task-implementation.md#schema-v10-migration).

Version preparation does not install packages, select modules, migrate data,
restart a service, or create runtime tags and Releases. Joint-deployment
publication remains gated on actual acceptance under the
[release procedure](releasing.md#release-after-acceptance).
