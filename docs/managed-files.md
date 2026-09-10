# Managed files

Cockpit's file library is the shared entry and exit for Web uploads, explicit AI
deliverables and the uniquely bound Weixin conversation. Originals live in the
existing `COCKPIT_UPLOAD_DIR` (by default `~/.copilot/cockpit-uploads`).
Uploading or explicitly retaining an artifact keeps it independently of its
session. There is no automatic expiration or deletion, no home-directory scan,
and no automatic move or deletion of legacy originals.

The thin library supports upload, paginated listing/search, browsing, selection
into a session and original-file download. It is not a collaborative drive or a
new permissions platform. Existing files already inside the managed upload
directory can appear in the list; metadata-less legacy files keep their existing
read-only compatibility. A missing or corrupt new sidecar is an error, not an
invitation to guess its identity from the filename.

The Web detail route reads only `files/get`, never the hidden file list (including
invalid-detail URLs). Sending-target changes do not reload an unchanged all-files
filter or reset its page. Changing an effective session filter does reload that
list. Returning to the list, changing search/page, or explicitly refreshing still
performs the corresponding read; failures remain visible rather than becoming
empty results.

## Protected transport and limits

All Web file and intent routes use the same authenticated origin as chat. The
installed nginx configuration gates `/upload`, `/uploads/*`, `/intent/*` and
`/capabilities` with the existing passkey service. A `/uploads` link is not an
anonymous-public publication promise. The backend binds loopback only; the
local MCP and bridge use that existing internal trust boundary rather than
browser passkey cookies. CSRF/origin validation is not a substitute for the
gateway. No anonymous media exception is needed.

The per-file limit remains **25 MiB**, also enforced by the installed gateway.
Empty new uploads retain the existing explicit rejection behavior.
It is not an unlimited-capacity commitment. Disk-full/quota errors refuse the
new upload explicitly and never delete older retained files. Transfers stream
bounded chunks rather than making whole-video base64 messages.

`POST /upload` accepts an `application/octet-stream` body and query fields
`name`, `mime`, optional `source` (`web`, `mcp`, `weixin`, `tool-image`),
`sessionId` and `sourceId`. `sourceId` requires a source and session. The stable
source tuple is an idempotent storage identity: the same bytes return the same
file; different bytes are a conflict, not an overwrite. Storage acceptance is
separate from native prompt acceptance and Weixin delivery acceptance.

New uploads are fsynced, hashed with SHA-256 and published with authoritative
sidecar metadata. Display names never become paths. Known media signatures,
not extensions or a declared image/video MIME alone, determine preview MIME.
Metadata records original name, size, MIME, creation time, digest and source
identity. A native prompt also adds a durable session association without
copying the original. Missing bytes, metadata corruption and size mismatch fail
explicitly. An interrupted unpublished temporary file is not a library item;
this feature does not silently clean up crashed transfers or diagnostic data.
An unavailable published name is reported separately in paginated `errors`,
so one damaged item does not hide healthy originals. A byte-identical retry of
the same source can finish metadata publication after a crash; a conflicting
source or corrupt existing sidecar is never silently replaced.
Storage suffixes for recognized formats follow verified MIME, because native
image tools use filename extensions to select their reader. This changes only
the internal safe name; the original display/download filename is preserved.

Weixin originals mean the media bytes actually delivered by its protocol, not
an unreceived pre-compression version from the phone. The library preserves
those delivered bytes and their digest. It cannot reconstruct a version Weixin
did not provide.

`GET /uploads/<safe-basename>` streams original bytes, including single-byte
range requests (`206` / `416`) for browser video seeking. `HEAD` returns length.
`?download=1` adds attachment disposition with the original display name. New
files expose their stored digest as an ETag so consumers can check integrity.
File resolution for use/download checks that digest, including same-size
corruption. A bounded cache of verified inode/size/nanosecond timestamps avoids
rehashing an unchanged original on every video seek; it never caches video bytes.
Library listing reads metadata rather than hashing every file. Files without
an original recorded digest cannot provide that historical integrity guarantee.

## Display is not model understanding

Raster images and SVG use image rendering, never inline user SVG markup,
`object`, or an executable HTML document. Downloaded originals retain their
bytes and format. Direct upload responses have `nosniff` and sandboxed CSP with
external resources and scripts blocked. An SVG original is not relabeled PNG;
this implementation does not create a lossy raster replacement or claim that
all SVG constructs can be previewed.

