#!/usr/bin/env node
// End-to-end test against the RUNNING cockpit backend (127.0.0.1:8771). Exercises
// the real HTTP surface: health/status, intent validation, the upload roundtrip
// (+ path-traversal rejection), session create/delete, and the MCP/skill intents.
//
// Run:  node scripts/e2e.mjs        (or: pnpm e2e from repo root)
// Env:  COCKPIT_PORT (default 8771)
//
// Non-destructive by default: it creates + deletes ONE throwaway session and one
// throwaway upload, and never sends a prompt (which would cost model tokens).

import assert from 'node:assert/strict';

const PORT = process.env.COCKPIT_PORT ?? '8771';
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

const j = async (res) => { try { return await res.json(); } catch { return null; } };
const intent = (name, body) => fetch(`${BASE}/intent/${name}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

console.log(`E2E against ${BASE}\n`);

// ── health + status ───────────────────────────────────────────────────────────
await t('GET /health → ok + login', async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  const b = await j(r);
  assert.equal(b.ok, true);
  assert.ok(typeof b.login === 'string' && b.login.length > 0);
});

await t('GET /status → running count + sessions[]', async () => {
  const b = await j(await fetch(`${BASE}/status`));
  assert.ok(Array.isArray(b.sessions));
  assert.equal(typeof b.running, 'number');
  assert.equal(typeof b.restartPending, 'boolean');
});

await t('capabilities publishes the foundation contract without governance', async () => {
  const response = await fetch(`${BASE}/capabilities`);
  assert.equal(response.status, 200);
  const catalog = await j(response);
  const names = catalog.intents.map((entry) => entry.name);
  for (const name of ['session/new', 'session/chat', 'prompt', 'cancel', 'schedule/list']) {
    assert.ok(names.includes(name), `${name} is discoverable`);
  }
  assert.ok(!names.some((name) => /^(hook|flow|flow-schedule)\//.test(name)));
  assert.ok(!names.includes('session/set-spawned-by'));
  assert.ok(catalog.transports.some((entry) => entry.method === 'POST' && entry.path === '/upload'));
  assert.ok(catalog.transports.some((entry) => entry.method === 'GET' && entry.path === '/uploads/:name'));
  const detail = await j(await fetch(`${BASE}/capabilities?name=session%2Fchat`));
  assert.equal(detail.name, 'session/chat');
  assert.equal(detail.inputSchema.type, 'object');
  assert.equal(detail.resultSchema.type, 'object');
});

// ── intent validation ─────────────────────────────────────────────────────────
await t('unknown intent → 404', async () => {
  const r = await intent('does/not/exist', {});
  assert.equal(r.status, 404);
});

await t('retired governance intents → 404', async () => {
  for (const name of ['hook/list', 'flow/list', 'flow-schedule/list', 'session/set-spawned-by']) {
    assert.equal((await intent(name, {})).status, 404, name);
  }
});

await t('bad intent body → 4xx (zod rejects)', async () => {
  const r = await intent('mcp/session', { wrong: 'shape' }); // missing sessionId
  assert.ok(r.status >= 400 && r.status < 500, `got ${r.status}`);
});

// ── MCP + skills (read-only intents) ──────────────────────────────────────────
await t('mcp/global → servers[]', async () => {
  const b = await j(await intent('mcp/global', {}));
  assert.ok(Array.isArray(b.servers));
  for (const s of b.servers) {
    assert.equal(typeof s.name, 'string');
    assert.equal(typeof s.detail, 'string');
    assert.equal(typeof s.defaultOn, 'boolean');
  }
});

await t('skills/global → skills[] (includes installed skills)', async () => {
  const b = await j(await intent('skills/global', {}));
  assert.ok(Array.isArray(b.skills));
});

await t('fs/listDir → dirs of home, with parent + sorted entries', async () => {
  const b = await j(await intent('fs/listDir', {}));
  assert.ok(typeof b.path === 'string' && b.path.startsWith('/'));
  assert.ok(b.parent === null || typeof b.parent === 'string');
  assert.ok(Array.isArray(b.entries));
  for (const e of b.entries) {
    assert.equal(typeof e.name, 'string');
    assert.equal(typeof e.isDir, 'boolean');
    assert.ok(!e.name.startsWith('.'), 'dotfiles hidden by default');
  }
});

await t('fs/listDir at filesystem root → parent null', async () => {
  const b = await j(await intent('fs/listDir', { path: '/' }));
  assert.equal(b.path, '/');
  assert.equal(b.parent, null);
});

// ── upload roundtrip + traversal rejection ────────────────────────────────────
let uploadedUrl = null;
await t('POST /upload → stores file, returns metadata', async () => {
  const payload = Buffer.from(`e2e-${Date.now()}-${Math.random()}`);
  const r = await fetch(`${BASE}/upload?name=${encodeURIComponent('e2e test.txt')}&mime=${encodeURIComponent('text/plain')}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload,
  });
  assert.equal(r.status, 200);
  const b = await j(r);
  assert.equal(b.kind, 'file');
  assert.equal(b.name, 'e2e test.txt');
  assert.equal(b.size, payload.length);
  assert.ok(b.url.startsWith('/uploads/'));
  uploadedUrl = b.url;
  globalThis.__e2ePayload = payload;
});

