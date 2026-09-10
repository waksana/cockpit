import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { autoNameQuestion, firstNamingReply, generatedTitle } from './auto-name.ts';

type Read = CopilotSession['rpc']['eventLog']['read'];
const envelope = { timestamp: '2026-09-10T00:00:00Z', parentId: null };
const context = (length: number): SessionEvent[] => Array.from({ length }, (_, index) => ({
  ...envelope, id: `context-${index}`, type: 'user.message', data: { content: 'Prior context' },
}));
const reply = (id = 'first'): SessionEvent[] => [
  { ...envelope, id: `${id}-start`, type: 'assistant.turn_start', data: { turnId: id } },
  { ...envelope, id: `${id}-message`, type: 'assistant.message', data: { messageId: id, content: 'Effective reply' } },
  { ...envelope, id: `${id}-end`, type: 'assistant.turn_end', data: { turnId: id } },
];

function reader(t: TestContext, events: SessionEvent[]) {
  let offset = 0;
  let cursor: string | undefined;
  const read = t.mock.fn<Read>(async params => {
    assert.deepEqual(params, {
      cursor, direction: 'forward', max: Math.min(32, 1000 - offset),
      agentScope: 'primary', includeEphemeral: false,
      types: ['assistant.turn_start', 'assistant.message', 'assistant.turn_end', 'tool.execution_start',
        'user.message', 'abort', 'session.error'],
    });
    const page = events.slice(offset, offset + params.max!);
    offset += page.length;
    cursor = `opaque-next/${offset}`;
    return { events: page, cursor, cursorStatus: 'ok', hasMore: offset < events.length };
  });
  return { read, consumed: () => offset };
}

for (const position of [3, 32, 33, 64, 999, 1000]) {
  test(`first naming reply at event ${position} stops on its necessary small page`, async t => {
    const h = reader(t, [...context(position - 3), ...reply(), ...context(1000)]);
    assert.equal(await firstNamingReply(h.read), 'first-end');
    assert.equal(h.read.mock.callCount(), Math.ceil(position / 32));
    assert.equal(h.consumed(), Math.min(1000, Math.ceil(position / 32) * 32));
    assert.equal((await h.read.mock.calls.at(-1)!.result)?.hasMore, true, 'no read after the matching page');
    if (position >= 999) assert.equal(h.read.mock.calls.at(-1)!.arguments[0].max, 8);
  });
}

for (const length of [0, 1, 32, 33, 999, 1000]) {
  test(`first naming eligibility reaches the real end of ${length} ineffective events`, async t => {
    const h = reader(t, context(length));
    assert.equal(await firstNamingReply(h.read), undefined);
    assert.equal(h.read.mock.callCount(), Math.max(1, Math.ceil(length / 32)));
    assert.equal(h.consumed(), length);
  });
}

test('first naming eligibility cannot read a completion just beyond the shared 1000-event budget', async t => {
  const h = reader(t, [...context(998), ...reply().slice(1)]);
  assert.equal(await firstNamingReply(h.read), 'first-end', 'the event at 1000 is eligible');
  const beyond = reader(t, [...context(999), ...reply().slice(1)]);
  await assert.rejects(firstNamingReply(beyond.read), /exceeds the bounded native query/);
  assert.equal(beyond.read.mock.callCount(), 32);
  assert.equal(beyond.consumed(), 1000);
  assert.equal(beyond.read.mock.calls.at(-1)!.arguments[0].max, 8);
});

