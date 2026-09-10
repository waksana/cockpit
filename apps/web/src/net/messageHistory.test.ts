import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeChatEvent, NativeChatPage, NativeChatRead } from '@cockpit/protocol';
import { NativeWindow } from './nativeWindow';
import { readMessageHistory } from './messageHistory';

const query: NativeChatRead = {
  sessionId: 'fixture', source: 'live', direction: 'backward',
  max: 32, waitMs: 0, bootstrap: true, agentScope: 'primary',
};
const event = (id: string, type = 'assistant.message', data: Record<string, unknown> = {}): NativeChatEvent =>
  ({ id, type, timestamp: 1, data: { messageId: id, content: id, ...data } });
const owner = event('owner', 'assistant.message', { toolRequests: [{ toolCallId: 'tool', name: 'bash' }] });
const result = event('result', 'tool.execution_complete', { toolCallId: 'tool', success: true, result: { content: 'done' } });
function setup(pages: NativeChatEvent[][], window = new NativeWindow(), hasMore = true) {
  const requests: NativeChatRead[] = [];
  const controller = new AbortController();
  const read = async (request: NativeChatRead): Promise<NativeChatPage> => {
    requests.push(request);
    const events = pages[requests.length - 1] ?? [];
    return {
      sessionId: request.sessionId, source: request.source, direction: request.direction, events,
      cursor: `older-${requests.length}`, cursorStatus: 'ok', hasMore,
      ...(request.bootstrap ? { liveCursor: 'tail-before-first' } : {}),
      read: { rpc: request.bootstrap ? 2 : 1, events: events.length },
    };
  };
  const run = (current = () => true) => readMessageHistory(window, query, read, controller.signal, current);
  return { requests, controller, window, read, run };
}

test('history follows native pages through a tool result to its owning message, preserving the first tail', async () => {
  const h = setup([[result, event('newer')], [event('start', 'tool.execution_start', { toolCallId: 'tool' })], [owner]]);
  await h.run();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests.map(request => request.cursor), [undefined, 'older-1', 'older-2']);
  assert.deepEqual(h.requests.map(request => request.bootstrap), [true, false, false]);
  assert.ok(h.requests.every(request => request.max === 32 && request.agentScope === 'primary'));
  assert.equal(h.window.live?.cursor, 'tail-before-first');
  assert.equal(h.window.snapshot().incompleteBoundary, false);
  assert.equal(h.window.snapshot().messages[0].toolCalls?.[0].output, 'done');
});

test('a message already at the page boundary needs no extra native read or tool completion wait', async () => {
  const h = setup([[owner]]);
  await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(h.window.snapshot().incompleteBoundary, false);
});

for (const name of ['skill', 'exit_plan_mode']) {
  test(`${name} ownership is retained without rendering a duplicate tool row or fetching older history`, async () => {
    const h = setup([[
      event('hidden-owner', 'assistant.message', { content: '', toolRequests: [{ toolCallId: 'hidden', name }] }),
      event('hidden-start', 'tool.execution_start', { toolCallId: 'hidden', toolName: name }),
      event('hidden-complete', 'tool.execution_complete', { toolCallId: 'hidden', success: true }),
      event('visible-reply'),
    ]]);
    await h.run();
    assert.equal(h.requests.length, 1);
    assert.equal(h.window.projection.toolMsg.get('hidden'), 'hidden-owner');
    assert.equal(h.window.snapshot().incompleteBoundary, false);
    assert.deepEqual(h.window.snapshot().messages.map(message => message.id), ['visible-reply']);
  });

  test(`${name} split across pages resolves on its hidden owner without reading an extra page`, async () => {
    const h = setup([
      [event('hidden-complete', 'tool.execution_complete', { toolCallId: 'hidden', success: true }), event('visible-reply')],
      [event('hidden-owner', 'assistant.message', { content: '', toolRequests: [{ toolCallId: 'hidden', name }] })],
    ]);
    await h.run();
    assert.equal(h.requests.length, 2);
    assert.equal(h.window.snapshot().incompleteBoundary, false);
  });
}

test('metadata-only pages continue to a display message rather than ending a history action empty', async () => {
  const h = setup([[event('idle', 'session.idle')], [event('turn', 'assistant.turn_end')], [event('message')]]);
  await h.run();
  assert.equal(h.requests.length, 3);
  assert.equal(h.window.snapshot().messages[0].id, 'message');
});

