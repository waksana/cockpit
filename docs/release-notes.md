# Cockpit 0.2.0

Unreleased development version. No tag or Release has been created for these changes.

- Idle, executing and decision input now use the same card frame and editor
  geometry, without a nested answer-field border or focus fill. Multiline growth
  remains content-driven; stable scrollbar gutters prevent width changes during
  long forms. Module action-to-text spacing is tighter without reducing hit targets.
- Chat execution, queue, decisions and the existing editor share one default-open
  card with an unmarked, keyboard-operable folding header. Long content scrolls
  together within a CSS height budget; submission progress stays in an existing
  header and operation errors stay outside disclosure. Ordinary idle input remains
  a compact bottom bar with no new header.
- Browser history pages use the native runtime's 200-event default size, retaining
  native cursor continuation, bounded single-page reads and existing viewport
  prefetch; live SSE batching is unchanged.
- Cold Chat history displays each received page immediately instead of hiding
  mounted rows until two viewport heights have accumulated. Two-screen prefetch,
  the existing scroll owner and the history-start hint remain unchanged.
- Expanded thinking renders Markdown with the shared message renderer, including
  headings, lists, links and copyable code, without changing the native text or
  reasoning ownership.
- A plain history-start hint stays at the beginning of the scrolling content
  until the earliest history is reached. It no longer appears/disappears around
  individual requests. No overlay, height measurement or hidden spacer is used.
- Return-to-latest appears after moving at least one transcript viewport away
  from the bottom, without changing automatic following or reading anchors.
- The execution label includes a quiet running-status dot. Queued messages
  always expose the shared small copy control with stable confirmation and
  explicit clipboard errors, independently of queue removal or submission.
- Execution status and queue actions share a compact row at normal phone widths,
  with long status text truncated instead of pushing both buttons to a new row.
- Chat keeps Stop available while awaiting a decision and applies consistent
  spacing between visible message groups. Queue headings and repeated composer
  hints are removed; placeholders remain visibly distinct from entered text.
- Expanded tool details align with thought details. Markdown paragraph wrappers
  no longer add extra top/bottom whitespace inside user message bubbles.
- Chat spacing now has explicit owners across the reading column, message
  interiors, floating panels and composer. Notices, module contributions and
  native attachments share the input card's bounded content area; absent content leaves
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
