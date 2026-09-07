// flows.ts — the Flow layer (TRIGGER → FLOW → ACTION, design §2.10). A Flow is the
// reusable middle layer: an optional cheap gate script (deterministic, no LLM —
// the cost gate that decides whether to spend an agent at all) plus an action
// (spawn a born-configured worker, or prompt an existing session). The same Flow
// can be driven by a hook OR a schedule.
//
// This module owns: loading/validating flow definitions from ~/.copilot/flows/*.json,
// running a gate subprocess, and interpolation. The Engine owns the side effects
// of an action (createSession, toggles, prompt) — see engine.runFlow/spawnSession.

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { Flow, type SessionEventCtx } from '@cockpit/protocol';
import { copilotPath } from './paths.ts';

// A safe single path segment: no separators, no traversal, no leading dot. Used
// to confine flow ids and gate-script names to the flows dir (filesystem safety;
// independent of the gate-script-authoring trust decision).
export function isSafeBasename(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

// Default flows dir. Honors COCKPIT_FLOWS_DIR (matching the MCP-side tooling) and
// otherwise falls back under the COCKPIT_HOME state root.
const FLOWS_DIR = process.env.COCKPIT_FLOWS_DIR ?? copilotPath('flows');
const DEFAULT_GATE_TIMEOUT_MS = 30_000;

// ── Interpolation ────────────────────────────────────────────────────────────
// Substitute {event.field} / {field} (event context) and {gate.key} / {key}
// (gate stdout params) into a template. Unknown non-gate tokens are left intact,
// but an unresolved namespaced gate token is a broken Flow contract: passing it
// into a worker would hide a lost/malformed gate result.
export function interpolateFlow(
  template: string,
  ctx: SessionEventCtx | null,
  params: Record<string, string> = {},
): string {
  const map: Record<string, string> = {};
  if (ctx) {
    map['event'] = ctx.event;
    map['event.event'] = ctx.event;
    map['sessionId'] = ctx.sessionId;
    map['event.sessionId'] = ctx.sessionId;
    map['cwd'] = ctx.cwd;
    map['event.cwd'] = ctx.cwd;
    map['title'] = ctx.title;
    map['event.title'] = ctx.title;
    map['summary'] = ctx.summary ?? '';
    map['event.summary'] = ctx.summary ?? '';
  }
  for (const [k, v] of Object.entries(params)) {
    map[k] = v;
    map[`gate.${k}`] = v;
  }
  const rendered = template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (m, key) => (key in map ? map[key]! : m));
  const missing = [...rendered.matchAll(/\{gate\.([a-zA-Z0-9_.]+)\}/g)].map((m) => m[1]!);
  if (missing.length > 0) {
    throw new Error(`unresolved gate parameter(s): ${[...new Set(missing)].join(', ')}`);
  }
  return rendered;
}

// ── Gate execution ───────────────────────────────────────────────────────────
export interface GateResult {
  go: boolean;                       // exit 0 = go; non-zero / timeout / error = skip
  params: Record<string, string>;    // gate stdout JSON, flattened to strings
  reason?: string;                   // why it skipped (for logging)
  error?: string;                    // malformed stdout: Flow failure, not a gate decline
}

// Run a gate script as a subprocess. The event context is passed BOTH via env
// (COCKPIT_EVENT = JSON) and stdin (JSON), so the script can read either. exit 0
// ⇒ go; any non-zero exit, a spawn error, or a timeout ⇒ skip (fail-safe: never
// spend an agent when the cheap gate is unhappy or hangs). stdout, if valid JSON,
// becomes interpolation params for the downstream action.
//
// SECURITY (F8/F10): the script is an owner-authored LOCAL file referenced by a
// flow JSON in ~/.copilot/flows/. Never a third-party/downloaded script. cockpit
// runs it with the operator's own authority — same trust level as the rest of the
// single-operator console.
// Decide how to launch a gate script across platforms. POSIX can execute a script
// directly via its shebang + exec bit, but Windows has neither concept — a .js/.py
// file is not itself executable. So we route by extension through an interpreter:
//   .js/.mjs/.cjs → the current Node binary (process.execPath) — fully portable, the
//                   recommended gate form (no shebang/exec-bit needed anywhere).
//   .py/.pyw      → python (COCKPIT_PYTHON override, else `python` on Windows / `python3`).
//   anything else → direct spawn (legacy .sh / extension-less gates keep working on
//                   POSIX via their shebang). Exported for tests.
export function gateCommand(script: string): { cmd: string; args: string[] } {
  const ext = extname(script).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { cmd: process.execPath, args: [script] };
  }
  if (ext === '.py' || ext === '.pyw') {
    const py = process.env.COCKPIT_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    return { cmd: py, args: [script] };
  }
  return { cmd: script, args: [] };
}

