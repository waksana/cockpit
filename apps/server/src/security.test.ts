// Tests for the transport-layer security/consistency hardening (fx-server):
//   - Origin/CSRF gate: accept same-origin / loopback / known / configured /
//     no-origin; reject cross-origin + opaque "null".
//   - SSE high-water-mark: drop + destroy a slow consumer; keep healthy ones.
//   - graceful-restart busy predicate DELEGATES to the engine's sessionMetaBusy.
//
// Isolated: the module is imported with COCKPIT_NO_BOOT=1 so the Engine (which
// reads the real ~/.copilot prefs) is never constructed and no port is bound;
// COCKPIT_UPLOAD_DIR points at a unique nonexistent path within apps/server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionMetaBusy } from '@cockpit/core';
import type { SessionMeta } from '@cockpit/protocol';

const TEST_UPLOAD_DIR = relative(process.cwd(), fileURLToPath(
  new URL(`../.cockpit-server-sec-${process.pid}-${randomUUID()}`, import.meta.url),
));
process.env.COCKPIT_NO_BOOT = '1';
process.env.LOG_LEVEL = 'silent';
process.env.COCKPIT_UPLOAD_DIR = TEST_UPLOAD_DIR;
process.env.COCKPIT_ALLOWED_ORIGINS = 'https://configured.example';

// Import AFTER the env is set (the module reads these at load time).
const { app, isAllowedOrigin, sessionBusy, sseWrite, broadcastFrame } = await import('./index.ts');
after(async () => {
  try { await app.close(); }
  finally { rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true }); }
});
await app.ready();

// ── Origin/CSRF gate via app.inject ────────────────────────────────────────
// An unknown intent route returns 404 from the handler; the onRequest Origin hook
// returns 403 BEFORE the handler. So 403 ⇒ blocked by the gate, 404 ⇒ passed it.

test('Origin gate: rejects a cross-origin mutating POST', async () => {
  const res = await app.inject({
    method: 'POST', url: '/intent/__unknown__',
    headers: { origin: 'https://evil.example', host: 'cockpit.rbym47.com' },
  });
  assert.equal(res.statusCode, 403);
});

test('Origin gate: allows same-origin (Origin host == Host)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/intent/__unknown__',
    headers: { origin: 'https://app.internal', host: 'app.internal' },
  });
  assert.equal(res.statusCode, 404); // passed the gate → unknown-intent 404
});

test('Origin gate: allows the known public origin regardless of Host', async () => {
  const res = await app.inject({
    method: 'POST', url: '/intent/__unknown__',
    headers: { origin: 'https://cockpit.rbym47.com', host: '127.0.0.1:8771' },
  });
  assert.equal(res.statusCode, 404);
});

test('Origin gate: allows a configured (env) origin', async () => {
  const res = await app.inject({
    method: 'POST', url: '/intent/__unknown__',
    headers: { origin: 'https://configured.example', host: '127.0.0.1:8771' },
  });
  assert.equal(res.statusCode, 404);
});

test('Origin gate: allows a loopback origin (local dev)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/intent/__unknown__',
    headers: { origin: 'http://localhost:5173', host: '127.0.0.1:8771' },
  });
  assert.equal(res.statusCode, 404);
});

test('Origin gate: allows a no-Origin caller (MCP/curl over loopback)', async () => {
  const res = await app.inject({ method: 'POST', url: '/intent/__unknown__' });
  assert.equal(res.statusCode, 404);
});

test('Origin gate: rejects an opaque "null" Origin', async () => {
  const res = await app.inject({
    method: 'POST', url: '/intent/__unknown__',
    headers: { origin: 'null', host: 'cockpit.rbym47.com' },
  });
  assert.equal(res.statusCode, 403);
});

test('Origin gate: /admin/restart is gated cross-origin', async () => {
  const res = await app.inject({
    method: 'POST', url: '/admin/restart',
    headers: { origin: 'https://evil.example', host: 'cockpit.rbym47.com' },
    payload: { pending: true },
  });
  assert.equal(res.statusCode, 403);
});

