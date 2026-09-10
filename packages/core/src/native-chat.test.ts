import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEvent, CopilotClient, CopilotSession } from '@github/copilot-sdk';
import { NativeChatRead } from '@cockpit/protocol';
import { readNativeChat, CHAT_EVENT_TYPES } from './native-chat.ts';

type Passive = CopilotClient['rpc']['sessions']['readPersistedEvents'];
type Live = CopilotSession['rpc']['eventLog'];
const q = (extra: Record<string, unknown> = {}) => NativeChatRead.parse({ sessionId: 'fixture', ...extra });
const event = (id: string, content = id): SessionEvent => ({
  id, parentId: null, timestamp: '2026-09-10T00:00:00.000Z',
  type: 'assistant.message', data: { messageId: id, content },
});
const result = (events: SessionEvent[], extra = {}) => ({
  events, cursor: 'native-next', hasMore: false, cursorStatus: 'ok' as const, ...extra,
});
const unused = async (): Promise<never> => { throw new Error('Unexpected native method'); };
const live = (read: Live['read'], tail: Live['tail'] = async () => ({ cursor: 'native-tail' })): Live =>
  ({ read, tail, registerInterest: unused, releaseInterest: unused });

test('cold and repeated latest reads request exactly one native bounded page without cache or prewarm', async () => {
  const events = Array.from({ length: 60_000 }, (_, i) => event(`m${i}`, `Synthetic response ${i}`));
  const calls: Parameters<Passive>[0][] = [];
  const persisted: Passive = async params => {
    calls.push(params);
    return result(events.slice(-params.max!), { hasMore: true });
  };
  for (let i = 0; i < 2; i++) {
    const page = await readNativeChat(q(), { persisted });
    assert.equal(page.events.length, 64);
    assert.deepEqual(page.read, { rpc: 1, events: 64 });
    assert.equal(page.events[0].id, 'm59936');
  }
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({
    sessionId: 'fixture', cursor: undefined, max: 64, direction: 'backward',
  })));
});

test('older reads pass the original opaque cursor without locating message IDs or scanning other pages', async () => {
  const calls: Parameters<Passive>[0][] = [];
  const persisted: Passive = async params => { calls.push(params); return result([event('older')]); };
  const page = await readNativeChat(q({ cursor: 'opaque/backward/page', max: 17 }), { persisted });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cursor, 'opaque/backward/page');
  assert.equal(calls[0].max, 17);
  assert.equal(page.cursor, 'native-next');
});

test('bootstrap captures a separate forward tail before the backward read and never reverses that cursor', async () => {
  const calls: string[] = [];
  const log = live(async params => {
    calls.push('read');
    assert.equal(params.direction, 'backward');
    assert.equal(params.cursor, undefined);
    return result([event('a'), event('b-appended-after-tail')]);
  }, async () => { calls.push('tail'); return { cursor: 'forward-position' }; });
  const page = await readNativeChat(q({ source: 'live', bootstrap: true }), { persisted: unused, live: log });
  assert.deepEqual(calls, ['tail', 'read']);
  assert.equal(page.liveCursor, 'forward-position');
  assert.equal(page.cursor, 'native-next');
  assert.deepEqual(page.read, { rpc: 2, events: 2 });
});

test('live child and type selection is passed to native rather than applied after a whole-session read', async () => {
  const calls: Parameters<Live['read']>[0][] = [];
  const log = live(async params => { calls.push(params); return result([]); });
  await readNativeChat(q({
    source: 'live', direction: 'forward', cursor: 'known', max: 1,
    agentIds: ['child', 'legacy-tool'], types: ['assistant.message'], includeEphemeral: false, waitMs: 1000,
  }), { persisted: unused, live: log });
  assert.deepEqual(calls, [{
    cursor: 'known', max: 1, direction: 'forward', waitMs: 1000, includeEphemeral: false,
    types: ['assistant.message'], agentScope: 'all', agentIds: ['child', 'legacy-tool'],
  }]);
});

test('expired cursor results remain explicitly expired, with no hidden fallback read', async () => {
  let calls = 0;
  const persisted: Passive = async () => {
    calls++;
    return { ...result([event('newest')]), cursorStatus: 'expired' };
  };
  const page = await readNativeChat(q({ cursor: 'gone' }), { persisted });
  assert.equal(page.cursorStatus, 'expired');
  assert.equal(calls, 1);
});

test('unloaded live reads cannot create or activate a native session', async () => {
  await assert.rejects(readNativeChat(q({ source: 'live' }), { persisted: unused }),
    error => error instanceof Error && 'code' in error && error.code === 'SESSION_UNLOADED');
});

test('abort after tail prevents the history read; abort after read prevents stale delivery', async () => {
  const controller = new AbortController();
  const log = live(unused, async () => { controller.abort(); return { cursor: 'tail' }; });
  await assert.rejects(readNativeChat(q({ source: 'live', bootstrap: true }),
    { persisted: unused, live: log }, controller.signal), /abort/i);
  const second = new AbortController();
  await assert.rejects(readNativeChat(q(), { persisted: async () => {
    second.abort(); return result([]);
  } }, second.signal), /abort/i);
});

test('chat omits internal image bytes and locators without mutating or rereading the native result', async () => {
  const image: SessionEvent = {
    id: 'image', type: 'tool.execution_complete', timestamp: '2026-09-10T00:00:00.000Z', parentId: null,
    data: { toolCallId: 'view', success: true,
      result: { content: 'Synthetic image', binaryResultsForLlm: [{ type: 'image', mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM/////w8AH+4F+7C4l8kAAAAASUVORK5CYII=' }] } },
  };
  const delta: SessionEvent = {
    id: 'delta', type: 'assistant.message_delta', timestamp: '2026-09-10T00:00:00.000Z',
    parentId: null, ephemeral: true, data: { messageId: 'running', deltaContent: 'temporary' },
  };
  const page = await readNativeChat(q({
    source: 'live', direction: 'forward', cursor: 'before-image', agentIds: ['child'], max: 4,
  }), { persisted: unused, live: live(async () => result([event('a'), delta, image])) });
  assert.equal(page.read.rpc, 1);
  assert.equal(Object.hasOwn(page.events[2], 'images'), false);
  assert.doesNotMatch(JSON.stringify(page), /iVBOR|binaryResultsForLlm/);
  assert.match(JSON.stringify(image), /iVBOR/);
});

test('native page bounds and nonadvancing continuation fail explicitly', async () => {
  await assert.rejects(readNativeChat(q({ max: 1 }), {
    persisted: async () => result([event('a'), event('b')]),
  }), /bound/);
  await assert.rejects(readNativeChat(q({ cursor: 'same' }), {
    persisted: async () => result([event('a')], { cursor: 'same', hasMore: true }),
  }), /advance/);
  await assert.rejects(readNativeChat(q({}), {
    persisted: async () => result([], { cursor: '', hasMore: true }),
  }), /advance/);
  assert.ok(CHAT_EVENT_TYPES.includes('assistant.message_start'));
});
