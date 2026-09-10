# Publishing image originals

Chat displays images the agent **explicitly publishes**, not internal tool
screenshots. To publish, upload an existing local original with
`cockpit_upload_file`, or select an existing managed file with `files/list` and
`files/get`. Include its returned `/uploads/...` Markdown only after publication
succeeds. Reuse that URL: displaying or downloading it again never creates
another stored copy. Deliberately uploading the same local file again is a new
upload, not a globally pixel-deduplicated operation.

The original-producing tool should save its image to an approved local artifact
path when publication is required. If a tool provides only an internal native
binary image and no local original, Cockpit does not recover it by scanning chat.
`session/tool-image` and `files/from-tool-image` are retired and return
`410 NATIVE_IMAGE_LOOKUP_RETIRED`.

## Why native image lookup was retired

SDK 1.0.13 / runtime 1.0.83 has no direct getter by native image/event ID.
Its first backward page has no stable request cursor; messages arriving before
the later image request can move that image outside the selected range.
The user chose existing local originals/managed files instead of even a bounded
64-event search. No image cache, speculative collection, cursor fabrication or
arbitrary chat-authored filesystem lookup replaces that API.

Native JSON-RPC may still include whole-event base64 when reading chat events.
The request adapter removes these binary results without caching or publishing
them. This is not source-side field projection or zero-copy streaming.

Existing uploads, including previously retained native images with legacy
`source:"tool-image"` metadata, remain available and independently long-lived.
Their links, session associations, originals and Weixin delivery are preserved.
Files retain their original format and the existing authenticated `/uploads`
boundary. Managed SVG preview does not insert executable document markup.
