import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PromptAccepted } from '@cockpit/protocol';
import { harness } from '../test-support/engine-harness.ts';

test('prompt observations use actual native acceptance IDs and never include message bodies', async t => {
  const h = harness(t), accepted: PromptAccepted[] = [];
  const id = await h.engine.newSession(h.cwd), native = h.natives.get(id)!;
  const unsubscribe = h.engine.onPromptAccepted(event => { accepted.push(event); });
  const payload = 'Private synthetic content must not enter the acceptance event';
  native.sdk.send.mock.mockImplementation(async () => 'native-receipt');
  await h.engine.prompt(id, payload, 'enqueue', undefined, 'user');
  assert.equal(accepted.length, 1);
  assert.deepEqual({ ...accepted[0], acceptedAt: 0 },
    { sessionId: id, messageId: 'native-receipt', origin: 'user', acceptedAt: 0 });
  assert.ok(accepted[0]!.acceptedAt > 0);
  assert.equal(JSON.stringify(accepted).includes(payload), false);
  await h.engine.prompt(id, payload, 'enqueue', undefined, 'module');
  assert.equal(accepted[1]!.origin, 'module');
  await h.engine.prompt(id, payload);
  assert.equal(accepted[2]!.origin, 'api');
  unsubscribe();
  await h.engine.prompt(id, payload);
  assert.equal(accepted.length, 3);
});

test('failed native send has no invented acceptance, and observer errors cannot turn acceptance into a failed send', async t => {
  const h = harness(t), accepted: PromptAccepted[] = [];
  const id = await h.engine.newSession(h.cwd), native = h.natives.get(id)!;
  h.engine.onPromptAccepted(event => { accepted.push(event); throw new Error('Synthetic observer failure'); });
  native.sdk.send.mock.mockImplementation(async () => { throw new Error('Native result unknown'); });
  await assert.rejects(h.engine.prompt(id, 'Synthetic'), /Native result unknown/);
  assert.deepEqual(accepted, []);
  native.sdk.send.mock.mockImplementation(async () => 'actual-receipt');
  assert.equal((await h.engine.prompt(id, 'Synthetic')).messageId, 'actual-receipt');
  assert.equal(accepted.length, 1);
  assert.equal(native.sdk.send.mock.callCount(), 2);
});
