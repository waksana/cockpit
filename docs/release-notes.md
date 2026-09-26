# Cockpit 0.0.0-dev

Host releases now follow the [Rolling delivery procedure](releasing.md):
each actual PR merge into `main` automatically attempts an immutable prerelease
for that exact merge commit. Generated versions are injected only into an
isolated package snapshot, never committed back to source.

- Development server and MCP identities display `dev+<12-character Git SHA>`;
  unavailable Git metadata displays `dev+unknown` with a null source SHA.
  The Web About dialog reads the backend identity rather than a build-time version.
- Packaged identities retain the injected version and exact manifest source SHA,
  with package/version/platform validation unchanged.
- A Rolling Release carries the runtime archive, its checksum, the deployment
  descriptor and its checksum. Explicit Milestone promotion changes an existing
  successful Rolling Release in place without rebuilding or replacing assets.

The independently versioned [module SDK](module-sdk.md) is unchanged.
No host data migration is introduced. Publication and promotion do not install
or restart a service; deployment remains separately authorized.
