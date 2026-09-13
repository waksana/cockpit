# Deep: Web projection & XSS

*Scope: `apps/web` as a pure projection + client-side safety. Verification pass
over the first-pass report `docs/review/07-web.md`. Review only — no source
edited. Every claim cited file:line with quoted excerpt.*

## Verdict summary

The frontend is a genuinely disciplined pure projection and is **XSS-safe by
construction** (react-markdown v10, no `rehype-raw`, raw HTML downgraded to text,
URL attributes stripped by `defaultUrlTransform` before any custom renderer
runs). Exactly **one** real pure-projection leak exists — the store synthesizes
`lastActivity` from the client clock (`store.ts:294`) — and the server already
computes the authoritative value at `engine.ts:762` but never forwards it, so the
honest fix is server-side. The rename-Enter stale-closure is a real correctness
bug; the first pass's `data:` dead-branch is confirmed; but the first pass's
AttachmentView "off-origin url" finding is **REFUTED** — the fold already enforces
a `/uploads/` same-origin allowlist (`fold.ts:194`).

---

## Verified findings

### 1. PURE-PROJECTION LEAK — `lastActivity` synthesized on the client — **CONFIRMED (and worse than stated: the server already owns the value)**

Client synthesis, `apps/web/src/net/store.ts:294` (the `msg/upsert` reducer):

```ts
// store.ts:282-296
case 'msg/upsert': {
  set((st) => ({
    sessions: st.sessions.map((s) => {
      if (s.sessionId !== ev.sessionId) return s;
      if (!s.materialized) return s;                       // 286 — gate
      const idx = s.messages.findIndex((m) => m.id === ev.message.id);
      ...
      return { ...s, messages, lastActivity: Date.now() };  // 294 — INVENTED
    }),
  }));
```

`lastActivity` is server-owned domain truth — `SessionMeta.lastActivity:
z.number()` (`packages/protocol/src/index.ts:436`). The `msg/upsert` event does
**not** carry it: `z.object({ type: z.literal('msg/upsert'), sessionId,
message })` (`protocol/src/index.ts:550`). So the client fabricates the value from
`Date.now()`.

Crucially, the server **already** maintains the authoritative value but withholds
it from the projection. `packages/core/src/engine.ts:762`:

```ts
if (message) { st.meta.lastActivity = Date.now();
  this.emit({ type: 'msg/upsert', sessionId: st.meta.sessionId, message }); }
```

