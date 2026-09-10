# Native tool image previews

Cockpit shows native tool images **inside the tool result that produced them**.
Expand the tool details, then choose **查看图片**. The image opens inline; clicking
it opens the full image using the existing attachment interaction. Collapsing
the tool, closing the image, leaving the transcript, or reconnecting releases
the browser preview. Reopening is an explicit new read, not a permanent cache.

Previewing alone does not retain or forward the image. The additional explicit
**保留到文件** action uses `files/from-tool-image` to put the selected image in
the [managed file library](managed-files.md), returning an ordinary downloadable
attachment that can be selected for a prompt or explicitly delivered to Weixin.
It never auto-collects every internal screenshot.

## Native source and lifecycle

SDK 1.0.13 / runtime 1.0.83 exposes tool binary results in
`tool.execution_complete.result.binaryResultsForLlm`. The adapter recognizes
image parts and embedded resources with an image MIME. It never guesses images
from tool text, arbitrary JSON, filesystem paths, resource descriptions, or URLs.

Live folding and passive history folding retain only event ID, tool-call ID,
part index, MIME, size, availability, and an optional native page locator.
The existing fold binds the tool to its owning message; the same components
render root, active, historical, and explicitly requested subagent messages.
Collapsed subagent cards do not load child transcripts or pictures.
Neither history caches nor SSE gain inline binary payloads or a second media
database.

Bytes are re-read from the **requested session's native persisted events**.
Session unload does not prevent passive reads and does not resume a session,
run a prompt, reset an idle timer, or keep the session alive. Removing the
original image file does not remove already persisted native bytes.
Permanent native session deletion, rewind,
compaction, native omission, or invalid native cursors can make a resource
unavailable. A preview is not a promise of permanent retention or an original
unmodified file. Pixels already opened in a browser tab cannot be recalled.

Native images may not yet be persisted when a live tool finishes; the UI reports
that read failure and offers an explicit retry. Expired locators require
refreshing the corresponding history. No fallback reads files or foreign URLs.

## Shared API and authorization

The existing capability catalog publishes `session/tool-image`, available via
`POST /intent/session/tool-image` and the generic MCP `cockpit_call_intent`.
Use `cockpit_capabilities` for the authoritative input/result schemas. The
body contains `sessionId` and an `image` locator (`eventId`, `toolCallId`, `part`,
optional `cursor` and `count`); pass locator fields, not the display metadata.

This **explicit, on-demand** response contains bounded base64 plus authoritative
source identity, MIME, and byte count. It contains no URL. It uses the same
authenticated reverse-proxy boundary and origin/CSRF protection as other
intents; the backend remains loopback-only. Responses are `private, no-store`
and `nosniff`. The browser refuses redirects, verifies every source identifier,
and uses a locally created Blob URL. It never calls upload to display a preview.

Cursor hints are opaque native locators, not authorization tokens. A hint is
used only with the requested session, and the returned event and tool IDs are
verified again. Reads take one native event at a time, stopping at the known
page position when provided. Live descriptors without a locator may scan
backward until the target is found; this is not an O(1) asset API. Cancellation
stops further reads and suppresses stale delivery, though an already in-flight
native RPC itself has no cancellation API.

## Safe display and limits

PNG, JPEG, GIF, and WebP are supported. MIME must match the byte signature;
SVG, HTML, unknown formats, missing bytes, invalid base64, and native omission
markers are explicit errors, not external links or executable documents.
The browser must successfully decode before an image is displayed; damaged
images show an error instead of an empty image.

The per-image decoded-byte ceiling is **10 MiB**, matching native's documented
default `maxInlineBinaryBytes`. Cockpit does not increase that native setting.
This is a byte limit, not a new history-retention or cache-size policy.
The browser bounds the on-demand JSON response before decoding. Duplicate
clicks share one in-flight read within the mounted image; obsolete reads cannot
replace another session/message's image. Blob URLs are revoked on release,
including decode failures.

Long-lived or cross-session delivery requires explicit retention. Native history
can still keep its own copy; retaining a file does not modify SDK history.
