# Cockpit 0.2.0

Unreleased development version. No tag or Release has been created for these changes.

- History loading uses a CSS-only top overlay outside the measured transcript,
  avoiding the content shift when the loading indicator appears or disappears.
  No height measurement, spacer or additional scroll controller is introduced.
- Return-to-latest appears after moving at least one transcript viewport away
  from the bottom, without changing automatic following or reading anchors.
- The execution label includes a quiet running-status dot. Expanded queued
  messages expose the shared small copy control with stable confirmation and
  explicit clipboard errors, independently of queue removal or submission.
- Chat separates pending decision cards from a compact framed execution/queue
  panel, keeps Stop available while awaiting a decision, and applies consistent
  spacing between visible message groups. Queue headings and repeated composer
  hints are removed; placeholders remain visibly distinct from entered text.
- Expanded tool details align with thought details. Markdown paragraph wrappers
  no longer add extra top/bottom whitespace inside user message bubbles.
- Chat spacing now has explicit owners across the reading column, message
  interiors, floating panels and composer. Notices, module contributions and
  native attachments share a bounded input-context stack; absent content leaves
  no extra gap. User bubbles retain their original padding; the compact bottom
  bar keeps its circular send target and is not compressed by taller panels.
- Chat typography now uses explicit body, secondary, label and metadata roles.
  Timestamps share a compact treatment without a decorative assistant badge;
  decisions and process rows adapt to the actual Chat width beside settings.
- Copy feedback keeps a stable target width and does not flash an intermediate
  label, including repeated copies. Session-ID confirmation is centered and stays
  visible without a timer; clipboard failures remain explicit.
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