test('persisted child tool records do not make the primary view scan backward for their owners', async () => {
  const child = (index: number) => ({
    ...event(`child-${index}`, 'tool.execution_complete', {
      toolCallId: `child-tool-${index}`, parentToolCallId: 'spawn', success: true,
    }),
    agentId: 'child', parentToolCallId: 'spawn',
  });
  const h = setup([[...Array.from({ length: 31 }, (_, index) => child(index)), event('primary')]], undefined, true);
  await h.run();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.window.snapshot().messages.map(message => message.id), ['primary']);
  assert.equal(h.window.snapshot().incompleteBoundary, false);
});

test('static child starts with their own agent IDs still need the parent message boundary', async () => {
  const h = setup([
    [event('started', 'subagent.started', { toolCallId: 'spawn', agentId: 'child', agentDisplayName: 'Child' })],
    [event('parent', 'assistant.message', { toolRequests: [{ toolCallId: 'spawn', name: 'task', arguments: { description: 'Research' } }] })],
  ]);
  await h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(h.window.snapshot().incompleteBoundary, false);
  assert.equal(h.window.snapshot().messages.at(-1)?.subagent?.agentId, 'child');
});

test('filtered child histories complete their own tools without reading parent history', async () => {
  const h = setup([[{ ...result, agentId: 'child' }], [{ ...owner, agentId: 'child' }]], new NativeWindow(['child']));
  await readMessageHistory(h.window, { ...query, agentScope: undefined, agentIds: ['child'], bootstrap: false },
    h.read, h.controller.signal, () => true);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(request => request.agentIds?.[0] === 'child'));
  assert.equal(h.window.snapshot().messages[0].toolCalls?.[0].output, 'done');
});

test('unavailable parent history ends explicitly, without guessing ownership or scanning again', async () => {
  const h = setup([[result, event('newer')]], undefined, false);
  await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(h.window.hasMore, false);
  assert.equal(h.window.snapshot().incompleteBoundary, true);
});

test('a distant message boundary is completed in one action without an arbitrary page stop', async () => {
  const pages = [[result, event('newer')], ...Array.from({ length: 12 }, (_, index) => [
    event(`metadata-${index}`, 'session.info'),
  ]), [owner]];
  const h = setup(pages);
  await h.run();
  assert.equal(h.requests.length, pages.length);
  assert.equal(h.window.snapshot().incompleteBoundary, false);
  assert.equal(h.window.snapshot().messages[0].toolCalls?.[0].output, 'done');
});

test('cancellation or loss of ownership between pages prevents another read and stale acceptance', async () => {
  for (const abort of [true, false]) {
    const h = setup([[result]]);
    let current = true;
    await assert.rejects(readMessageHistory(h.window, query, async request => {
      const page = await h.read(request);
      if (abort) h.controller.abort(); else current = false;
      return page;
    }, h.controller.signal, () => current), { name: 'AbortError' });
    assert.equal(h.requests.length, 1);
    assert.equal(h.window.materialized, false);
  }
});

test('expired continuation retains already received rows and does not fetch a replacement latest page', async () => {
  const h = setup([[result, event('newer')]]);
  await assert.rejects(readMessageHistory(h.window, query, async request => {
    const page = await h.read(request);
    return h.requests.length > 1 ? { ...page, cursorStatus: 'expired' } : page;
  }, h.controller.signal, () => true), /失效/);
  assert.equal(h.requests.length, 2);
  assert.equal(h.window.snapshot().messages[0].id, 'newer');
});

test('an interleaved live message cannot make a metadata-only older page look like a completed history load', async () => {
  const h = setup([[event('metadata', 'session.info')], [event('older')]]);
  await readMessageHistory(h.window, { ...query, bootstrap: false }, async request => {
    if (!h.requests.length) {
      const forward = { ...query, direction: 'forward' as const, bootstrap: false };
      h.window.accept({
        sessionId: query.sessionId, source: query.source, direction: 'forward',
        events: [event('live')], cursor: 'live-next', cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: 1 },
      }, forward);
    }
    return h.read(request);
  }, h.controller.signal, () => true);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.window.snapshot().messages.map(message => message.id), ['older', 'live']);
});