test('Origin gate: GET is never gated (cross-origin GET reaches the handler)', async () => {
  const res = await app.inject({
    method: 'GET', url: '/uploads/does-not-exist.png',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(res.statusCode, 404); // reached handler (not 403) → not gated
});

// ── Pure isAllowedOrigin truth table ───────────────────────────────────────

test('isAllowedOrigin: no headers → allowed', () => {
  assert.equal(isAllowedOrigin({}), true);
});

test('isAllowedOrigin: cross-origin → rejected', () => {
  assert.equal(isAllowedOrigin({ origin: 'https://evil.example', host: 'cockpit.rbym47.com' }), false);
});

test('isAllowedOrigin: same-origin via Host → allowed', () => {
  assert.equal(isAllowedOrigin({ origin: 'https://foo.bar', host: 'foo.bar' }), true);
});

test('isAllowedOrigin: opaque "null" → rejected', () => {
  assert.equal(isAllowedOrigin({ origin: 'null', host: 'cockpit.rbym47.com' }), false);
});

test('isAllowedOrigin: Referer fallback when Origin is absent', () => {
  assert.equal(isAllowedOrigin({ referer: 'https://cockpit.rbym47.com/session/x', host: '127.0.0.1:8771' }), true);
  assert.equal(isAllowedOrigin({ referer: 'https://evil.example/x', host: '127.0.0.1:8771' }), false);
});

test('isAllowedOrigin: loopback origins allowed at any port', () => {
  assert.equal(isAllowedOrigin({ origin: 'http://localhost:5173', host: '127.0.0.1:8771' }), true);
  assert.equal(isAllowedOrigin({ origin: 'http://127.0.0.1:8771', host: '127.0.0.1:8771' }), true);
});

// ── SSE high-water-mark + fan-out ──────────────────────────────────────────

type FakeRaw = { writableLength: number; write(c: string): boolean; destroy(): void };
function fakeClient(writableLength: number) {
  const calls = { writes: [] as string[], destroyed: false };
  const raw: FakeRaw = {
    writableLength,
    write(c: string) { calls.writes.push(c); return true; },
    destroy() { calls.destroyed = true; },
  };
  return { reply: { raw }, calls };
}

test('sseWrite: drops + destroys a connection over the high-water-mark', () => {
  const slow = fakeClient(9 * 1024 * 1024); // > 8 MB default
  const set = new Set([slow.reply]);
  const ok = sseWrite(set, slow.reply, 'data: x\n\n');
  assert.equal(ok, false);
  assert.equal(slow.calls.destroyed, true);
  assert.equal(set.has(slow.reply), false);
  assert.equal(slow.calls.writes.length, 0); // never written to
});

test('sseWrite: writes to a healthy connection under the HWM', () => {
  const fast = fakeClient(1024);
  const set = new Set([fast.reply]);
  const ok = sseWrite(set, fast.reply, 'data: y\n\n');
  assert.equal(ok, true);
  assert.equal(fast.calls.writes[0], 'data: y\n\n');
  assert.equal(set.has(fast.reply), true);
});

test('sseWrite: a throwing write (closed socket) drops the connection', () => {
  const calls = { destroyed: false };
  const reply = { raw: { writableLength: 0, write() { throw new Error('EPIPE'); }, destroy() { calls.destroyed = true; } } };
  const set = new Set([reply]);
  const ok = sseWrite(set, reply, 'data: q\n\n');
  assert.equal(ok, false);
  assert.equal(set.has(reply), false);
});

test('broadcastFrame: drops only the slow consumer, keeps the healthy ones', () => {
  const a = fakeClient(1024), b = fakeClient(9 * 1024 * 1024), c = fakeClient(0);
  const set = new Set([a.reply, b.reply, c.reply]);
  broadcastFrame(set, 'data: z\n\n');
  assert.equal(set.has(a.reply), true);
  assert.equal(set.has(b.reply), false); // slow dropped
  assert.equal(b.calls.destroyed, true);
  assert.equal(set.has(c.reply), true);
  assert.equal(a.calls.writes[0], 'data: z\n\n');
  assert.equal(c.calls.writes[0], 'data: z\n\n');
});

test('sseWrite: respects an explicit lower high-water-mark', () => {
  const mid = fakeClient(2048);
  const set = new Set([mid.reply]);
  assert.equal(sseWrite(set, mid.reply, 'data: m\n\n', 1024), false); // 2048 > 1024 → drop
  assert.equal(mid.calls.destroyed, true);
});

test('sseWrite: buffer plus frame exactly equal to the high-water-mark is permitted', () => {
  const frame = 'data: 界😀\n\n';
  for (const writableLength of [0, 16]) {
    const client = fakeClient(writableLength);
    const set = new Set([client.reply]);
    const hwm = writableLength + Buffer.byteLength(frame, 'utf8');
    assert.equal(sseWrite(set, client.reply, frame, hwm), true);
    assert.deepEqual(client.calls.writes, [frame]);
    assert.equal(client.calls.destroyed, false);
    assert.equal(set.has(client.reply), true);
  }
});

test('sseWrite: buffer plus next frame crossing the cap is rejected before writing', () => {
  const frame = 'data: next\n\n';
  const hwm = 32;
  const client = fakeClient(hwm - Buffer.byteLength(frame) + 1);
  assert.ok(client.reply.raw.writableLength < hwm);
  assert.ok(Buffer.byteLength(frame) < hwm);
  const set = new Set([client.reply]);
  assert.equal(sseWrite(set, client.reply, frame, hwm), false);
  assert.deepEqual(client.calls.writes, []);
  assert.equal(client.calls.destroyed, true);
  assert.equal(set.has(client.reply), false);
});

test('sseWrite: an oversized frame with an empty buffer causes zero writes', () => {
  const frame = 'data: oversized\n\n';
  const client = fakeClient(0);
  const set = new Set([client.reply]);
  assert.equal(sseWrite(set, client.reply, frame, Buffer.byteLength(frame) - 1), false);
  assert.deepEqual(client.calls.writes, []);
  assert.equal(client.calls.destroyed, true);
  assert.equal(set.has(client.reply), false);
});

test('sseWrite: UTF-8 bytes, not string length, determine oversized frames before any write', () => {
  const frame = 'data: 界😀\n\n';
  const hwm = frame.length;
  assert.ok(Buffer.byteLength(frame, 'utf8') > hwm);
  const client = fakeClient(0);
  const set = new Set([client.reply]);
  assert.equal(sseWrite(set, client.reply, frame, hwm), false);
  assert.deepEqual(client.calls.writes, []);
  assert.equal(client.calls.destroyed, true);
  assert.equal(set.has(client.reply), false);
});

test('broadcastFrame: buffer plus frame crossing the cap drops only offending clients', () => {
  const frame = 'data: 界😀\n\n';
  const bytes = Buffer.byteLength(frame, 'utf8');
  const hwm = 64;
  const atLimit = fakeClient(hwm - bytes);
  const overByOne = fakeClient(hwm - bytes + 1);
  const overByTwo = fakeClient(hwm - bytes + 2);
  const healthy = fakeClient(0);
  const set = new Set([atLimit.reply, overByOne.reply, overByTwo.reply, healthy.reply]);
  broadcastFrame(set, frame, hwm);
  assert.deepEqual([...set], [atLimit.reply, healthy.reply]);
  for (const client of [overByOne, overByTwo]) {
    assert.ok(client.reply.raw.writableLength < hwm);
    assert.deepEqual(client.calls.writes, []);
    assert.equal(client.calls.destroyed, true);
  }
  for (const client of [atLimit, healthy]) {
    assert.deepEqual(client.calls.writes, [frame]);
    assert.equal(client.calls.destroyed, false);
  }
});

// ── Busy predicate delegation (graceful-restart gate) ──────────────────────

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's', title: 't', cwd: '/', lastActivity: 0,
    status: 'idle', error: null, loaded: true, queue: [], ask: null,
    ...over,
  } as SessionMeta;
}