Videos use the browser's native player. Container recognition does not promise
support for every codec. Other formats remain honest downloadable files.
Receiving/sending a video, browser playback and the selected model's ability to
understand video are separate capabilities. No new video-understanding model,
paid transcoder or background conversion service is installed.

## API, MCP and native tools

The authoritative intent catalog exposes:

| Intent | Result |
| --- | --- |
| `files/list` | Bounded metadata page, optional name/MIME/source query and session filter |
| `files/get` | Original metadata, recorded session associations and safe server path for one upload URL |
| `files/associate` | Associate a retained file with a session, without sending it |
| `prompt` | Text plus one file, multiple ordered files, or interleaved text/file parts |

Use generic `cockpit_call_intent` with the exact API bodies. Discover an unknown
schema explicitly through `cockpit_capabilities`; invocation itself sends one
POST without a repeated discovery preflight. File upload/download tools still fence local paths to
their approved roots; server-returned paths do not authorize arbitrary local
reads on another machine. Agent-generated artifacts enter the library through
explicit upload, not through passive scanning of tool output or private folders.

`prompt` accepts the legacy `attachment`, `attachments` (up to 20, before text),
or `parts` (up to 100 text/file parts, at most 20 files). These are mutually
exclusive. With parts, `text` must be empty. File parts contain ordinary
attachment metadata and a literal `/uploads/<safe-basename>` URL. The server
ignores client filesystem paths and resolves real native
`{type: "file", path, displayName}` attachments itself. New versioned markers
preserve captions and file/text order through native persisted history; chat
event pages carry references, not binary buffers. Legacy markers retain their
old guidance-hiding behavior.
Native attachments make paths available to the agent; attachment acceptance is
not evidence that the model has read the bytes. The agent must explicitly use
its supported native image/file reader before claiming to have inspected them.

Agents [publish existing image originals](native-tool-images.md) through upload,
or reuse a managed URL. Native-image history lookup and automatic tool previews
are retired; they do not get replaced by a wider scan or image cache. Previously
retained native images and their metadata remain available. Repeated display and
download of a managed URL never create another copy. Cockpit does not rewrite
SDK history or promise that deliberately repeated uploads are deduplicated.

File retention does not change the separate lifetimes of browser Blob URLs,
native history, in-flight transfer staging, or the bridge's capped 24-hour
private HTTP diagnostics. Those diagnostics are not a permanent media library.

## Web file navigation

Open the file library from the session-list hamburger menu. The chat composer
keeps its local attachment-upload button, without a second library shortcut.
The library uses the same back/title/refresh header as the management pages.
Search and session scope update the current list; opening a file shows a focused
detail, and its back button restores the previous list when available. Selecting
a target session enables adding a file to its draft, without sending it.

## Weixin protocol boundary

The bridge uses native media messages, not download links disguised as delivery.
The verified Tencent 2.4.8 builders use upload `media_type` **1/2/3** for
image/video/file, but outgoing item `type` **2/5/4**, respectively. AES-128-ECB
uses PKCS#7 padding; the outgoing media key is base64 of its hexadecimal text.
Outgoing image `mid_size` and video `video_size` are ciphertext lengths; file `len` is
the plaintext length as decimal text. The published uploader uses
`no_need_thumb: true`; its actual video builder does not require duration probing
or a paid thumbnail/transcoding service.

Phone-originated video messages can instead report plaintext `video_size`, as
observed with a 6231-byte original in a 6240-byte encrypted response. Inbound
validation requires an exact match to measured plaintext or ciphertext length,
while retaining HTTP length, padding, and available MD5 checks. Phone JPEGs can
contain data after their EOI marker; those bytes remain part of the retained
original. "Original" means the bytes delivered by Weixin, not the phone's
pre-compression source.

These facts come from the pinned
[Tencent upload implementation](https://github.com/Tencent/openclaw-weixin/blob/70ab695f6a1ca87da4102f857a452e2acb6b37cf/src/cdn/upload.ts)
and [native send builders](https://github.com/Tencent/openclaw-weixin/blob/70ab695f6a1ca87da4102f857a452e2acb6b37cf/src/messaging/send.ts).
The upstream client's 100 MiB media-store setting is **not** evidence of a
Tencent server maximum. Cockpit keeps its explicit 25 MiB original-file cap;
the bridge's supported image formats and additional image limit are documented
in its own capability matrix. A server acceptance receipt is not proof that a
phone displayed or played the media. Live acceptance must be distinguished from
user-confirmed phone display.
