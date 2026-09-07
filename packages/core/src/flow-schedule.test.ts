// Unit tests for flow-schedule.ts — the server-level flow time-trigger logic.
// Pure helpers (interval, cron, buildEntry, reschedule) + the registry's fire/
// persist/stop behavior with fake timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIntervalMs, parseCron, cronNextFire, buildEntry, reschedule, FlowScheduleRegistry,
} from './flow-schedule.ts';
import type { FlowScheduleEntry } from '@cockpit/protocol';

// ── parseIntervalMs ──────────────────────────────────────────────────────────
test('parseIntervalMs handles s/m/h/d and the 10s floor', () => {
  assert.equal(parseIntervalMs('10s'), 10_000);
  assert.equal(parseIntervalMs('5m'), 300_000);
  assert.equal(parseIntervalMs('2h'), 7_200_000);
  assert.equal(parseIntervalMs('1d'), 86_400_000);
  assert.equal(parseIntervalMs('5s'), 10_000); // floored to 10s
  assert.equal(parseIntervalMs('bad'), null);
  assert.equal(parseIntervalMs('0m'), null);
});

// ── parseCron / cronNextFire ─────────────────────────────────────────────────
test('parseCron rejects malformed expressions', () => {
  assert.throws(() => parseCron('* * * *'));       // 4 fields
  assert.throws(() => parseCron('60 * * * *'));     // minute out of range
  assert.throws(() => parseCron('* 24 * * *'));     // hour out of range
});

test('cronNextFire: every day at 09:00 UTC', () => {
  // from 2026-01-01T08:00:00Z → next is 2026-01-01T09:00:00Z
  const from = Date.parse('2026-01-01T08:00:00Z');
  const next = cronNextFire('0 9 * * *', from, 'UTC');
  assert.equal(new Date(next).toISOString(), '2026-01-01T09:00:00.000Z');
});

test('cronNextFire: rolls to the next day when past today’s time', () => {
  const from = Date.parse('2026-01-01T10:00:00Z');
  const next = cronNextFire('0 9 * * *', from, 'UTC');
  assert.equal(new Date(next).toISOString(), '2026-01-02T09:00:00.000Z');
});

test('cronNextFire: timezone-aware (09:00 Asia/Shanghai = 01:00 UTC)', () => {
  const from = Date.parse('2026-01-01T00:00:00Z');
  const next = cronNextFire('0 9 * * *', from, 'Asia/Shanghai');
  // 09:00 in UTC+8 is 01:00 UTC the same day
  assert.equal(new Date(next).toISOString(), '2026-01-01T01:00:00.000Z');
});

test('cronNextFire: step + every-15-minutes', () => {
  const from = Date.parse('2026-01-01T00:07:00Z');
  const next = cronNextFire('*/15 * * * *', from, 'UTC');
  assert.equal(new Date(next).toISOString(), '2026-01-01T00:15:00.000Z');
});

test('cronNextFire: DOM/DOW OR semantics (both restricted)', () => {
  // "on the 1st OR on Monday" — from mid-week non-1st, the next match is the
  // sooner of next Monday / next 1st.
  const from = Date.parse('2026-06-10T12:00:00Z'); // Wed Jun 10 2026
  const next = cronNextFire('0 0 1 * 1', from, 'UTC'); // 00:00 on day-1 or Monday
  // Next Monday is Jun 15; next 1st is Jul 1 → Monday Jun 15 wins.
  assert.equal(new Date(next).toISOString(), '2026-06-15T00:00:00.000Z');
});

test('cronNextFire: DST spring-forward is handled (America/New_York)', () => {
  // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00→03:00).
  // A 02:30 daily cron simply has no match that day; the next valid 02:30 is 03-09.
  const from = Date.parse('2026-03-08T00:00:00Z');
  const next = cronNextFire('30 2 * * *', from, 'America/New_York');
  assert.ok(next !== null);
  // Whatever it returns, the wall-clock minute must be 30 and hour 2 in NY.
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(next));
  assert.match(fmt, /02:30/);
});