export function runGate(
  script: string,
  ctx: SessionEventCtx | null,
  timeoutMs: number = DEFAULT_GATE_TIMEOUT_MS,
): Promise<GateResult> {
  return new Promise((resolve) => {
    let child;
    try {
      const { cmd, args } = gateCommand(script);
      child = spawn(cmd, args, {
        env: { ...process.env, COCKPIT_EVENT: JSON.stringify(ctx ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ go: false, params: {}, reason: `gate spawn failed: ${String(e)}` });
      return;
    }
    let out = '';
    let settled = false;
    const done = (r: GateResult): void => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      done({ go: false, params: {}, reason: `gate timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d) => { out += String(d); });
    child.on('error', (e) => { clearTimeout(timer); done({ go: false, params: {}, reason: `gate error: ${String(e)}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { done({ go: false, params: {}, reason: `gate exit ${code}` }); return; }
      const parsed = parseGateParams(out);
      if (parsed.error) {
        done({ go: false, params: {}, error: parsed.error });
        return;
      }
      done({ go: true, params: parsed.params });
    });
    // Hand the event context to the script on stdin too. A gate that never reads
    // stdin closes it first, so writing races with its exit — swallow the EPIPE.
    child.stdin?.on('error', () => { /* gate ignored stdin; harmless */ });
    try { child.stdin?.end(JSON.stringify(ctx ?? {})); } catch { /* ignore */ }
  });
}

// Parse a gate's stdout as a flat string map. Empty stdout is valid because a
// gate may only decide go/skip. Non-empty malformed/non-object stdout is an
// explicit contract failure rather than an indistinguishable empty param set.
function parseGateParams(out: string): { params: Record<string, string>; error?: string } {
  const trimmed = out.trim();
  if (!trimmed) return { params: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { params: {}, error: 'gate stdout must be a JSON object' };
    }
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      flat[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return { params: flat };
  } catch (e) {
    return { params: {}, error: `gate stdout is invalid JSON: ${(e as Error).message}` };
  }
}

// ── FlowRegistry ─────────────────────────────────────────────────────────────
// Loads + validates flow definitions from ~/.copilot/flows/*.json. Reads fresh
// from disk on each call (the dir is tiny and owner-edited), so a flow added/
// edited on disk is picked up without a restart. Invalid files are skipped (and
// reported via the injected logger), never crashing the engine.
export class FlowRegistry {
  private readonly dir: string;
  private readonly log: (msg: string, data?: Record<string, unknown>) => void;

  constructor(dir: string = FLOWS_DIR, log: (msg: string, data?: Record<string, unknown>) => void = () => {}) {
    this.dir = dir;
    this.log = log;
  }

  list(): Flow[] {
    if (!existsSync(this.dir)) return [];
    let files: string[];
    try { files = readdirSync(this.dir).filter((f) => f.endsWith('.json')); }
    catch { return []; }
    const flows: Flow[] = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, f), 'utf-8'));
        const parsed = Flow.safeParse(raw);
        if (parsed.success) flows.push(parsed.data);
        else this.log('flow definition invalid (skipped)', { file: f, error: parsed.error.message });
      } catch (e) {
        this.log('flow file unreadable (skipped)', { file: f, error: String(e) });
      }
    }
    return flows;
  }

  get(id: string): Flow | undefined {
    return this.list().find((fl) => fl.id === id);
  }

  // ── Authoring (maintainer MCP) ───────────────────────────────────────────────
  // Write a flow definition to ~/.copilot/flows/<id>.json. The id must be a safe
  // basename (path-traversal rejected — filesystem safety). Overwrites if present.
  write(flow: Flow): { ok: boolean; error?: string } {
    if (!isSafeBasename(flow.id)) return { ok: false, error: `unsafe flow id: ${flow.id}` };
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${flow.id}.json`), JSON.stringify(flow, null, 2));
      this.log('flow written', { id: flow.id });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Delete a flow definition file. Returns ok=false if the id is unsafe or the
  // file does not exist.
  remove(id: string): { ok: boolean; error?: string } {
    if (!isSafeBasename(id)) return { ok: false, error: `unsafe flow id: ${id}` };
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return { ok: false, error: `no such flow: ${id}` };
    try { rmSync(file); this.log('flow removed', { id }); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  }

  // Write a gate script into the flows dir and return its absolute path, to
  // reference as a flow's gate.script. `name` must be a safe basename so the write
  // is confined to the flows dir. The script body is owner-authored (the owner
  // accepted authoring gate scripts via the maintainer MCP). The recommended,
  // cross-platform gate form is a Node `.js` file (runGate launches it via the Node
  // binary); a `.js`/`.py` gate needs no exec bit. We still chmod +x so legacy POSIX
  // `.sh` gates stay directly executable, but tolerate failure — on Windows the
  // exec bit is meaningless and chmod may be a no-op or unsupported.
  writeGate(name: string, script: string): { ok: boolean; path?: string; error?: string } {
    if (!isSafeBasename(name)) return { ok: false, error: `unsafe gate name: ${name}` };
    const path = join(this.dir, name);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(path, script);
      try { chmodSync(path, 0o755); } catch { /* Windows / non-POSIX: exec bit is irrelevant */ }
      this.log('gate script written', { name });
      return { ok: true, path };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}