await t('GET /uploads/:name → byte-identical', async () => {
  assert.ok(uploadedUrl, 'upload must have succeeded');
  const r = await fetch(`${BASE}${uploadedUrl}`);
  assert.equal(r.status, 200);
  const got = Buffer.from(await r.arrayBuffer());
  assert.ok(got.equals(globalThis.__e2ePayload), 'served bytes match uploaded bytes');
});

await t('served upload carries XSS-hardening headers', async () => {
  const r = await fetch(`${BASE}${uploadedUrl}`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
});

await t('POST /upload empty body → 400', async () => {
  const r = await fetch(`${BASE}/upload?name=x&mime=text/plain`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: '',
  });
  assert.equal(r.status, 400);
});

await t('GET /uploads/<traversal> → 404 (no escape)', async () => {
  for (const bad of ['..%2f..%2fetc%2fpasswd', '..%2fcockpit-prefs.json']) {
    const r = await fetch(`${BASE}/uploads/${bad}`);
    assert.ok(r.status === 404 || r.status === 400, `traversal ${bad} got ${r.status}`);
  }
});

// Only the session created by this run may be permanently deleted.
const listSupported = (await intent('session/list', {})).status !== 404;

await t('session/new + per-session MCP intent', async () => {
  const created = await j(await intent('session/new', { cwd: process.env.HOME ?? '/tmp' }));
  assert.ok(created.sessionId, 'got a sessionId');
  globalThis.__e2eSession = created.sessionId;
  const status = await j(await fetch(`${BASE}/status`));
  assert.ok(status.sessions.some((s) => s.sessionId === created.sessionId), 'new session listed');
  const mcp = await j(await intent('mcp/session', { sessionId: created.sessionId }));
  assert.ok(Array.isArray(mcp.servers));
});

// ── per-session metadata control (the surface the cockpit MCP wraps) ──────────
if (listSupported) {
  await t('session/list → authoritative live list incl. the throwaway', async () => {
    const b = await j(await intent('session/list', {}));
    assert.ok(Array.isArray(b.sessions));
    const me = b.sessions.find((s) => s.sessionId === globalThis.__e2eSession);
    assert.ok(me, 'throwaway session present in session/list');
    assert.equal(typeof me.title, 'string');
    assert.equal(typeof me.status, 'string');
    assert.equal(typeof me.loaded, 'boolean');
    assert.equal(typeof me.cwd, 'string');
  });
}

await t('session/rename → applies + echoes an authoritative title', async () => {
  const id = globalThis.__e2eSession;
  const res = await j(await intent('session/rename', { sessionId: id, name: 'e2e-renamed' }));
  assert.equal(res.ok, true);
  assert.ok(typeof res.title === 'string' && res.title.length > 0, 'title echoed back');
});

await t('skills/session-toggle → native session readback, then restore', async () => {
  const id = globalThis.__e2eSession;
  const list = await j(await intent('skills/session', { sessionId: id }));
  assert.ok(Array.isArray(list.skills));
  if (list.skills.length) {
    const name = list.skills[0].name;
    const off = await j(await intent('skills/session-toggle', { sessionId: id, name, enabled: false }));
    assert.equal(off.ok, true);
    const after = await j(await intent('skills/session', { sessionId: id }));
    assert.equal(after.skills.find((s) => s.name === name).enabled, false, 'skill disabled for this session');
    await intent('skills/session-toggle', { sessionId: id, name, enabled: true }); // restore
  }
});

await t('mcp/session-toggle → native disabled state is confirmed', async () => {
  const id = globalThis.__e2eSession;
  const list = await j(await intent('mcp/session', { sessionId: id }));
  assert.ok(Array.isArray(list.servers));
  if (list.servers.length) {
    const name = list.servers[0].name;
    // Only change the throwaway session; native global defaults stay untouched.
    const res = await j(await intent('mcp/session-toggle', { sessionId: id, name, on: false }));
    assert.equal(res.ok, true);
    const after = await j(await intent('mcp/session', { sessionId: id }));
    assert.equal(after.servers.find((s) => s.name === name).enabled, false, 'mcp left disabled for this session');
  }
});