test('sessionBusy delegates to engine sessionMetaBusy across states', () => {
  const cases: Partial<SessionMeta>[] = [
    { status: 'idle' },
    { status: 'running' },
    { status: 'idle', compacting: true },
    { status: 'idle', activeSubagents: 2 },
    { status: 'idle', activeMcpOperations: 1 },
    { status: 'idle', loading: true },
    { status: 'idle', closing: true },
    { status: 'idle', cancelling: true },
    { status: 'idle', loading: false, closing: false, cancelling: false },
    { status: 'idle', ask: { requestId: 'r', prompt: 'p' } as unknown as SessionMeta['ask'] },
    { status: 'idle', planRequest: { requestId: 'r' } as unknown as SessionMeta['planRequest'] },
    { status: 'idle', elicitation: { requestId: 'r' } as unknown as SessionMeta['elicitation'] },
  ];
  for (const c of cases) {
    const m = meta(c);
    assert.equal(sessionBusy(m), sessionMetaBusy(m), JSON.stringify(c));
  }
});

test('sessionBusy: idle with nothing pending → not busy', () => {
  assert.equal(sessionBusy(meta({ status: 'idle' })), false);
});

test('sessionBusy: an MCP mutation blocks graceful restart', () => {
  assert.equal(sessionBusy(meta({ activeMcpOperations: 1 })), true);
});

test('sessionBusy: compacting while idle → busy (manual /compact gap)', () => {
  assert.equal(sessionBusy(meta({ status: 'idle', compacting: true })), true);
});

test('sessionBusy: idle with a background sub-agent → busy', () => {
  assert.equal(sessionBusy(meta({ status: 'idle', activeSubagents: 1 })), true);
});

test('sessionBusy: idle but awaiting a choice → busy', () => {
  assert.equal(sessionBusy(meta({
    status: 'idle', ask: { requestId: 'r', prompt: 'p' } as unknown as SessionMeta['ask'],
  })), true);
});
