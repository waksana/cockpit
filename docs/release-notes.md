# Cockpit 0.5.0

Accepted joint-deployment release, deployed on 2026-09-25 from
`e528d116c2bde03451f453b3afba36572c58fea3`. The minor version marks new
user-facing capabilities and the changed default for newly created sessions,
rather than a patch-only update:

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
version does not republish it. SDK consumers use its documented public entry
points and continue to check host capabilities independently of SDK semver.

The [module catalog](modules.md#accepted-pairing-and-upgrade-boundary) records
the accepted pairing, matching published archives, the explicit Task schema v10
upgrade and recovery boundary, and the approved File publication exception.
The deployment preserved Task identities, relationships and histories and
confirmed the running host/module identities and served assets. It did not
exercise real microphone/Azure recognition or real-device push delivery.

The schema v10 upgrade used a reviewed fingerprint-bound plan, a WAL-consistent
backup and stopped writers. Older Task packages cannot open v10; restoring a
pre-upgrade database discards later writes and requires separate authorization.
Publication followed acceptance under the
[release procedure](releasing.md#release-after-acceptance); it does not authorize
installation, migration or restart on another instance.
