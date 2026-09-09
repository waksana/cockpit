import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { SubagentHistoryPage } from '@cockpit/protocol';
import { createSubagentHistory, type ChildHistoryOptions } from './subagentHistory';

const message = (id: string, content = id) => ({ id, content, role: 'assistant' as const, timestamp: 1 });
function page(ids: string[], changes: Partial<SubagentHistoryPage> = {}): SubagentHistoryPage {
  return {
    sessionId: 'session', toolCallId: 'native-spawn', messages: ids.map((id) => message(id)), hasMore: true, latest: true,
    subagent: { toolCallId: 'native-spawn', name: 'explore', displayName: 'Explorer', status: 'running', prompt: 'Full task' },
    ...changes,
  };
}
function setup() {
  const connection = { connState: 'open', connectionGeneration: 1 };
  const calls: { sessionId: string; toolCallId: string; options: ChildHistoryOptions; signal: AbortSignal;
    resolve: (value: SubagentHistoryPage) => void; reject: (reason: unknown) => void }[] = [];
  const resource = createSubagentHistory('session', 'native-spawn', (sessionId, toolCallId, options, signal) =>
    new Promise((resolve, reject) => { calls.push({ sessionId, toolCallId, options, signal, resolve, reject }); }), () => connection);
  return { resource, calls, connection };
}

test('closed child resource never reads; opening reads only this exact native child, 30 at a time', async () => {
  const { resource, calls } = setup();
  assert.equal(await resource.refresh(), false);
  assert.equal(calls.length, 0);
  resource.activate();
  const pending = resource.refresh();
  assert.equal(resource.getSnapshot().pending, true);
  assert.equal(calls[0].sessionId, 'session');
  assert.equal(calls[0].toolCallId, 'native-spawn');
  assert.deepEqual(calls[0].options, { limit: 30 });
  const nested = { ...message('nested-card'), subtype: 'subagent' as const,
    subagent: { name: 'explore', displayName: 'Nested', status: 'running' as const, toolCallId: 'nested-native' } };
  calls[0].resolve(page(['tail'], { messages: [nested, message('tail')] }));
  assert.equal(await pending, true);
  assert.equal(resource.getSnapshot().data?.subagent.prompt, 'Full task');
  assert.equal(resource.getSnapshot().data?.messages[0], nested);
  assert.equal(calls.length, 1, 'nested summaries must not start child requests');
});

