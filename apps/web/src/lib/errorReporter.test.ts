import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import {
  describeReason,
  dismissUxError,
  getUxErrors,
  reportUxError,
  subscribeUxErrors,
} from './errorReporter';

let now = 1_000_000;

beforeEach((context) => {
  // A top-level beforeEach runs once per test with that test's context.
  const t = context as TestContext;
  now += 60_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Local diagnostics must not make requests');
  });
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
  for (const error of getUxErrors()) dismissUxError(error.id);
});

test('publishes failures locally without a session or a mounted subscriber', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  reportUxError('  接口 prompt 调用失败：Permission denied  ');
  const errors = getUxErrors();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, '接口 prompt 调用失败：Permission denied');
  assert.deepEqual(log.mock.calls[0].arguments, ['[cockpit] local error:', errors[0].message]);
  assert.equal(getUxErrors(), errors);
  assert.ok(Object.isFrozen(errors));
  assert.ok(Object.isFrozen(errors[0]));
});

test('subscribers observe reports and dismissals and can unsubscribe', (t) => {
  const snapshots: (readonly { id: number; message: string }[])[] = [];
  const unsubscribe = subscribeUxErrors(() => snapshots.push(getUxErrors()));
  t.after(unsubscribe);
  reportUxError('First failure');
  reportUxError('Second failure');
  const firstSnapshot = snapshots[0];
  dismissUxError(firstSnapshot[0].id);
  assert.deepEqual(snapshots.map((errors) => errors.map((error) => error.message)), [
    ['First failure'], ['First failure', 'Second failure'], ['Second failure'],
  ]);
  assert.equal(firstSnapshot.length, 1);
  const current = getUxErrors();
  dismissUxError(-1);
  assert.equal(getUxErrors(), current);
  unsubscribe();
  reportUxError('After unsubscribe');
  assert.equal(snapshots.length, 3);
});

test('deduplicates whitespace variants for 30 seconds, including after dismissal', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  reportUxError('Same\n failure');
  dismissUxError(getUxErrors()[0].id);
  now += 29_999;
  reportUxError(' Same failure ');
  assert.equal(getUxErrors().length, 0);
  assert.equal(log.mock.callCount(), 1);
  now += 1;
  reportUxError('Same failure');
  assert.equal(getUxErrors().length, 1);
  assert.equal(log.mock.callCount(), 2);
});

test('does not suppress distinct API failures arriving together or sharing a long prefix', () => {
  const prefix = 'API validation failure: '.repeat(10);
  reportUxError(`${prefix}one`);
  reportUxError(`${prefix}two`);
  assert.deepEqual(getUxErrors().map((error) => error.message), [`${prefix}one`, `${prefix}two`]);
});

test('global notices are always deduplicated, so a repeated ownerless failure appears once', () => {
  reportUxError('Same operation failed');
  reportUxError('Same operation failed');
  assert.equal(getUxErrors().length, 1);
});

test('bounds visible notifications and duplicate history during an error storm', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  for (let i = 0; i < 51; i++) reportUxError(`Failure ${i}`);
  assert.deepEqual(getUxErrors().map((error) => error.message), ['Failure 48', 'Failure 49', 'Failure 50']);
  reportUxError('Failure 50');
  assert.equal(log.mock.callCount(), 51);
  reportUxError('Failure 0');
  assert.equal(log.mock.callCount(), 52);
  assert.equal(getUxErrors().length, 3);
});

test('ignores empty input and bounds long diagnostics without constructing commands', () => {
  const empty = getUxErrors();
  reportUxError(' \n ');
  assert.equal(getUxErrors(), empty);
  reportUxError('x'.repeat(2_000));
  assert.equal(getUxErrors()[0].message, `${'x'.repeat(1_500)}…（已截断）`);
});

test('isolates throwing observers and blocks reentrant reporting during publication and dismissal', (t) => {
  t.after(subscribeUxErrors(() => {
    reportUxError('Observer recursion');
    throw new Error('Observer failure');
  }));
  let updates = 0;
  t.after(subscribeUxErrors(() => { updates++; }));
  assert.doesNotThrow(() => reportUxError('Original failure'));
  assert.deepEqual(getUxErrors().map((error) => error.message), ['Original failure']);
  assert.equal(updates, 1);
  assert.doesNotThrow(() => dismissUxError(getUxErrors()[0].id));
  assert.equal(getUxErrors().length, 0);
  assert.equal(updates, 2);
  reportUxError('Next failure');
  assert.equal(getUxErrors()[0].message, 'Next failure');
});

test('console failures and recursive logging cannot suppress or multiply notifications', (t) => {
  const log = t.mock.method(console, 'error', () => {
    reportUxError('Console recursion');
    throw new Error('Broken console');
  });
  let updates = 0;
  t.after(subscribeUxErrors(() => { updates++; }));
  assert.doesNotThrow(() => reportUxError('Visible despite logging failure'));
  assert.equal(log.mock.callCount(), 1);
  assert.equal(updates, 1);
  assert.equal(getUxErrors()[0].message, 'Visible despite logging failure');
  assert.doesNotThrow(() => reportUxError('Still working'));
  assert.equal(updates, 2);
});

test('observer registration during notification does not cause an unbounded dispatch', (t) => {
  const added: number[] = [];
  const unsubscribe = subscribeUxErrors(() => {
    t.after(subscribeUxErrors(() => { added.push(1); }));
  });
  t.after(unsubscribe);
  reportUxError('Register observer');
  assert.equal(added.length, 0);
  unsubscribe();
  reportUxError('Notify added observer');
  assert.equal(added.length, 1);
});

test('invalid runtime inputs never escape or leave reporting locked', () => {
  for (const value of [null, undefined, 42, { trim() { throw new Error('Bad input'); } }]) {
    assert.doesNotThrow(() => reportUxError(value as unknown as string));
  }
  assert.equal(getUxErrors().length, 0);
  reportUxError('Valid after invalid input');
  assert.equal(getUxErrors().length, 1);
});

test('preserves readable Error, structured rejection and primitive diagnostics', () => {
  const error = new Error('Failed');
  error.stack = 'Error: Failed\none\ntwo\nthree\nfour';
  assert.equal(describeReason(error, false), 'Failed');
  assert.equal(describeReason(error), 'Failed\nError: Failed\none\ntwo\nthree');
  assert.equal(describeReason({ error: 'Denied', status: 403 }), '{"error":"Denied","status":403}');
  assert.equal(describeReason(null), 'null');
  assert.equal(describeReason(undefined), 'undefined');
  assert.equal(describeReason(42), '42');
  const circular = { message: 'Circular rejection', name: 'Failure', self: {} };
  circular.self = circular;
  assert.equal(describeReason(circular), 'Circular rejection (Failure)');
});
