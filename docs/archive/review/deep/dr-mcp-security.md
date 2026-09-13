# Deep: MCP tool security

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../README.md) · [归档边界](../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/deep/dr-mcp-security.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


Scope: `apps/mcp/` tool surface — `tools/files.ts` (upload + list_dir), `shared.ts`,
`tools/lifecycle.ts` + `index.ts` (destructive tools + `confirm` gating),
`tools/hooks.ts` (flow/gate authoring), `store.ts`/`config.ts`. Delegated guards
verified in `apps/server/src/{index,uploads}.ts`, `packages/core/src/{flows,engine}.ts`,
`packages/protocol/src/index.ts`. Read-only inspection; one throwaway `/tmp` regex
harness (deleted). No source edited; no sensitive file exfiltrated; nothing written
outside `~/.copilot/flows`.

## Verdict summary

The first pass's High (upload exfiltration) is **CONFIRMED** on the read side —
`cockpit_upload_file` reads any host-readable path with zero confinement and mints a
web-reachable `/uploads/<rand>` URL — but its size-cap concern is **REFINED**: the
25 MB cap *is* authoritatively enforced server-side (`bodyLimit`), so an oversized
file cannot be *published*; the only residual is MCP-process memory. Two of the
first pass's framings need correction: the `confirm` gate is actually **consistent**
at the tool layer (it gates exactly the three irreversible ops), and the
path-traversal guard is **not** "single-sided" the way `confirm` is — it lives at the
server convergence point and so survives the loopback fallback, whereas `confirm`
does not. The basename guard is **airtight** against every traversal class tried
(including the classic `\n` bypass). The genuinely under-reported risk is a new one:
a flow's `gate.script` is an **unconfined arbitrary-executable spawn** primitive that
the well-guarded `write_gate` path masks.

---

## Verified findings

### F1 — Upload reads any host path → web-reachable URL: **CONFIRMED** (read side has zero confinement)

`cockpit_upload_file` does a bare `readFile(path)` on a caller-supplied absolute
path, then POSTs the bytes to `/upload`, which persists them and returns a
`/uploads/<storedName>` URL.

`apps/mcp/src/tools/files.ts:54-70`:
```ts
async ({ path, mime, response_format }): Promise<ToolResult> => {
  let buf: Buffer;
  try {
    buf = await readFile(path);          // ← any host-readable path, no allowlist
  } catch (e) { return fail(`Cannot read ${path}: ...`); }
  if (buf.length === 0) return fail(...);
  const name = basename(path);
  ...
  const url = `${COCKPIT_URL}/upload?name=...&mime=...`;
  const res = await fetch(url, { method: 'POST', ..., body: new Uint8Array(buf) });
```

There is no allowlist, no project-root confinement, no `realpath` check, and
`readFile` follows symlinks. The input schema is `path: z.string().min(1)` with the
only constraint being "Absolute path of the local file to upload"
(`files.ts:48`). The server side writes the buffer verbatim and returns the URL
(`apps/server/src/uploads.ts:42-56`, `apps/server/src/index.ts:112-120`).

**Mitigations (real, but partial):** single-user host; `/uploads` sits behind nginx
cookie auth; the agent already has `bash` so this is not a *new read* capability.
**What is new:** a one-call path from on-disk secret → externally fetchable URL,
turning "can call the MCP" into "can copy a host secret to a web-served location."
See the trace section below for the concrete sequence.

**Fix (proportionate):** keep the capability, but (a) add the exfiltration note to the
tool description so an orchestrator understands the consequence, and (b) before
buffering, `stat` + `lstat` the path and refuse symlinks / oversized files
(see F2 / N2). A hard allowlist would break legitimate "upload a report from /tmp"
flows, so prefer a *soft* posture: refuse only the obvious secret shapes
(`*/.ssh/*`, `*/session-store.db`, `*/cockpit-prefs.json`) with an overridable
`allow_sensitive:true`. `files.ts:57`, before `readFile`.

### F2 — "25 MB cap not enforced": **REFINED** — it *is* enforced at the authoritative boundary

The first-pass wording ("the documented ~25 MB cap is NOT actually enforced on the
MCP side … ensure the server `/upload` side enforces the size cap independently")
implies the publish boundary may be uncapped. It is not.

`apps/server/src/index.ts:24,29,112`:
```ts
const UPLOAD_BODY_LIMIT = 25 * 1024 * 1024; // 25MB
app.addContentTypeParser('application/octet-stream',
  { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT }, ...);
...
app.post('/upload', { bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => { ... });
```

Fastify aborts the body read and returns 413 once the body exceeds 25 MB, both on
the octet-stream parser and on the route — so an oversized file **cannot be
published**. The accurate residual: the MCP `readFile(path)` buffers the *entire*
file into memory **before** the POST (`files.ts:57`), so a multi-GB `path` can OOM
the **MCP process itself** (a self-DoS), even though the server would have rejected
the publish. That is a robustness bug, not an exfiltration or a server-OOM.

**Fix:** `stat` the file first and refuse `size > UPLOAD_BODY_LIMIT` before
`readFile` (`files.ts:56`), and/or stream the upload instead of buffering. This is
the *only* remaining value in the first pass's size recommendation — the server cap
already holds.

### F3 — `confirm` gating "single-sided / inconsistent": **REFINED** (consistent at the tool layer) + **CONFIRMED** (loopback-bypassable)

Two distinct claims; they resolve differently.

**"Inconsistent" → REFUTED at the tool layer.** Exactly three tools gate on
`confirm`, and they are exactly the three **irreversible** operations:
`cockpit_purge_session` (`index.ts:283`), `cockpit_compact_session`
(`settings.ts:83`), `cockpit_rewind_session` (`settings.ts:115`). Every other
mutating tool is either reversible or low-stakes and is intentionally ungated —
most notably `cockpit_delete_session`, which is a *soft* delete to trash
(reversible by `cockpit_restore_session`), so it carries `destructiveHint:true` but
no `confirm` *by design* (`lifecycle.ts:50-58`). The mapping confirm ⇔ irreversible
is clean, not arbitrary.

**"Single-sided" → CONFIRMED, and this is the real point.** The `confirm` check lives
*only* in the MCP wrapper; the underlying intents carry no `confirm` field:
- `session/purge` body = `{ sessionId }` (`protocol:803-806`)
- `session/compact` body = `{ sessionId, customInstructions? }` (`protocol:624-626`)
- `session/rewind` body = `{ sessionId, toMsgId, rollbackFiles? }` (`protocol:628-631`)

So any caller hitting the documented loopback fallback
(`POST /intent/session/purge {sessionId}`) destroys the session with no gate.
`confirm` is an agent-facing UX latch, not a server control — correct framing, and
worth stating in the tool docs so no orchestrator over-trusts it.

**Fix (cheap, optional):** mirror a `force`/`confirm` requirement on the three
intents in `protocol` + their engine handlers, so the latch survives the loopback
path. If declined as over-engineering for a single-user console, at minimum add one
sentence to each tool description ("`confirm` is enforced here, not by the server;
the raw intent has no gate").

### F4 — Flow-id / gate-name path-traversal guard: **CONFIRMED airtight**, and **NOT** single-sided like `confirm`

The guard is `isSafeBasename` (`packages/core/src/flows.ts:20-22`):
```ts
export function isSafeBasename(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}
```
It is invoked by `FlowRegistry.write` (`flows.ts:166`), `remove` (`flows.ts:180`),
and `writeGate` (`flows.ts:192`), which the engine calls from the `flow/add`,
`flow/remove`, `flow/write-gate` intent handlers (`engine.ts:1453,1461,1469`).

**Bypass-class analysis** (verified empirically with a throwaway harness replicating
the exact regex; all rejected):

| Class | Input | Result | Why |
|---|---|---|---|
| Parent traversal | `..`, `../etc/passwd` | reject | leading `.` fails `^[A-Za-z0-9]`; `..` substring check |
| Embedded traversal | `a..b` | reject | `!name.includes('..')` |
| Absolute path | `/etc/passwd` | reject | leading `/` not allowed |
| Separator | `a/b`, `a\b` | reject | `/`,`\` outside charset |
| Leading dot (dotfile) | `.bashrc`, `.` | reject | first char must be alnum |
| URL-encoded | `%2e%2e%2fetc` | reject | `%` outside charset |
| NUL byte | `foo\u0000.json` | reject | NUL outside charset |
| **Trailing-newline** | `good\n/etc/passwd` | reject | JS `$` (no `m` flag) does **not** match before a trailing `\n`; `/` and `\n` outside charset anyway |

The trailing-newline case is the classic anchored-regex bypass and it is correctly
closed because the regex is `^…$` without the `m` flag. **Airtight for filesystem
traversal.** (It does not reject Windows reserved names or cap length — irrelevant on
this single-user Linux host.)

**Critical correction to the first pass:** it grouped this guard with `confirm` as
"each protection is single-sided … bypassed via the loopback path." That is wrong for
the path guard. `isSafeBasename` runs in `packages/core` (the engine), which is the
**single convergence point** — the loopback fallback *also* goes through the engine
intent handlers, so it cannot bypass the basename check. Only `confirm` (F3) lives
exclusively in the MCP wrapper and is loopback-bypassable. The two are asymmetric;
the path guard needs no defense-in-depth on the MCP side.

### F5 — Gate script execution privileges: **CONFIRMED** runs as the operator, fail-safe

A written gate is `chmod 0o755` (`flows.ts:197`) and later spawned directly:
`spawn(script, [], { env: { ...process.env, COCKPIT_EVENT: ... } })`
(`flows.ts:78-81`), invoked from `runFlow` as
`runGate(flow.gate.script, ctx, flow.gate.timeoutMs)` (`engine.ts:1498`). It runs with
the cockpit-server user's full authority and inherited environment. Exit 0 = go;
non-zero / spawn-error / timeout = **skip** (fail-safe, `flows.ts:96-99,89-92`) so a
broken gate never *runs* the action. No `shell:true`, so the `script` path is not
itself shell-interpolated. This matches the documented single-operator trust model —
but see N1: the *path* it spawns is not confined the way the *write* is.

---

## Upload exfiltration path (arg → `/uploads` URL) + size-cap verdict

**Concrete sequence (on paper — not executed):**

1. Agent calls `cockpit_upload_file({ path: "/home/honglai/.ssh/id_rsa" })`.
2. `files.ts:57` `readFile("/home/honglai/.ssh/id_rsa")` → full key buffered (no
   confinement, follows symlinks). `name = basename(path) = "id_rsa"`,
   `resolvedMime = "application/octet-stream"` (no extension → default, `files.ts:63`).
3. `files.ts:66` `POST http://127.0.0.1:8771/upload?name=id_rsa&mime=application%2Foctet-stream`
   with the raw bytes (≤ 25 MB or the server 413s — F2).
4. `apps/server/src/uploads.ts:42-56` `saveUpload` writes the bytes to
   `~/.copilot/cockpit-uploads/<ts>-<6-byte-rand>` and returns
   `url: "/uploads/<ts>-<rand>"`.
5. Tool returns that URL to the caller (and embeds it in a `<cockpit-attachment>`
   marker, `files.ts:76-78`).
6. Anyone holding the nginx auth cookie fetches
   `https://<host>/uploads/<ts>-<rand>` → the private key, served through
   `app.get('/uploads/:name', …)` (`apps/server/src/index.ts:128-137`).

**Confinement present on the read side:** none. **On the publish side:** the 25 MB
`bodyLimit` (F2) and a randomized 48-bit stored name (not brute-forceable). **On the
serve side:** path-traversal-guarded (`resolveUpload`, `uploads.ts:61-70`),
`X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox`
(`index.ts:133-134`) — so stored-XSS is neutralized (N3), but **content exfiltration
is unaffected by those headers**.

**Size-cap verdict:** *enforced* at the authoritative boundary (server `bodyLimit`);
*not* pre-checked on the MCP side, leaving only an MCP-process memory risk (F2). The
first pass's "not enforced … ensure the server enforces independently" is **outdated**
— the server already does.

---

## Destructive-tool confirm-gating inventory

Mutating/destructive tools across the whole MCP surface (read-only tools omitted):

| Tool | File:line | Reversible? | `confirm`? | Consistent? |
|---|---|---|---|---|
| `cockpit_purge_session` | `index.ts:264-296` | **No** (real SDK delete) | **yes** | ✅ gated (irreversible) |
| `cockpit_compact_session` | `settings.ts:66-94` | **No** (rewrites history) | **yes** | ✅ gated (irreversible) |
| `cockpit_rewind_session` | `settings.ts:96-127` | **No** (discards history) | **yes** | ✅ gated (irreversible) |
| `cockpit_delete_session` | `lifecycle.ts:36-63` | Yes (→ trash) | no | ✅ ungated (reversible) |
| `cockpit_restore_session` | `index.ts:242-262` | Yes | no | ✅ |
| `cockpit_rename_session` | `index.ts:299-320` | Yes | no | ✅ |
| `cockpit_set_session_mcp/skill/pin` | `index.ts:358,421,452` | Yes (toggle) | no | ✅ |
| `cockpit_set_model/set_mode` | `settings.ts:11,43` | Yes | no | ✅ |
| `cockpit_refresh_skills` | `index.ts:485` | Yes (may self-restart when idle) | no | ⚠ low-stakes |
| `cockpit_schedule_add` / `stop_schedule` | `index.ts:515,598` | Yes | no | ✅ |
| `cockpit_send_prompt` / `cancel_turn` / `remove_queued` | `conversation.ts` | Yes | no | ✅ |
| `cockpit_respond_*` / `plan_supersede` | `respond.ts` | n/a (drives turn) | no | ✅ |
| `cockpit_new_session` / `unload` / `reload` | `lifecycle.ts:9,65,87` | Yes | no | ✅ |
| `cockpit_hook_add` / `hook_stop` | `hooks.ts:14,115` | Yes | no | ✅ |
| `cockpit_flow_add` | `hooks.ts:212` | Yes (overwrites file) | no | ⚠ see N1/N5 |
| **`cockpit_flow_write_gate`** | `hooks.ts:278` | Yes (writes **executable**) | **no** | ⚠ **N5** |
| **`cockpit_flow_run`** | `hooks.ts:173` | n/a (**executes** a script) | **no** | ⚠ **N5** |
| `cockpit_flow_remove` | `hooks.ts:307` | Yes (deletes file) | no | ✅ |
| `cockpit_flow_schedule_add` / `stop` | `hooks.ts:331,…` | Yes | no | ✅ |
| `cockpit_set_global_mcp_default` / `refresh_mcp` / `reload_session_mcp` | `global.ts` | Yes | no | ✅ |

**Conclusion:** `confirm` is applied **consistently** — exclusively to the three
irreversible-destruction tools — *at the tool layer*. The only gating *oddity* is by
consequence, not by category: `flow_write_gate` (writes an executable) + `flow_run`
(executes it as the operator) are ungated, yet are arguably as consequential as the
gated `rewind` (N5). And the gate that exists is loopback-bypassable (F3).

---

## Basename / path-traversal guard analysis

Tried classes and the exact breaking input (none broke it): see F4 table. The regex
`^[A-Za-z0-9][A-Za-z0-9._-]*$` + `!includes('..')`, anchored without the `m` flag,
rejects parent-traversal, absolute paths, both separator kinds, leading dots
(dotfiles), embedded `..`, URL-encoding, NUL bytes, and the trailing-newline anchor
bypass. **Airtight** for confining flow ids and gate-script *names* to
`~/.copilot/flows/`. It lives server-side, so the loopback fallback inherits it (F4).

The one caveat is *not* a name-traversal hole: a flow's `gate.script` *path* (as
opposed to a `write_gate` *name*) is unconfined — see N1.

---

## New findings

### N1 — `gate.script` is an unconfined arbitrary-executable-spawn primitive (the write-guard masks it) — **Medium**

`write_gate` carefully confines its *write* to the flows dir via `isSafeBasename`
(`flows.ts:192-197`), creating the impression that gate scripts are contained. But the
flow's `gate.script` field is just `z.string()` with **no confinement**
(`protocol:228`), `cockpit_flow_add`'s `gate_script` accepts *any* "Absolute path to a
gate script" (`hooks.ts:242`), and `runFlow` spawns whatever path is stored:
`runGate(flow.gate.script, …)` → `spawn(script, [], …)` (`engine.ts:1498`,
`flows.ts:78`). So an agent can register a flow whose `gate.script` is **any
executable on disk** (e.g. `/usr/bin/curl`, a script in `/tmp`) and `flow_run` will
execute it as the cockpit-server user with the full inherited environment. This is a
code-execution primitive distinct from — and broader than — the guarded write path.
Acceptable under the single-operator/has-bash trust model, but the asymmetry (write is
confined; the executed path is not) is worth closing or documenting.
**Fix:** in `engine.addFlow`/`FlowRegistry.write`, reject a `gate.script` that does
not resolve (`realpath`) under `FLOWS_DIR`, so the executed path matches the confined
write surface. `flows.ts:165-175`.

### N2 — Upload follows symlinks; defeats any future allowlist — **Low**

`readFile(path)` (`files.ts:57`) resolves symlinks, so even if F1's soft allowlist is
added, a symlink *inside* an allowed dir pointing at `~/.ssh/id_rsa` would slip
through. Any confinement must `lstat`/`realpath` and reject symlinks (or canonicalize
before the allowlist check). `files.ts:56`.

### N3 — Upload *serving* is well-hardened (stored-XSS neutralized) — **positive / first pass missed**

The serve path re-derives the content type from the **stored** extension
(`mimeForStored(name)`, `index.ts:135`) — it ignores the caller-supplied `mime`, so an
attacker can't force `text/html` on arbitrary bytes — and sends
`X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox; default-src
'none'; …` (`index.ts:133-134`). A navigated SVG/HTML upload runs script-less. This is
solid and uncredited by the first pass. (It mitigates stored-XSS; it does **not**
mitigate F1's content exfiltration.)

### N4 — Exfiltrated bytes persist past session deletion — **Low**

By design, uploads live in a fixed dir *outside* session-state and "survive session
deletion" (`uploads.ts:1-6`). Consequence for F1: a copied secret's bytes and its
`/uploads/<name>` URL (recorded in chat history) persist indefinitely even after the
originating session is purged — there is no upload GC or `delete` endpoint. Note in
the F1 exfiltration discussion; consider a retention/sweep for the uploads dir.

### N5 — `write_gate` + `flow_run` are ungated despite being executable-write + execute — **Low/Medium**

Per the inventory, the only `confirm`-gated tools are the three history-destroyers,
yet `cockpit_flow_write_gate` writes an `0o755` executable and `cockpit_flow_run`
executes it as the operator (N1). By the project's own "confirm ⇔ high-consequence"
logic, code execution is at least as consequential as `rewind`. Either gate
`flow_run`/`write_gate` behind `confirm`, or (better) accept them as part of the
has-bash trust model and document that flows are an *intended* execution surface.

### N6 — Host-path leakage in error text — **Low** (partial overlap with first pass)

`cockpit_upload_file` echoes the requested absolute path on read failure
(`files.ts:59`, `Cannot read ${path}: …`) and `cockpit_list_dir` returns the resolved
absolute `target`/`parent` (`engine.ts:1246-1247`). Low sensitivity on a single-user
host; noted for completeness (the first pass flagged the store/upload variants only).

### N7 — Upload `fetch` has no timeout/abort — **Low** (confirms first pass)

`files.ts:66` calls `fetch` directly, bypassing the `AbortController`/timeout that
`cockpit.ts:23-33` arms for every intent call. A stalled upload connection hangs the
tool indefinitely. **Fix:** wrap the upload `fetch` in the same
`AbortController`/`REQUEST_TIMEOUT_MS` pattern. `files.ts:65-70`.

---

## Recommended fix order

1. **F1 + N2 (read-side confinement, Medium):** before `readFile`, `lstat` to reject
   symlinks and `stat`-gate size (closes F2's MCP-OOM too); add a soft secret-shape
   refusal with an explicit override, and document the exfiltration consequence in the
   tool description. `files.ts:56-57`.
2. **N1 (gate.script confinement, Medium):** reject a `gate.script` not resolving under
   `FLOWS_DIR` in `FlowRegistry.write`, so the executed path matches the confined write
   surface. `flows.ts:165-175`.
3. **F3 (confirm defense-in-depth, Low):** either mirror a `confirm`/`force` field on
   `session/{purge,compact,rewind}` in `protocol` + handlers, or document that
   `confirm` is an MCP-only latch the loopback bypasses. `protocol:624-631,803-806`.
4. **N7 (upload timeout, Low):** reuse the `AbortController`/timeout for the upload
   `fetch`. `files.ts:65-70`.
5. **N5 / N4 / N6 (documentation + hygiene, Low):** state that flows are an intended
   execution surface (or gate `flow_run`); add an uploads-dir retention note; leave the
   host-path error text as-is unless tightening.

**No change required:** F4 (basename guard — airtight, server-side), N3 (serve-side
hardening — already correct), and the read-only/parameterized `store.ts` (confirmed
clean by the first pass). The cap (F2) is already enforced where it matters.