// ── buildEntry ───────────────────────────────────────────────────────────────
test('buildEntry requires exactly one timing kind', () => {
  assert.match(buildEntry({ flowId: 'f' }, 0).error ?? '', /exactly one/);
  assert.match(buildEntry({ flowId: 'f', interval: '5m', at: 1 }, 0).error ?? '', /exactly one of interval/);
});

test('buildEntry requires exactly one action (flowId XOR inline target)', () => {
  assert.match(buildEntry({ interval: '5m' }, 0).error ?? '', /exactly one of flowId or target/);
  assert.match(
    buildEntry({ flowId: 'f', target: { kind: 'prompt-existing', sessionId: 's', prompt: 'p' }, interval: '5m' }, 0).error ?? '',
    /exactly one of flowId or target/,
  );
});

test('buildEntry carries an inline prompt-existing target', () => {
  const { entry } = buildEntry({ target: { kind: 'prompt-existing', sessionId: 's1', prompt: 'go' }, interval: '5m' }, 1_000);
  assert.equal(entry?.flowId, undefined);
  assert.deepEqual(entry?.target, { kind: 'prompt-existing', sessionId: 's1', prompt: 'go' });
  assert.equal(entry?.nextRunAt, 301_000);
});

test('buildEntry interval → recurring by default, nextRunAt = now+ms', () => {
  const { entry } = buildEntry({ flowId: 'f', interval: '5m' }, 1_000);
  assert.equal(entry?.recurring, true);
  assert.equal(entry?.intervalMs, 300_000);
  assert.equal(entry?.nextRunAt, 301_000);
});

test('buildEntry at → one-shot by default', () => {
  const { entry } = buildEntry({ flowId: 'f', at: 5_000 }, 1_000);
  assert.equal(entry?.recurring, false);
  assert.equal(entry?.at, 5_000);
  assert.equal(entry?.nextRunAt, 5_000);
});

// ── reschedule ───────────────────────────────────────────────────────────────
test('reschedule: interval re-arms from now; one-shot drops', () => {
  const interval: FlowScheduleEntry = { id: 1, flowId: 'f', recurring: true, intervalMs: 60_000, nextRunAt: 0 };
  assert.equal(reschedule(interval, 10_000), 70_000);
  const oneShot: FlowScheduleEntry = { id: 2, flowId: 'f', recurring: false, at: 5_000, nextRunAt: 5_000 };
  assert.equal(reschedule(oneShot, 5_000), null);
});

// ── FlowScheduleRegistry ─────────────────────────────────────────────────────
test('registry: a near-due entry fires (whole entry), persists, and re-arms', async () => {
  const fired: string[] = [];
  let saved: FlowScheduleEntry[] = [];
  const reg = new FlowScheduleRegistry([], (e) => { saved = e; }, (entry) => { fired.push(entry.flowId ?? entry.target?.sessionId ?? '?'); });
  reg.arm();
  // add a one-shot `at` ~120ms out to test the fire path fast.
  const { entry } = reg.add({ flowId: 'patrol', at: Date.now() + 120 });
  assert.ok(entry);
  assert.equal(saved.length, 1);
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(fired, ['patrol']);
  // one-shot dropped after firing
  assert.equal(reg.list().length, 0);
  reg.disarm();
});

test('registry: an inline-target entry fires with its session id', async () => {
  const fired: string[] = [];
  const reg = new FlowScheduleRegistry([], () => {}, (entry) => { fired.push(entry.target?.sessionId ?? '?'); });
  reg.arm();
  reg.add({ target: { kind: 'prompt-existing', sessionId: 'sess-9', prompt: 'ping' }, at: Date.now() + 120 });
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(fired, ['sess-9']);
  reg.disarm();
});

test('registry: stop removes an entry (idempotent) and seeds id past restored', () => {
  const reg = new FlowScheduleRegistry(
    [{ id: 9, flowId: 'f', recurring: true, intervalMs: 60_000, nextRunAt: Date.now() + 1e9 }],
    () => {}, () => {},
  );
  const { entry } = reg.add({ flowId: 'g', interval: '5m' });
  assert.equal(entry?.id, 10); // seeded past id 9
  assert.equal(reg.stop(10), true);
  assert.equal(reg.stop(10), false); // idempotent
  assert.equal(reg.list().length, 1);
});
