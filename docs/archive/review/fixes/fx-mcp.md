# Fix: MCP tool security hardening (upload read-fence + gate.script confinement)

> **历史归档，不是当前规范或操作指南。** [当前文档](../../../README.md) · [归档边界](../../README.md) · [原位置固定版本](https://github.com/waksana/cockpit/blob/a1f4a9a7c9e72b151958c270c4f790b32b72636e/docs/review/fixes/fx-mcp.md)。
> 结论、行号、旧路径和环境按原记录理解，未为本次文档整理重新执行其操作。


Implements the actionable findings from `docs/review/deep/dr-mcp-security.md`
(first-pass context: `docs/review/06-mcp.md`). Scope was constrained to the two
tool files **`apps/mcp/src/tools/files.ts`** and **`apps/mcp/src/tools/hooks.ts`**;
no other source was touched (see "Constraints / deferred" for what that excludes).

---

## F1 + N2 — Upload reads any host path → web-reachable URL (CONFIRMED, read side unconfined)

### Problem
`cockpit_upload_file` did a bare `readFile(path)` on any caller-supplied absolute
path and POSTed the bytes to `/upload`, which mints a web-reachable
`/uploads/<rand>` URL. With zero confinement (and `readFile` following symlinks),
that is a one-call **host-secret → externally-fetchable-URL** exfiltration
primitive (e.g. `~/.ssh/id_rsa`, `~/.copilot/session-store.db`,
`cockpit-prefs.json`). Per the review the 25 MB cap is already enforced
authoritatively by the server `bodyLimit`, so **no size check was added** here.

### Change — `apps/mcp/src/tools/files.ts`
A stat-then-refuse path fence (`files.ts:18-92`) gates the read:

- `uploadRootCandidates()` (`files.ts:29-45`) — the allowlist: system temp,
  `/tmp`, `/var/tmp`, `~/.copilot/session-state`, `~/.copilot/cockpit-uploads`,
  extendable (additive) via `COCKPIT_UPLOAD_DIRS` (a `:`-separated list). These are
  the conventional agent-artifact locations; the secret-bearing files
  (`session-store.db`, `cockpit-prefs.json`, `~/.ssh/*`) sit *outside* every root
  (they live directly in `~/.copilot/` or `~`, not under the allowed subdirs).
- `canonicalUploadRoots()` (`files.ts:47-57`) — `realpath`-canonicalizes each root
  (lexical fallback when a root doesn't exist) so containment compares like-for-like
  even when a root is itself a symlink (e.g. `/tmp`).
- `resolveUploadPath()` (`files.ts:70-91`, exported) — requires an **absolute**
  path, `realpath`s it (collapsing `..` **and** resolving every symlink — closes
  **N2**), `stat`s the result and refuses anything that is **not a regular file**,
  then refuses any canonical path **outside** the allowlisted roots. Returns the
  canonical path so the handler reads the already-resolved target (no second
  symlink resolution / TOCTOU re-walk).
- Handler wiring (`files.ts:145-155`): fence first, then `readFile(real)`.
- Tool/description hardening: exfiltration + fence note added to the tool
  description (`files.ts:122-130`) and the `path` schema (`files.ts:133-138`).

Refuses: relative paths, traversal that escapes the roots, absolute paths outside
the roots, symlinks that escape the roots, directories/devices. Allows: the
conventional report/chart/screenshot upload flows (temp + session-state).

---

## N1 / N5 — `gate.script` is an unconfined arbitrary-executable-spawn primitive

### Problem
A flow's `gate.script` is spawned verbatim by the engine as the operator (exit
0 = go). `cockpit_flow_write_gate` confines its *writes* to `~/.copilot/flows/` via
a safe-basename guard, but the `gate_script` **path** stored by `cockpit_flow_add`
was a bare `z.string()` that could point at **any executable on disk**
(`/usr/bin/curl`, a `/tmp` script). The confined write masks an unconfined execute.

### Change — `apps/mcp/src/tools/hooks.ts`
Defense-in-depth confinement at the tool layer (`hooks.ts:11-58`):

- `FLOWS_DIR()` (`hooks.ts:28`) — resolves `~/.copilot/flows` (matches core's
  `FlowRegistry` default; overridable via `COCKPIT_FLOWS_DIR` for tests); read at
  call time so it is testable.
- `isSafeBasename()` (`hooks.ts:30-32`) — mirrors core's guard
  (`^[A-Za-z0-9][A-Za-z0-9._-]*$` + no `..`).
- `gateScriptRejection()` (`hooks.ts:35-58`, exported) — requires `gate_script` to
  be a **safe-basename file directly inside the flows dir** (lexical check, so it
  works before the gate is written). If the path already exists, it additionally
  `realpath`s it and re-checks containment, so a symlink planted in the flows dir
  cannot redirect the spawn outside it.
- Handler wiring (`hooks.ts:303-306`): reject before the flow is written.
- `gate_script` schema description updated to state the confinement and that flows
  are an intended (gated) operator-execution surface — **N5** documentation
  (`hooks.ts:288-296`).

This exactly matches the path `cockpit_flow_write_gate` returns, so **no legitimate
flow breaks** — only the "point the gate at an arbitrary executable" abuse is
refused.

> **Recommendation (out of edit scope — authoritative fence belongs in core).**
> The MCP-layer check is bypassable by anyone hitting the raw loopback intent
> (`POST /intent/flow/add`). The durable fix is to reject a `gate.script` that does
> not `realpath`-resolve under `FLOWS_DIR` in **`packages/core/src/flows.ts`**
> (`FlowRegistry.write`, ~`flows.ts:165-175`), so the loopback path inherits it.
> That file was outside this task's allowed edit set, so it is recorded here, not
> changed.

---

## Verification

- `pnpm --filter @cockpit/mcp build` (tsc) → **clean**, before and after.
- `pnpm --filter @cockpit/mcp test` → **20/20 pass** (was 6; +14 new):
  - `src/tools/files.test.ts` (8): allows a regular file under an allowed root;
    refuses relative / non-existent / directory / outside-roots / traversal-escape /
    symlink-escape; honors `COCKPIT_UPLOAD_DIRS`.
  - `src/tools/hooks.test.ts` (6): accepts a safe in-flows-dir path (written or not);
    refuses an outside executable / traversal-escape / unsafe basename /
    symlink-escape.
- **Tests touch only freshly-created `os.tmpdir()` dirs** and read-only
  `stat`/`realpath` of `/etc/passwd` as an "outside" anchor (its contents are never
  read — both fences refuse *before* any read). **No real `~/.copilot` file is
  touched.** The `/etc/passwd`-anchored cases self-skip if that file is absent.

## Constraints / deferred (per task scope — only `files.ts` + `hooks.ts` edited)

- **N1/N5 server-side fence** in `packages/core/src/flows.ts` — recommendation
  above; not editable in this task.
- **F3 `confirm` is loopback-bypassable** (lives only in the MCP wrapper). Mirroring
  a `confirm`/`force` field onto `session/{purge,compact,rewind}` requires editing
  `packages/protocol` + `packages/core` — out of scope; left as a known latch.
- **F2 MCP-process OOM** (a multi-GB `readFile` buffers before the server 413s) —
  the report's only residual size concern; the task explicitly excluded adding a
  size check (server `bodyLimit` is authoritative), so this is left as-is.
- **N7 upload `fetch` has no timeout** and **N4 uploads-dir retention** — hygiene
  items outside the two requested fixes; not changed.
- No `git`, restart, or deploy actions were taken.
