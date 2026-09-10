import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeChatPage, NativeChatRead, SubagentInfo } from '@cockpit/protocol';
import { createSubagentHistory } from './subagentHistory';

const summary: SubagentInfo = { toolCallId: 'spawn', agentId: 'agent', name: 'explore', displayName: 'Explorer', status: 'running' };
function setup(info = summary) {
  const connection = { connState: 'open', connectionGeneration: 1 };
  const calls: { query: NativeChatRead; signal?: AbortSignal; resolve: (page: NativeChatPage) => void; reject: (error: Error) => void }[] = [];
  const resource = createSubagentHistory('session', info, (query, signal) => new Promise((resolve, reject) => {
    calls.push({ query, signal, resolve, reject });
  }), () => connection);
  const reply = (index: number, ids: string[], hasMore = true) => calls[index].resolve({
    sessionId: 'session', source: 'live', direction: 'backward',
    events: ids.map(id => ({ id: `event-${id}`, type: 'assistant.message', agentId: 'agent',
      data: { messageId: id, content: id }, timestamp: 1 })),
    cursor: `older-${index}`, cursorStatus: 'ok', hasMore, read: { rpc: 1, events: ids.length },
  });
  const ids = () => resource.getSnapshot().data?.messages.map(message => message.id);
  return { resource, calls, connection, reply, ids };
}

test('closed child detail never reads; opening selects exact native agent IDs without a task-list query', async () => {
  const h = setup();
  assert.equal(await h.resource.refresh(), false);
  assert.equal(h.calls.length, 0);
  h.resource.activate();
  const pending = h.resource.refresh();
  assert.deepEqual(h.calls[0].query, {
    sessionId: 'session', source: 'live', direction: 'backward', agentIds: ['agent', 'spawn'],
    max: 8, waitMs: 0, bootstrap: false,
  });
  h.reply(0, ['tail']);
  assert.equal(await pending, true);
  assert.deepEqual(h.ids(), ['tail']);
  assert.equal(h.calls.length, 1);
  assert.equal('subagent' in h.resource.getSnapshot().data!, false, 'no invented current task status');
});

test('child details keep the loader until a tool result and its owning message are assembled', async () => {
  const h = setup();
  h.resource.activate();
  const pending = h.resource.refresh();
  h.calls[0].resolve({
    sessionId: 'session', source: 'live', direction: 'backward',
    events: [{ id: 'tool-result', type: 'tool.execution_complete', agentId: 'agent', timestamp: 1,
      data: { toolCallId: 'tool', success: true, result: { content: 'finished' } } }],
    cursor: 'older-result', cursorStatus: 'ok', hasMore: true, read: { rpc: 1, events: 1 },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.resource.getSnapshot().pending, true);
  assert.equal(h.resource.getSnapshot().data, undefined);
  assert.equal(h.calls[1].query.cursor, 'older-result');
  assert.deepEqual(h.calls[1].query.agentIds, ['agent', 'spawn']);
  h.calls[1].resolve({
    sessionId: 'session', source: 'live', direction: 'backward',
    events: [{ id: 'owner-event', type: 'assistant.message', agentId: 'agent', timestamp: 1,
      data: { messageId: 'owner', content: 'Running', toolRequests: [{ toolCallId: 'tool', name: 'bash' }] } }],
    cursor: 'older-owner', cursorStatus: 'ok', hasMore: true, read: { rpc: 1, events: 1 },
  });
  assert.equal(await pending, true);
  assert.equal(h.resource.getSnapshot().data?.incompleteBoundary, false);
  assert.equal(h.resource.getSnapshot().data?.messages[0].toolCalls?.[0].output, 'finished');
});

test('older child pages prepend and only explicit refresh replaces the detail window', async () => {
  const h = setup();
  h.resource.activate();
  const first = h.resource.refresh(); h.reply(0, ['c', 'd']); await first;
  const older = h.resource.loadOlder();
  assert.equal(h.calls[1].query.cursor, 'older-0');
  h.reply(1, ['a', 'b'], false); await older;
  assert.deepEqual(h.ids(), ['a', 'b', 'c', 'd']);
  assert.equal(await h.resource.loadOlder(), false);
  const refresh = h.resource.refresh();
  assert.equal(h.calls[2].query.cursor, undefined);
  h.reply(2, ['e'], false); await refresh;
  assert.deepEqual(h.ids(), ['e']);
});

test('failed older child read retains content and explicit retry uses the same cursor', async () => {
  const h = setup();
  h.resource.activate();
  const first = h.resource.refresh(); h.reply(0, ['tail']); await first;
  const older = h.resource.loadOlder();
  assert.equal(await h.resource.refresh(), false, 'no trailing automatic refresh');
  h.calls[1].reject(new Error('unavailable'));
  assert.equal(await older, false);
  assert.deepEqual(h.ids(), ['tail']);
  assert.equal(h.calls.length, 2);
  const retry = h.resource.retry();
  assert.equal(h.calls[2].query.cursor, h.calls[1].query.cursor);
  h.reply(2, ['older'], false); await retry;
  assert.deepEqual(h.ids(), ['older', 'tail']);
});

for (const reason of ['close', 'generation', 'offline'] as const) {
  test(`${reason} discards an obsolete child response without starting another read`, async () => {
    const h = setup();
    h.resource.activate();
    const pending = h.resource.refresh();
    if (reason === 'close') h.resource.deactivate();
    else if (reason === 'generation') h.connection.connectionGeneration++;
    else h.connection.connState = 'connecting';
    h.reply(0, ['obsolete']);
    assert.equal(await pending, false);
    assert.equal(h.resource.getSnapshot().data, undefined);
    assert.equal(h.calls.length, 1);
  });
}

test('missing native child identifiers report an error instead of scanning a whole session', async () => {
  const h = setup({ name: 'legacy', displayName: 'Legacy', status: 'completed' });
  h.resource.activate();
  assert.equal(await h.resource.refresh(), false);
  assert.match(h.resource.getSnapshot().error ?? '', /原生子代理标识/);
  assert.equal(h.calls.length, 0);
});