const resets: SessionEvent[] = [
  reply('reset')[0]!,
  ...context(1),
  { ...envelope, id: 'tool', type: 'tool.execution_start', data: { toolCallId: 'tool', toolName: 'view', arguments: {} } },
  { ...envelope, id: 'abort', type: 'abort', data: { reason: 'user_initiated' } },
  { ...envelope, id: 'error', type: 'session.error', data: { errorType: 'fixture', message: 'Interrupted' } },
  { ...envelope, id: 'blank', type: 'assistant.message', data: { messageId: 'blank', content: ' \n ' } },
  { ...envelope, id: 'tool-message', type: 'assistant.message', data: { messageId: 'tools', content: 'Not a final reply',
    toolRequests: [{ toolCallId: 'tool', name: 'view', arguments: {} }] } },
];
for (const reset of resets) {
  test(`first naming eligibility carries invalidation across a page boundary: ${reset.id}`, async t => {
    const h = reader(t, [...context(30), ...reply('invalid').slice(0, 2), reset, reply('invalid')[2]!, ...reply()]);
    assert.equal(await firstNamingReply(h.read), 'first-end');
    assert.equal(h.read.mock.callCount(), 2);
  });
}

test('first naming eligibility ignores child and ephemeral replies across pages', async t => {
  const h = reader(t, [...context(29),
    ...reply('child').map(event => ({ ...event, agentId: 'child' })),
    ...reply('ephemeral').map(event => ({ ...event, ephemeral: true })),
    ...reply('legacy-child').map(event => ({ ...event, data: { ...event.data, parentToolCallId: 'child' } })),
    ...reply()]);
  assert.equal(await firstNamingReply(h.read), 'first-end');
  assert.equal(h.read.mock.callCount(), 2);
});

for (const failure of ['expired', 'oversized', 'empty-continuation', 'short-continuation', 'missing-cursor', 'stalled-cursor', 'cyclic-cursor'] as const) {
  test(`first naming eligibility rejects ${failure} without continuation or inference`, async t => {
    let calls = 0;
    const read = t.mock.fn<Read>(async params => {
      calls++;
      const valid = { events: context(params.max!), cursor: `page-${calls}`, cursorStatus: 'ok' as const, hasMore: true };
      if (failure === 'expired') return { ...valid, events: reply(), cursorStatus: 'expired' };
      if (failure === 'oversized') return { ...valid, events: [...reply(), ...context(params.max!)] };
      if (failure === 'empty-continuation') return { ...valid, events: [] };
      if (failure === 'short-continuation') return { ...valid, events: reply() };
      if (failure === 'missing-cursor') return { ...valid, cursor: '' };
      if (failure === 'stalled-cursor' && calls === 2) return { ...valid, cursor: params.cursor! };
      if (failure === 'cyclic-cursor' && calls === 3) return { ...valid, cursor: 'page-1' };
      return valid;
    });
    await assert.rejects(firstNamingReply(read), /eligibility.*(?:unavailable|did not advance)/);
    assert.equal(calls, failure === 'stalled-cursor' ? 2 : failure === 'cyclic-cursor' ? 3 : 1);
  });
}

test('first naming eligibility propagates a later read failure without retrying or restarting its cursor', async t => {
  const h = reader(t, context(100));
  const error = new Error('Native page RPC failed');
  h.read.mock.mockImplementationOnce(async () => { throw error; }, 1);
  await assert.rejects(firstNamingReply(h.read), thrown => thrown === error);
  assert.equal(h.read.mock.callCount(), 2);
});

test('generated titles are plain, bounded Unicode without truncation or surrogate corruption', () => {
  for (const title of ['对话自动命名实现验证', 'Native conversation naming', '🧪'.repeat(32)]) {
    assert.equal(generatedTitle(` ${title} `), title);
  }
  for (const invalid of ['', ' \n ', 'a'.repeat(33), '🧪'.repeat(33), 'two\nlines', 'two\r lines',
    'null\0byte', '\ud800', '\udc00', 'title\u2028next', '```title```', '"quoted title"', '标题：自动命名']) {
    assert.throws(() => generatedTitle(invalid), { code: 'AUTO_NAME_INVALID_TITLE', statusCode: 502 });
  }
  assert.match(autoNameQuestion, /language of the conversation/);
  assert.match(autoNameQuestion, /ONLY the title/);
});
