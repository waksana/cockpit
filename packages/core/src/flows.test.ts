// Unit tests for flows.ts — interpolation, gate subprocess execution, and the
// FlowRegistry loader/validator. Pure-ish; the gate tests spawn tiny Node
// scripts written to a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interpolateFlow, runGate, gateCommand, FlowRegistry, isSafeBasename } from './flows.ts';
import type { SessionEventCtx, Flow } from '@cockpit/protocol';

const ctx: SessionEventCtx = {
  event: 'session.first-turn-complete',
  sessionId: 'src-1',
  cwd: '/home/honglai/projX',
  title: 'projX',
};

// ── interpolateFlow ──────────────────────────────────────────────────────────
test('interpolateFlow fills event ctx and gate params, leaves unknown intact', () => {
  assert.equal(
    interpolateFlow('welcome {event.sessionId} ({cwd}) variant={gate.variant} bare={variant} ?={nope}', ctx, { variant: 'FAST' }),
    'welcome src-1 (/home/honglai/projX) variant=FAST bare=FAST ?={nope}',
  );
});

test('interpolateFlow tolerates a null ctx (manual run)', () => {
  assert.equal(interpolateFlow('x={key}', null, { key: 'v' }), 'x=v');
});

test('interpolateFlow rejects an unresolved namespaced gate parameter', () => {
  assert.throws(
    () => interpolateFlow('count={gate.finished_workers}', null, { other: '1' }),
    /unresolved gate parameter\(s\): finished_workers/,
  );
});

// ── runGate ──────────────────────────────────────────────────────────────────
function writeScript(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

test('runGate: exit 0 = go, stdout JSON becomes params', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-gate-'));
  const s = writeScript(dir, 'go.js', 'process.stdout.write(JSON.stringify({ variant: "FULL", n: 3 }));\n');
  const r = await runGate(s, ctx);
  assert.equal(r.go, true);
  assert.equal(r.params.variant, 'FULL');
  assert.equal(r.params.n, '3'); // non-string flattened
  rmSync(dir, { recursive: true, force: true });
});

test('runGate: non-zero exit = skip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-gate-'));
  const s = writeScript(dir, 'skip.js', 'process.exit(1);\n');
  const r = await runGate(s, ctx);
  assert.equal(r.go, false);
  assert.match(r.reason ?? '', /exit 1/);
  rmSync(dir, { recursive: true, force: true });
});

test('runGate: receives the event context via env COCKPIT_EVENT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-gate-'));
  // Exit 0 (go) ONLY if the env JSON carries the source id — proves ctx delivery
  // without fragile JSON-in-JSON echoing.
  const s = writeScript(
    dir,
    'check.js',
    'const event = JSON.parse(process.env.COCKPIT_EVENT || "{}");\nprocess.exit(event.sessionId === "src-1" ? 0 : 1);\n',
  );
  const r = await runGate(s, ctx);
  assert.equal(r.go, true);
  rmSync(dir, { recursive: true, force: true });
});

test('runGate: a hanging gate times out and skips (fail-safe)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-gate-'));
  const s = writeScript(dir, 'hang.js', 'setTimeout(() => {}, 5000);\n');
  const r = await runGate(s, ctx, 200);
  assert.equal(r.go, false);
  assert.match(r.reason ?? '', /timed out/);
  rmSync(dir, { recursive: true, force: true });
});

// ── gateCommand (cross-platform launcher routing) ────────────────────────────
test('gateCommand: .js/.mjs/.cjs route through the Node binary', () => {
  for (const name of ['gate.js', 'gate.mjs', 'gate.cjs']) {
    const { cmd, args } = gateCommand(`/flows/${name}`);
    assert.equal(cmd, process.execPath);
    assert.deepEqual(args, [`/flows/${name}`]);
  }
});

test('gateCommand: .py routes through python (COCKPIT_PYTHON override)', () => {
  const prev = process.env.COCKPIT_PYTHON;
  process.env.COCKPIT_PYTHON = '/opt/py/bin/python';
  try {
    const { cmd, args } = gateCommand('/flows/g.py');
    assert.equal(cmd, '/opt/py/bin/python');
    assert.deepEqual(args, ['/flows/g.py']);
  } finally {
    if (prev === undefined) delete process.env.COCKPIT_PYTHON; else process.env.COCKPIT_PYTHON = prev;
  }
});

test('gateCommand: .sh / extension-less spawn directly (POSIX shebang)', () => {
  assert.deepEqual(gateCommand('/flows/g.sh'), { cmd: '/flows/g.sh', args: [] });
  assert.deepEqual(gateCommand('/flows/gate'), { cmd: '/flows/gate', args: [] });
});

test('runGate: a Node .js gate runs cross-platform (go + params)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-gate-'));
  // A .js gate: reads COCKPIT_EVENT, emits params on stdout, exit 0 = go. No shebang
  // or exec bit needed — runGate launches it via the Node binary on every platform.
  const p = join(dir, 'gate.js');
  writeFileSync(p, [
    'const ev = JSON.parse(process.env.COCKPIT_EVENT || "{}");',
    'process.stdout.write(JSON.stringify({ src: ev.sessionId, variant: "JS" }));',
    'process.exit(ev.sessionId === "src-1" ? 0 : 1);',
  ].join('\n'));
  const r = await runGate(p, ctx);
  assert.equal(r.go, true);
  assert.equal(r.params.variant, 'JS');
  assert.equal(r.params.src, 'src-1');
  rmSync(dir, { recursive: true, force: true });
});

