# Cockpit 0.2.0

Unreleased development version. No tag or Release has been created for these changes.

- Local trusted module packages can be installed and selected for cold loading.
  Remote signed-URL installation remains deferred.
- Module API v1 provides scoped backend HTTP routes, versioned assets and
  filtered native-event observations, plus frontend composer, file-input and
  message-rendering contributions. Modules share the host React runtime.
- Native attachments are wired through browser drafts, one-shot submission and
  history display. Uploading or failed selections block sending; late native
  acknowledgements preserve newer edits.
- The separate `cockpit-file` module supplies chat uploads and best-effort
  capture of new streamed Markdown file references. It is not bundled or
  implicitly enabled; file-library management and historical backfill are not included.
- **Configuration boundary:** `COCKPIT_HOME` controls only Cockpit and module
  data (default `~/.cockpit`). Native Copilot state and authentication keep
  their own defaults and configuration; the host no longer overrides native
  client/session directories. Remove an old host override pointing at
  `~/.copilot`; do not move or copy native data.
- The supported service package baseline remains Node 24.20.0, Linux x64/glibc,
  SDK 1.0.13 and runtime 1.0.83 / protocol 3.

Publishing still requires the same fixed-commit CI and immutable tag process.
These source changes do not authorize deployment, service restart or user-data migration.