await t('session/pin → UI mark applies, then release', async () => {
  const id = globalThis.__e2eSession;
  const on = await j(await intent('session/pin', { sessionId: id, pinned: true }));
  assert.equal(on.ok, true);
  assert.equal(on.pinned, true, 'pin applied');
  const off = await j(await intent('session/pin', { sessionId: id, pinned: false }));
  assert.equal(off.pinned, false, 'unpin applied');
});

await t('unloaded history stays passive; native details require explicit resume', async () => {
  const sessionId = globalThis.__e2eSession;
  assert.equal((await intent('session/unload', { sessionId })).status, 200);
  try {
    const history = await intent('session/chat', { sessionId, source: 'persisted', direction: 'backward', max: 10 });
    assert.equal(history.status, 200);
    assert.ok(Array.isArray((await j(history)).events));
    for (const name of ['session/plan', 'session/panels', 'skills/session', 'schedule/list']) {
      const response = await intent(name, { sessionId });
      assert.equal(response.status, 409, name);
      assert.equal((await j(response)).code, 'SESSION_UNLOADED', name);
    }
    const current = await j(await intent('session/get', { sessionId }));
    assert.equal(current.meta.loaded, false);
    assert.equal(current.meta.error, null);
  } finally {
    assert.equal((await intent('session/reload', { sessionId })).status, 200);
  }
  assert.equal((await intent('session/plan', { sessionId })).status, 200);
});

// ── scheduled prompts (add → list → stop) ─────────────────────────────────────
// Feature-detected. Non-destructive: uses a far-future one-shot + a long interval so
// nothing actually fires during the test, and stops both before the session is purged.
const scheduleSupported = (await intent('schedule/list', { sessionId: globalThis.__e2eSession })).status !== 404;
if (scheduleSupported) {
  await t('schedule/add interval + at, list, then stop', async () => {
    const id = globalThis.__e2eSession;
    const r1 = await j(await intent('schedule/add', { sessionId: id, prompt: 'e2e interval', interval: '1h' }));
    assert.equal(r1.ok, true, r1.error ?? 'interval add failed');
    assert.equal(r1.entry.recurring, true);
    assert.equal(r1.entry.intervalMs, 3600000);
    const r3 = await j(await intent('schedule/add', { sessionId: id, prompt: 'e2e once', at: Date.now() + 3600_000 }));
    assert.equal(r3.ok, true, r3.error ?? 'at add failed');
    assert.equal(r3.entry.recurring, false);

    const listed = await j(await intent('schedule/list', { sessionId: id }));
    assert.ok(listed.entries.length >= 2, 'both schedules listed');

    for (const r of [r1, r3]) {
      const stop = await j(await intent('schedule/stop', { sessionId: id, id: r.entry.id }));
      assert.equal(stop.ok, true, `stop #${r.entry.id}`);
    }
    const after = await j(await intent('schedule/list', { sessionId: id }));
    assert.ok(!after.entries.some((e) => [r1, r3].some((r) => r.entry.id === e.id)), 'stopped schedules gone');
  });

  await t('schedule/add rejects a zero interval before native execution', async () => {
    const id = globalThis.__e2eSession;
    const response = await intent('schedule/add', { sessionId: id, prompt: 'invalid delay', interval: '0s' });
    assert.equal(response.status, 400);
  });
}

await t('session/delete rejects legacy requests, then permanently deletes the owned fixture', async () => {
  const id = globalThis.__e2eSession;
  assert.ok(id, 'this run must have created the session');
  for (const name of ['session/delete', 'session/purge']) {
    const response = await intent(name, { sessionId: id });
    assert.equal(response.status, 400, `${name} requires explicit confirmation`);
  }
  const before = await j(await intent('session/get', { sessionId: id }));
  assert.equal(before.meta.sessionId, id);
  const del = await j(await intent('session/delete', { sessionId: id, confirm: true }));
  assert.equal(del.ok, true);
  const status = await j(await fetch(`${BASE}/status`));
  assert.ok(!status.sessions.some((s) => s.sessionId === id), 'deleted session not in status');
  for (const name of ['session/trash-list', 'session/restore']) {
    assert.equal((await intent(name, { sessionId: id })).status, 404);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