test('older pages prepend once; refresh replaces only the authoritative suffix without dropping loaded scrollback', async () => {
  const { resource, calls } = setup();
  resource.activate();
  const first = resource.refresh();
  calls[0].resolve(page(['c', 'd']));
  await first;
  const older = resource.loadOlder();
  assert.deepEqual(calls[1].options, { beforeMsgId: 'c', limit: 30 });
  calls[1].resolve(page(['a', 'b', 'c'], { latest: false, hasMore: false }));
  await older;
  assert.deepEqual(resource.getSnapshot().data?.messages.map((m) => m.id), ['a', 'b', 'c', 'd']);
  const refresh = resource.refresh();
  assert.deepEqual(calls[2].options, { afterMsgId: 'd', limit: 30 });
  calls[2].resolve(page(['d', 'e'], { latest: false, append: true }));
  await refresh;
  assert.deepEqual(resource.getSnapshot().data?.messages.map((m) => m.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(resource.getSnapshot().data?.hasMore, false);
});

test('failed older page retains content and retry uses its original cursor, without automatic retry', async () => {
  const { resource, calls } = setup();
  resource.activate();
  const first = resource.refresh();
  calls[0].resolve(page(['anchor']));
  await first;
  const older = resource.loadOlder();
  void resource.refresh();
  calls[1].reject(new Error('disk unavailable'));
  assert.equal(await older, false);
  await setImmediate();
  assert.equal(calls.length, 2);
  assert.equal(resource.getSnapshot().error, 'disk unavailable');
  assert.deepEqual(resource.getSnapshot().data?.messages.map((m) => m.id), ['anchor']);
  const retry = resource.retry();
  assert.deepEqual(calls[2].options, { beforeMsgId: 'anchor', limit: 30 });
  calls[2].resolve(page(['older'], { latest: false }));
  assert.equal(await retry, true);
});

test('refresh beyond one page replaces the child window rather than silently bridging a gap', async () => {
  const { resource, calls } = setup();
  resource.activate();
  const first = resource.refresh();
  calls[0].resolve(page(['previous-anchor']));
  await first;
  const refresh = resource.refresh();
  assert.deepEqual(calls[1].options, { afterMsgId: 'previous-anchor', limit: 30 });
  const latest = Array.from({ length: 30 }, (_, i) => `new-${i + 20}`);
  calls[1].resolve(page(latest, { latest: true, hasMore: true }));
  await refresh;
  assert.deepEqual(resource.getSnapshot().data?.messages.map(message => message.id), latest);
  assert.equal(resource.getSnapshot().data?.hasMore, true);
  const older = resource.loadOlder();
  assert.deepEqual(calls[2].options, { beforeMsgId: 'new-20', limit: 30 });
  calls[2].resolve(page(['new-19'], { latest: false, hasMore: true }));
  await older;
  assert.equal(resource.getSnapshot().data?.messages[0].id, 'new-19');
});

test('meaningful changes coalesce during one open read and stop after a single trailing refresh', async () => {
  const { resource, calls } = setup();
  resource.activate();
  const first = resource.refresh();
  for (let i = 0; i < 20; i++) void resource.refresh();
  assert.equal(calls.length, 1);
  calls[0].resolve(page(['anchor']));
  await first;
  assert.equal(calls.length, 2);
  calls[1].resolve(page(['anchor', 'new'], { latest: false, append: true }));
  await setImmediate();
  assert.equal(calls.length, 2, 'successful reads cannot trigger a perpetual fetch loop');
});

for (const outcome of ['success', 'error'] as const) {
  test(`collapse aborts and releases all child payload; late ${outcome} cannot repopulate or refresh`, async () => {
    const { resource, calls } = setup();
    resource.activate();
    const first = resource.refresh();
    calls[0].resolve(page(['loaded']));
    await first;
    const older = resource.loadOlder();
    void resource.refresh();
    resource.deactivate(true);
    assert.equal(calls[1].signal.aborted, true);
    assert.equal(resource.getSnapshot().data, undefined);
    if (outcome === 'success') calls[1].resolve(page(['late'], { latest: false }));
    else calls[1].reject(new Error('late failure'));
    assert.equal(await older, false);
    assert.equal(resource.getSnapshot().data, undefined);
    assert.equal(resource.getSnapshot().error, null);
    assert.equal(calls.length, 2);
    resource.activate();
    const reopened = resource.refresh();
    assert.deepEqual(calls[2].options, { limit: 30 });
    calls[2].resolve(page(['fresh']));
    assert.equal(await reopened, true);
  });
}

test('reconnect retains visible child history but ignores requests from the previous connection', async () => {
  const { resource, calls, connection } = setup();
  resource.activate();
  const first = resource.refresh();
  calls[0].resolve(page(['anchor']));
  await first;
  const old = resource.loadOlder();
  connection.connState = 'connecting';
  connection.connectionGeneration++;
  resource.deactivate();
  assert.equal(resource.getSnapshot().data?.messages[0].id, 'anchor');
  connection.connState = 'open';
  resource.activate();
  const fresh = resource.refresh();
  calls[2].resolve(page(['anchor', 'current'], { latest: false, append: true }));
  await fresh;
  calls[1].resolve(page(['obsolete'], { latest: false }));
  assert.equal(await old, false);
  assert.deepEqual(resource.getSnapshot().data?.messages.map((m) => m.id), ['anchor', 'current']);
});

for (const wrong of [{ sessionId: 'other' }, { toolCallId: 'other' }, { append: true, latest: false }] as const) {
  test(`invalid child identity or append cursor preserves prior data: ${JSON.stringify(wrong)}`, async () => {
    const { resource, calls } = setup();
    resource.activate();
    const first = resource.refresh();
    calls[0].resolve(page(['anchor']));
    await first;
    const refresh = resource.refresh();
    calls[1].resolve(page(['wrong'], wrong));
    assert.equal(await refresh, false);
    assert.deepEqual(resource.getSnapshot().data?.messages.map((m) => m.id), ['anchor']);
    assert.ok(resource.getSnapshot().error);
  });
}
