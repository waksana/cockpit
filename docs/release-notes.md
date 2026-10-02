# Cockpit 0.0.0-dev

Host releases now follow the [Rolling delivery procedure](releasing.md):
each actual PR merge into `main` automatically attempts an immutable prerelease
for that exact merge commit. Generated versions are injected only into an
isolated package snapshot, never committed back to source.

- Development server and MCP identities display `dev+<12-character Git SHA>`;
  unavailable Git metadata displays `dev+unknown` with a null source SHA.
  The About section in Web Settings reads the backend identity rather than a build-time version.
- Packaged identities retain the injected version and exact manifest source SHA,
  with package/version/platform validation unchanged.
- A Rolling Release carries the runtime archive, its checksum, the deployment
  descriptor and its checksum. Explicit Milestone promotion changes an existing
  successful Rolling Release in place without rebuilding or replacing assets.
- The global menu now opens one Settings dialog for the default new-session model,
  module-owned preference sections and About. Model saves are explicit and stay
  in place; global MCP and Skills remain separate pages.
- Backend modules can check `toolScopeVersion: 1` for an immutable native creation
  tool allowlist and passive configured/applied/actual evidence. Explicit empty
  selections remove tools, ambiguous MCP identities fail closed, and cold load
  preserves scope without changing the allow-all permission policy. See
  [native session tool scope](module-contract.md#session-tool-scope).
- Opt-in exclusive roles connect only their MCP resources and discover only their
  Skill directories through cold load. Native prompt receipt observations expose
  the Host ingress class without copying message content or replacing native Chat.
  See [exclusive resources](module-contract.md#exclusive-role-resources).
- Role selection now exposes all structural and module-provided denial/unknown
  reasons before creation or addition. Neutral service-binding roles can coexist
  with exclusive roles without weakening isolation; saving still rechecks under
  assignment locks. Modules require `roleAvailabilityVersion: 1`; see
  [selection availability](module-contract.md#selection-availability).
- The independently versioned [module SDK](module-sdk.md) adds `settingsVersion: 1`
  and `settings` component middleware. Modules keep their own configuration and
  operations; the host supplies only the shared presentation boundary.
- Web v3 exposes the same typed public components to host and module consumers,
  including the composer/editor/input chain. Generic draft owners share the
  existing draft core, persist complete requests before submission and explicitly
  reconcile original receipts without resending. Display message identity is
  separate from native origin. Legacy Web v2 modules stay native-only and are
  never activated twice; backend/manifest APIs remain unchanged.

Native browser draft records retain their keys and gain transaction/recovery
metadata; an older host must not be assumed to understand these records.
No server data migration is introduced. Publication and promotion do not install
or restart a service; deployment remains separately authorized.