— it bumps `st.meta.lastActivity` server-side on every folded-message change, but
emits only `msg/upsert` (no `lastActivity`) and deliberately omits it from
operational patches (`engine.ts:1843-1847`: *"`lastActivity` is forwarded ONLY
when a patch sets it, so operational patches … never reorder the list"*). The new
value therefore never reaches clients except on a full `snapshot`
(reconnect) or `session/list` (MCP).

**Why it's wrong — concrete two-device divergence.** The sidebar both *orders* and
*time-stamps* sessions by this value:

```ts
// Sidebar.tsx:109
.sort((a, b) => b.lastActivity - a.lastActivity);
// Sidebar.tsx:68
<span className="dialog-time">{relTime(s.lastActivity)}</span>   // 刚刚 / 5分钟前
```

Scenario: session X is mid-turn (streaming `msg/upsert`s).
- **Device A** has X open → X is `materialized` → reducer reaches line 294 →
  `lastActivity = Date.now()` → X jumps to the top of A's list and reads "刚刚".
- **Device B** is looking at a *different* session → X is **not** materialized on
  B → the reducer returns at line 286 (`if (!s.materialized) return s;`) → X's
  `lastActivity` stays at B's last snapshot value → X keeps its stale position and
  stale relative time.

Two devices now disagree on both sidebar ordering and the timestamp for the same
session, with **no server event to reconcile** — it self-heals only on a full
reconnect snapshot, never at turn end. Even on a *single* device the ordering is
wrong: a background session the server considers freshly-active is never bumped
(materialization gate), so the list reflects "what I have open," not server truth.
This is the exact bug class the pure-projection rule exists to kill.

**Fix (server-side, the honest one).** Forward the server's authoritative value;
delete the client invention.

- Client — `store.ts:294`, drop the synthesized field:
  ```ts
  return { ...s, messages };          // no lastActivity: Date.now()
  ```
- Server — make the value part of the projection. Two equally-correct options:
  - **(preferred, consistent, low-noise)** include `lastActivity` on the
    turn-end `running→idle` patch (and any other genuine-activity patch) so every
    device reorders identically once per turn. The existing `session/patch`
    reducer (`store.ts:228-240`, `{ ...s, ...patch }`) applies it to **all**
    sessions regardless of materialization — *no further client change needed*.
  - **(live reorder, if wanted)** add `lastActivity: z.number().optional()` to the
    `msg/upsert` event schema (`protocol/src/index.ts:550`), have `engine.ts:762`
    set it from `st.meta.lastActivity`, and in the client apply it **without** the
    materialization gate (update the meta field even when `!s.materialized`,
    leaving the messages array untouched).

Do **not** keep deriving it on the client under any option — the value must come
from the one authority so every device agrees.

### 2. Reconnect / history-merge idempotency — **CONFIRMED idempotent & order-stable**

The reconnect resume path is a durable-cursor, id-deduped, append-only merge that
matches the `live == replay` contract.

`maybeMaterialize(force=true)` resumes from the newest held id
(`store.ts:163-166`):
```ts
const resumeFrom = force && s.materialized && s.messages.length > 0
  ? s.messages[s.messages.length - 1]!.id : undefined;
const req = resumeFrom ? { afterMsgId: resumeFrom } : { limit: HISTORY_PAGE };
```

The `append` tail merge (`store.ts:259-262`) is id-deduped:
```ts
if (p.append) {
  const tailIds = new Set(p.messages.map((m) => m.id));
  const kept = s.messages.filter((m) => !tailIds.has(m.id));
  return { ...s, messages: [...kept, ...p.messages], materialized: true, ... };
}
```
Re-feeding the same tail is a no-op: any id in the tail is removed from `kept`
then re-appended in server order. The only message that legitimately reappears is
the cursor itself (the comment notes *"the cursor message may have grown
mid-stream → replace it"*), and it belongs at the tail anyway, so ordering is
preserved. If the cursor is gone (history compacted/rewound while away) the server
answers with `session/reset` instead (`store.ts:272-280`) — covered. The
`latest` and older-`prepend` branches (264-267) likewise dedupe by id.

Live `msg/upsert` is itself idempotent (`store.ts:287-290`): `findIndex` by id →
in-place replace, else append. Feeding the same event twice changes nothing — the
client analog of the server `live == replay` invariant holds.

### 3. MessageBody XSS posture — **CONFIRMED safe; the `data:` allowlist branch is dead (REFINED)**

`apps/web/src/components/MessageBody.tsx` renders with `ReactMarkdown` +
`remarkGfm` only — **no `rehypePlugins`, no `rehype-raw`, no
`dangerouslySetInnerHTML`** (grep over `apps/web/src` for
`dangerouslySetInnerHTML|innerHTML|rehype-raw|insertAdjacentHTML` → **none**).

Verified against the installed lib
(`react-markdown@10.1.0`, `lib/index.js`):
- **Raw HTML is downgraded to text** (no active HTML can be injected):
  ```js
  // index.js:360-365
  if (node.type === 'raw' && parent && typeof index === 'number') {
    if (skipHtml) { parent.children.splice(index, 1) }
    else { parent.children[index] = {type: 'text', value: node.value} }
  ```
  A tool result or message containing `<img src=x onerror=alert(1)>` /
  `<script>…</script>` is rendered as literal text, never parsed as DOM.
- **Every URL attribute is sanitized before custom renderers run.**
  `defaultUrlTransform` (index.js:421-440) returns `''` for any protocol not in
  `safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i` (index.js:124). It runs in the
  tree `transform` (index.js:382, `node.properties[key] =
  urlTransform(...)`) so the custom `a`/`img` components receive the
  already-stripped value. `javascript:`, `vbscript:`, `file:`, and **`data:`** are
  all neutralized to `''`.

**Injection vector: none through markdown.** remark produces only a closed set of
elements (a/img/code/pre/table/…); there is no element/attribute path for script
or event handlers because raw HTML is text. The custom `a` adds
`rel="noopener noreferrer"` (MessageBody.tsx:29) and the custom `img` gates on
an allowlist (MessageBody.tsx:39). Tool args/output render as React-escaped text
in `<pre>` (`Thread.tsx:88-89`), not markdown — also safe.

**Dead branch (REFINED, matches first pass, functional-only).** The allowlist
accepts inline data URIs:
```ts
// MessageBody.tsx:14
if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(src)) return true
```
But because `data:` is not in `safeProtocol`, react-markdown rewrites any
`data:image/...` `src` to `''` *before* this component runs, so `isImgSrcAllowed('')`
returns false (MessageBody.tsx:12) and the image always renders as
`[image blocked]`. The branch is unreachable. Security is unaffected (stricter
than intended). **Fix:** either delete the `data:` branch + comment (lines 7,14)
to stop implying support, or pass a custom `urlTransform` that preserves vetted
`data:image/...;base64,` and strips everything else — only then does the existing
allowlist become the live gate.

### 4a. Rename-dialog Enter stale-closure — **CONFIRMED (real correctness bug)**

`apps/web/src/components/Dialog.tsx`:
```ts
const [value, setValue] = useState(input?.initial ?? '');        // 21
const confirm = () => { if (input && !value.trim()) return; onConfirm(value); };  // 24-27
useEffect(() => {
  ...
  const onKey = (e) => { ... if (e.key === 'Enter' && input) { e.preventDefault(); confirm(); } };  // 31-34
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);                                                          // 38 — empty deps
```
The keydown listener is registered once on mount and captures the **mount-time**
`confirm`, which closes over the **mount-time** `value` (= `input.initial`, the old
title). So pressing **Enter** in the rename dialog calls `onConfirm(input.initial)`
— renaming the session to its existing name (a silent no-op) — while the user
believes their typed name was applied. The confirm **button** uses a fresh
`confirm` (`onClick={confirm}`, line 61) and works; only the Enter path is broken.
This affects the only input-bearing dialog (rename). The sibling `DirPicker.tsx:54`
shows the correct pattern (Enter handled on the input's own `onKeyDown`, where
`value`/`edit` is current).

**Fix:** handle Enter on the input's `onKeyDown` (like DirPicker), or read `value`
through a ref, or add `confirm` to the effect deps. Patch sketch (Dialog.tsx:46-53):
```tsx
<input ... onChange={(e) => setValue(e.target.value)}
       onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } }} />
```
and drop the `Enter` case from the window-level `onKey` (keep Escape there).

### 4b. AttachmentView "off-origin url" — **REFUTED (already constrained at the fold)**

The first pass flagged `Thread.tsx:51` `const href = \`${BASE_URL}${att.url}\``
as trusting an agent-emitted `att.url`, with the durable fix "validate at the
fold." That fix **already exists**. `packages/core/src/fold.ts:187-194`:
```ts
function attachmentFromAttrs(attrs: string): Attachment | null {
  ...
  const url = get('url');
  if (!url || !url.startsWith('/uploads/')) return null;   // 194 — same-origin allowlist
```
with the explicit rationale (fold.ts:184-186): *"the url MUST be a cockpit
/uploads/ path … we reject anything else so a marker (user- or agent-authored)
can't point the browser at an arbitrary/cross-origin URL."* This is regression-
tested: `fold.test.ts:332` *"attachment marker with a non-/uploads/ url is rejected
(no cross-origin/arbitrary URL)"*, feeding `url="https%3A%2F%2Fevil.com…"` and
asserting `attachment === undefined`. So every `att.url` reaching `AttachmentView`
is guaranteed to be a `/uploads/...` same-origin path; a `//evil.com/x` or
`https://…` marker yields no attachment at all. The off-origin hotlink/leak vector
the first pass described is not reachable.

*Residual (informational, not a bug):* `startsWith('/uploads/')` is a prefix test,
not a normalized-path check, so `"/uploads/../x"` passes — but it normalizes to a
**same-origin** path (no cross-origin escape) and the `/uploads/:name` server route
is independently path-traversal-guarded. No action required; if defense-in-depth is
desired, normalize/reject `..` in `attachmentFromAttrs`.

---

## Pure-projection violations (the complete list)

| Client-derived domain value | Location | Verdict | Server-side fix |
|---|---|---|---|
| `lastActivity` = `Date.now()` on `msg/upsert` | `store.ts:294` | **CONFIRMED leak** | Forward `engine.ts:762`'s authoritative `st.meta.lastActivity` (on the turn-end patch, or as a field on `msg/upsert`); drop the client `Date.now()`. See finding 1. |
| `lastActivity: Date.now()` in `openPreview` stub | `store.ts:470` | **benign** | Local-only synthetic preview kept **out** of `sessions` (never sorted/timestamped in the sidebar); scratch for the trash preview. No fix needed. |
| `relTime(...)` / schedule countdown read `Date.now()` | `Sidebar.tsx:30`, `SessionInfoPanel.tsx:182,196` | **not a violation** | Legitimate *display* derivation from a server-provided absolute timestamp + the current clock (like any "5m ago"). Keep. |

No other client-held domain truth found. Deletes wait for `session/removed`
(store.ts:226), pin/model/mode are fire-and-forget with the value arriving back
via `session/patch`, and the unread/badge signal derives purely from server
`attention`/`attnId`/`seenId` with no per-device flag — all correct.

---

## XSS posture (exact render path + sanitizer)

```
ChatMessage.content / .thought / subagent.prompt
   └─> <MessageBody body={...}>                        (MessageBody.tsx:22)
         └─> <ReactMarkdown remarkPlugins={[remarkGfm]} components={{a,img,table}}>
               • raw HTML node  → TEXT  (react-markdown lib/index.js:363)   ← no rehype-raw
               • href/src attrs → defaultUrlTransform (lib/index.js:382,421)
                                  strips any non-(https?|ircs?|mailto|xmpp): → ''
               • a:   rel="noopener noreferrer", target=_blank  (MessageBody.tsx:29)
               • img: allowlist (/, ./, ../ ; data:image base64) else click-through link (39-52)

ToolCall.args / .output  └─> <pre>{...}</pre>   (Thread.tsx:88-89)  ← React-escaped text, not markdown
```

**Sanitizer:** react-markdown v10's built-in raw-HTML-to-text + `defaultUrlTransform`
(no third-party sanitizer like DOMPurify is needed *because* raw HTML never becomes
DOM). Config is sound: GFM only, no `rehype-raw`, no `skipHtml`-bypass, no
`dangerouslySetInnerHTML` anywhere in `apps/web/src`. **No injection vector** for a
crafted tool result or message. The only correction is cosmetic — the dead
`data:image` allowlist branch (finding 3).

---

## New findings (not in the first pass)

1. **The `lastActivity` value is already computed server-side** (`engine.ts:762`)
   but withheld from the projection. The first pass framed the fix as a possible
   protocol/engine *addition*; in fact the engine *already owns* the truth and only
   needs to *forward* it. This makes the fix smaller and removes any ambiguity about
   "should the list reorder live" — the server already decided it should (it bumps
   the field), it just isn't telling the clients. (Strengthens finding 1.)

2. **The `msg/upsert` materialization gate makes the leak cross-device-asymmetric,
   not merely client-derived** (`store.ts:286`). Because only the *viewing* device
   materializes the session, the synthesized bump happens on exactly one device —
   guaranteeing divergence rather than just imprecision. Any server-side fix must
   apply the value through the `session/patch` path (which is materialization-
   agnostic), not only through `msg/upsert` (which is gated). (Refines the fix.)

3. **AttachmentView off-origin is a first-pass false positive.** The durable
   `/uploads/` allowlist the first pass *recommended* is already implemented and
   tested at `fold.ts:194` / `fold.test.ts:332`. Worth correcting so the finding
   isn't re-opened. (Downgrades first pass Low #4.)

4. **List keys are all stable and correct** — `key={m.id}` (Thread.tsx:440),
   `key={tc.toolCallId}` (244), `key={sm.id}` (181), `key={s.name}` (Manage.tsx:92,
   117). No unkeyed/index-keyed lists. (Confirms no adjacent reconciliation bug —
   an area the brief asked to probe.)

5. **Optimistic toggle in MCP/Skills panels** (`Manage.tsx:84,109`) re-confirmed:
   `setRows(...{ ...x, enabled })` before the server resolves, reconciled by
   `.then(load).catch(load)`. It contradicts the "no optimistic insert" doctrine but
   is bounded panel state (not the SSE store) and self-corrects on both paths.
   Low severity; same recommendation as first pass (render a per-row pending state,
   let `load()` be the source of truth).

6. **Test coverage is genuinely zero** — `apps/web/package.json` exposes only
   `dev/build/typecheck/lint`; no `*.test.*`/`*.spec.*` under `apps/web/src`. The
   store reducer (`onEvent`) — the highest-risk logic and the thing that guards the
   bugs cockpit exists to prevent — is untested. A vitest suite feeding the same
   event stream twice (asserting the client `live == replay` idempotency) and the
   reconnect-merge invariants would be cheap and high-value.

---

## Recommended fix order

1. **`lastActivity` projection leak (Medium → do first).** Drop
   `lastActivity: Date.now()` at `store.ts:294`; forward the server's authoritative
   `st.meta.lastActivity` via the turn-end `session/patch` (no further client change
   needed) or as an optional `msg/upsert` field applied ungated. Fixes a real
   multi-device divergence in sidebar order + relative time.
2. **Rename-dialog Enter stale-closure (Medium correctness).** Move Enter handling
   to the input's `onKeyDown` (`Dialog.tsx`, mirror `DirPicker.tsx:54`). Without it,
   Enter silently renames to the old title.
3. **MCP/Skills optimistic toggle (Low).** Replace optimistic `setRows` with a
   per-row pending state; let `load()` reconcile (`Manage.tsx:84,109`).
4. **Dead `data:image` branch (Low, cosmetic).** Either remove the branch+comment
   (`MessageBody.tsx:7,14`) or add a `urlTransform` that actually preserves vetted
   `data:image/...;base64,` so the allowlist becomes the live gate.
5. **Add a store-reducer test suite (process).** Idempotency (feed-twice) +
   reconnect-merge invariants in vitest.
6. **No action:** AttachmentView url trust (already enforced at the fold);
   `relTime`/schedule `Date.now()` reads (legitimate display derivation);
   `openPreview` stub `lastActivity` (local-only scratch).
