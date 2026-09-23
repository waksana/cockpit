import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_MODULE_EVENT_BYTES, ServerEvent, snapshotModuleEventPayload, type ModuleEventPayload } from './index.ts';

test('module event envelopes preserve all JSON shapes, freeze snapshots and reject unknown host fields', () => {
  const object = JSON.parse('{"__proto__":{"safe":true},"constructor":"data","toJSON":"data","nested":[null,true,2.5,"界"]}');
  for (const payload of [null, true, false, 0, 2.5, '', 'text', [], {}, object]) {
    const envelope = { type: 'module/event', moduleId: 'fixture', payload };
    const parsed = ServerEvent.parse(envelope);
    assert.deepEqual(parsed, envelope);
    assert.equal(parsed.type, 'module/event');
    if (parsed.type !== 'module/event') assert.fail();
    assert.ok(Object.isFrozen(parsed.payload));
  }
  const parsed = ServerEvent.parse({ type: 'module/event', moduleId: 'fixture', payload: object });
  assert.equal(parsed.type, 'module/event');
  if (parsed.type !== 'module/event') assert.fail();
  object.nested.push('late');
  assert.notDeepEqual(parsed.payload, object);
  assert.throws(() => ((parsed.payload as Record<string, unknown>).nested as unknown[]).push('changed'), TypeError);
  for (const envelope of [
    { type: 'module/event', moduleId: 'fixture' },
    { type: 'module/event', moduleId: '../other', payload: null },
    { type: 'module/event', moduleId: 'fixture', payload: null, sessionId: 'forged' },
    { type: 'module/event', moduleId: 'fixture', payload: { value: Infinity } },
    { type: 'module/other', moduleId: 'fixture', payload: null },
  ]) assert.equal(ServerEvent.safeParse(envelope).success, false);
});

test('payload budget measures exact serialized UTF-8, including escaping and structure', () => {
  assert.equal(MAX_MODULE_EVENT_BYTES, 65_536);
  const exact = [
    'x'.repeat(MAX_MODULE_EVENT_BYTES - 2),
    '界'.repeat(21_844) + 'xx',
    '😀'.repeat(16_383) + 'xx',
    '\n'.repeat(32_767),
    { x: 'x'.repeat(MAX_MODULE_EVENT_BYTES - 8) },
  ];
  for (const payload of exact) {
    assert.equal(Buffer.byteLength(JSON.stringify(payload)), MAX_MODULE_EVENT_BYTES);
    assert.deepEqual(snapshotModuleEventPayload(payload), payload);
    const oversized = typeof payload === 'string' ? payload + 'x' : { x: payload.x + 'x' };
    assert.throws(() => snapshotModuleEventPayload(oversized), { code: 'MODULE_EVENT_TOO_LARGE' });
    assert.equal(ServerEvent.safeParse({ type: 'module/event', moduleId: 'fixture', payload: oversized }).success, false);
  }
});

test('strict JSON rejects coercion, accessors, hidden data and unsafe structures without invoking code', () => {
  let invoked = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked++; return 1; } });
  const cycle: unknown[] = [];
  cycle.push(cycle);
  let deep: unknown = null;
  for (let i = 0; i < 65; i++) deep = [deep];
  for (const payload of [
    undefined, () => {}, Symbol('value'), 1n, NaN, Infinity, -Infinity,
    { missing: undefined }, [undefined], { value: NaN }, cycle, accessor,
    Object.defineProperty({}, 'hidden', { value: 1 }), { [Symbol('key')]: 1 },
    { toJSON() { invoked++; return {}; } }, new Date(), new Map(), new Set(),
    new Uint8Array([1]), new Number(1), new Blob(['resource']), Promise.resolve(),
    // A sparse array is the deliberate invalid payload here.
    // eslint-disable-next-line no-sparse-arrays
    Object.create({ inherited: true }), new Array(2), [1, , 2],
    Object.assign([], { extra: 1 }), deep,
  ]) {
    assert.throws(() => snapshotModuleEventPayload(payload), { code: 'MODULE_EVENT_INVALID' });
    assert.equal(ServerEvent.safeParse({ type: 'module/event', moduleId: 'fixture', payload }).success, false);
  }
  assert.equal(invoked, 0);
  const shared = { value: 'ordinary' };
  const payload = { first: shared, second: shared, nullPrototype: Object.assign(Object.create(null), { x: true }) };
  assert.deepEqual(snapshotModuleEventPayload(payload), JSON.parse(JSON.stringify(payload)));
  let safe: ModuleEventPayload = null;
  for (let i = 0; i < 64; i++) safe = [safe];
  assert.deepEqual(snapshotModuleEventPayload(safe), safe);
});