test('runGate: invalid JSON and non-object stdout are explicit failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-gate-'));
  const invalid = writeScript(dir, 'invalid.js', 'process.stdout.write("not-json");\n');
  const nonObject = writeScript(dir, 'array.js', 'process.stdout.write("[1,2]");\n');

  const invalidResult = await runGate(invalid, ctx);
  assert.equal(invalidResult.go, false);
  assert.match(invalidResult.error ?? '', /invalid JSON/);

  const nonObjectResult = await runGate(nonObject, ctx);
  assert.equal(nonObjectResult.go, false);
  assert.match(nonObjectResult.error ?? '', /must be a JSON object/);
  rmSync(dir, { recursive: true, force: true });
});

test('runGate: a missing script skips, never throws', async () => {
  const r = await runGate('/no/such/gate/script', ctx, 1000);
  assert.equal(r.go, false);
});

// ── FlowRegistry ─────────────────────────────────────────────────────────────
test('FlowRegistry loads valid flows and skips invalid ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-flows-'));
  const valid: Flow = {
    id: 'welcome-flow',
    name: 'Butler welcome',
    action: { kind: 'spawn-session', template: { cwd: '{event.cwd}', prompt: 'hi {event.sessionId}', skills: ['session-outfitter'], mcps: ['cockpit'] } },
  };
  writeFileSync(join(dir, 'welcome.json'), JSON.stringify(valid));
  writeFileSync(join(dir, 'broken.json'), '{ not valid flow }');
  writeFileSync(join(dir, 'wrong-shape.json'), JSON.stringify({ id: 'x', action: { kind: 'nope' } }));
  const reg = new FlowRegistry(dir);
  const flows = reg.list();
  assert.equal(flows.length, 1);
  assert.equal(flows[0].id, 'welcome-flow');
  assert.equal(reg.get('welcome-flow')?.action.kind, 'spawn-session');
  assert.equal(reg.get('missing'), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('FlowRegistry on a missing dir returns []', () => {
  const reg = new FlowRegistry(join(tmpdir(), 'cockpit-flows-does-not-exist-xyz'));
  assert.deepEqual(reg.list(), []);
});

test('FlowRegistry accepts a prompt-existing action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-flows-'));
  mkdirSync(dir, { recursive: true });
  const f: Flow = { id: 'ping', action: { kind: 'prompt-existing', sessionId: 's1', prompt: 'go' } };
  writeFileSync(join(dir, 'ping.json'), JSON.stringify(f));
  const reg = new FlowRegistry(dir);
  assert.equal(reg.get('ping')?.action.kind, 'prompt-existing');
  rmSync(dir, { recursive: true, force: true });
});

// ── Authoring (write / remove / writeGate + path-traversal safety) ───────────
test('isSafeBasename rejects traversal and separators', () => {
  assert.equal(isSafeBasename('welcome-flow'), true);
  assert.equal(isSafeBasename('a.b_c-1'), true);
  assert.equal(isSafeBasename('../evil'), false);
  assert.equal(isSafeBasename('a/b'), false);
  assert.equal(isSafeBasename('.hidden'), false);
  assert.equal(isSafeBasename(''), false);
});

test('FlowRegistry.write then list round-trips a flow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-flows-'));
  const reg = new FlowRegistry(dir);
  const flow: Flow = { id: 'wf', name: 'WF', action: { kind: 'prompt-existing', sessionId: 's1', prompt: 'go' } };
  assert.equal(reg.write(flow).ok, true);
  assert.ok(existsSync(join(dir, 'wf.json')));
  assert.equal(reg.get('wf')?.name, 'WF');
  rmSync(dir, { recursive: true, force: true });
});

test('FlowRegistry.write rejects an unsafe id (no file escapes the dir)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-flows-'));
  const reg = new FlowRegistry(dir);
  const res = reg.write({ id: '../escape', action: { kind: 'prompt-existing', sessionId: 's', prompt: 'x' } } as Flow);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /unsafe flow id/);
  assert.equal(existsSync(join(dir, '..', 'escape.json')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('FlowRegistry.remove deletes the file; missing → ok:false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-flows-'));
  const reg = new FlowRegistry(dir);
  reg.write({ id: 'gone', action: { kind: 'prompt-existing', sessionId: 's', prompt: 'x' } } as Flow);
  assert.equal(reg.remove('gone').ok, true);
  assert.equal(existsSync(join(dir, 'gone.json')), false);
  assert.equal(reg.remove('gone').ok, false); // idempotent: no such flow
  assert.equal(reg.remove('../x').ok, false); // unsafe
  rmSync(dir, { recursive: true, force: true });
});

test('FlowRegistry.writeGate writes an executable script and returns its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-flows-'));
  const reg = new FlowRegistry(dir);
  const res = reg.writeGate('my-gate.js', 'process.exit(0);\n');
  assert.equal(res.ok, true);
  assert.equal(res.path, join(dir, 'my-gate.js'));
  assert.equal(readFileSync(res.path!, 'utf-8'), 'process.exit(0);\n');
  // POSIX direct-spawn gates need an executable bit; Windows has no such mode.
  if (process.platform !== 'win32') assert.equal((statSync(res.path!).mode & 0o100) !== 0, true);
  // unsafe name rejected
  assert.equal(reg.writeGate('../evil.sh', 'x').ok, false);
  rmSync(dir, { recursive: true, force: true });
});
