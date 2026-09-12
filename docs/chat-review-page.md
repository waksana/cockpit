# Protected static Chat review

Entry: **`/review/chat-v4/`** on the existing Cockpit host. It is a static review
package, not a second Cockpit runtime or a production UI upgrade.
All production components and their styles are imported from exactly
`9eaf3481c3d5a9487ce3779adbb49dfc5a288232`, the explicitly chosen deployed UI.
Later source changes are deliberately excluded.

## User entry and scenes

The top selector and direct links expose all **22** existing source scenes
(the original 21 plus the explicit user-timestamp scene). Reset restores the
selected scene and a fresh memory-only draft, releases held results and closes
local disclosures. It never resets a real session.

| Link query | Coverage and operations |
| --- | --- |
| `?scene=all` | Full synthetic transcript: user/assistant/system/skill records, dates, external user timestamps, Markdown, tools, child agents and files. Scroll to inspect all records. |
| `?scene=reading` / `user-time` | H1–H6, text, emphasis, links, quote, nested lists, tasks, tables, code/diff/long lines, message and code copy; short/long/file/image user timestamps. |
| `?scene=process` | Tool pending/running/completed/failed/unknown, argument/output expansion; thinking disclosure; all six recorded child states, nested content, child errors and empty child history. |
| `?scene=attachments` | Image/video/document/unknown/invalid address; metadata pending/error/retry; repeated and ordered parts, relative image and blocked external image. File links stay in the review path; video uses the production FileCard and native player. |
| `?scene=streaming` / `cancelling` | Append an incremental text step or a new message; stop, queue removal, interrupt and pending cancellation. Observe reading position and the new-message entry. |
| `?scene=ask` / `choice-only` / `freeform` | Choice cards, freeform response and restricted send; fixture callbacks only. Retained files are not sent as an ask response. |
| `?scene=plan` / `elicitation` | Summary/full plan, all offered actions, new-instruction branch; accept/decline/cancel. No native operation occurs. |
| `?scene=empty` / `loading` / `history` | Empty state, initial measurement/loading, controlled older-page prepend and scroll anchor. Use “插入历史 / 完成加载” to finish a held initial load. |
| `?scene=history-error` / `stale` / `error` | Explicit retry controls, partial fragments, missing ownership boundary and session failure. No real history reads. |
| `?scene=compacting` / `auto-compacting` / `unloaded` / `readonly` | Existing disabled/available composer differences and retained read-only source branches. No lifecycle operation is invoked. |

“模拟失败” affects send/answer/interrupt/upload fixtures.
“保持请求中” keeps a fixture action pending until “释放结果”.
File selection, paste and drop exercise the actual Composer handlers, but the
selected bytes are not uploaded: only a synthetic sample attachment is returned.
Voice is an explicit local SpeechRecognition fixture; use “模拟转写” and
“语音错误”, without microphone capture or external speech services.

Topbar/menu components are real. Session-management entries only report their
fixture callback; module management, runtime mutation and deletion are not
reimplemented as imaginary product flows.

## Isolation boundary

No App/ConnectedThread/native store initializer is mounted. Build-only aliases
substitute only the required display store, draft registry and URL/transport
helpers, never the production component implementations or their style sheets.

- The store contains only connection/display inputs, an empty provenance-session
  list and fixture file/voice functions. It has no native client or session API.
- Drafts use the production SessionDraft class with a memory-only registry.
  Formal localStorage keys are not read or written. Closing/refreshing the review
  loses these sample drafts and does not affect the real Chat draft.
- Original file validation and preview classification remain. Only presentation
  URLs are mapped from synthetic `/uploads/lab-*` identities into the static
  review's `media/` directory. File detail links return to this review, not `/files`.
- Native transport config throws explicitly. CSP also sets `connect-src 'none'`,
  `worker-src 'none'`, and `form-action 'none'`. Permissions Policy disables
  microphone/camera/geolocation. No service worker is built or registered.
- Public HTML, JavaScript, fonts and media all use the same existing Passkey
  `auth_request` gate. POST is denied and unknown static files fail, with no
  application/API fallback.

The existing production service worker has no fetch/offline route, so the
review does not need to replace, unregister or clear it. The static package
contains only original synthetic media; no private screenshot or transcript is
copied into source, the web root or CI artifacts.

## Reproducible build and hosting

```sh
REVIEW_SOURCE_ROOT=/absolute/clean-checkout-at-9eaf348 \
  node scripts/build-chat-review.mjs
CHAT_REVIEW_DIST=apps/web/dist-review node --test scripts/chat-review.test.mjs
```

The build rejects another source HEAD or modified tracked source. It type-checks
against the existing toolchain, uses Vite without the PWA plugin and emits
`apps/web/dist-review/` plus a byte/hash inventory in `review-build.json`.
That output is not part of the normal application build.

Nginx templates under `apps/web/review/` mount the immutable static package at
`/srv/cockpit-review/chat-v4/current/` and retain the existing public Passkey gate.
The existing host owns file serving; no Vite, Node server, new Copilot runtime or
owner-attached background process is required after delivery.
The optional **loopback-only** `127.0.0.1:47836` location serves the same bytes
for local browser review, as explicitly approved by the user. It is not a public
authentication exception. Keep its listener bound to loopback.

Publication is limited to this static path and a graceful Nginx config reload,
not the production app's release pointer or service restart. Preserve the
existing config and compare it before adding the include. Anonymous requests
to the HTTPS path and its assets must redirect to the original Passkey login.

## Evidence limits

Desktop/narrow Chrome rendering and clicks from the local Nginx entry, plus the
public HTTPS gate redirect, can be observed without adding test Passkeys.
The user explicitly selected that local-browser review route.
This does not claim an authenticated real-iPhone visit or hardware keyboard,
microphone, SDK, notification or WebKit permission acceptance.
The user can open the protected HTTPS link on their existing signed-in phone.
Deployment does not silently upgrade the chosen component baseline.
