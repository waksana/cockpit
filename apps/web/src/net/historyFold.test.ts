import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeChatEvent, NativeChatPage, NativeChatRead } from '@cockpit/protocol';
import type { FoldState } from '@cockpit/protocol/chat';
import { NativeWindow } from './nativeWindow';

const event = (id: string, type = 'assistant.message', data: Record<string, unknown> = {}, agentId?: string): NativeChatEvent =>
  ({ id, type, timestamp: 1, data: { messageId: id, content: id, ...data }, ...(agentId ? { agentId } : {}) });
const query = (direction: 'backward' | 'forward' = 'backward'): NativeChatRead => ({
  sessionId: 'isolated-fold', source: 'live', direction, max: 32, waitMs: 0,
  agentScope: 'all', bootstrap: false,
});
function accept(window: NativeWindow, events: NativeChatEvent[], direction: 'backward' | 'forward' = 'backward', extra: Partial<NativeChatPage> = {}) {
  const request = query(direction);
  return window.accept({
    sessionId: request.sessionId, source: request.source, direction, events,
    cursor: `${direction}-${events[0]?.id ?? 'empty'}`, hasMore: true, cursorStatus: 'ok',
    read: { rpc: 1, events: events.length }, ...extra,
  }, request);
}
function counted() {
  const window = new NativeWindow(undefined, true);
  let count = 0;
  const project = Reflect.get(window, 'project');
  Object.defineProperty(window, 'project', {
    value: (...args: unknown[]) => { count++; return Reflect.apply(project, window, args); },
  });
  return { window, count: () => count };
}
const task = (id: string, toolCallId: string, agentId?: string) => event(id, 'assistant.message', {
  toolRequests: [{ name: 'task', toolCallId, arguments: { description: toolCallId } }],
}, agentId);
const spawn = (toolCallId: string, agentId: string) =>
  event(`spawn-${toolCallId}`, 'subagent.started', { toolCallId, agentId });

function compare(window: NativeWindow, history: NativeChatEvent[]) {
  const baseline = counted();
  accept(baseline.window, history);
  assert.deepEqual(window.snapshot().messages, baseline.window.snapshot().messages);
  assert.equal(window.unresolved, baseline.window.unresolved);
  const state = (fold: FoldState): unknown => ({
    ...fold, executionOrder: undefined, currentModelId: fold.currentModelId, streamingId: fold.streamingId,
    pendingReasoning: fold.pendingReasoning, reasoningId: fold.reasoningId, reasoningIds: fold.reasoningIds,
    subFolds: new Map([...fold.subFolds].map(([id, child]) => [id, state(child)])),
  });
  assert.deepEqual(state(window.projection), state(baseline.window.projection));
  return baseline.count();
}

test('execution status survives every page split, duplicate start, and later child turns without extra projection scans', () => {
  const history = [
    task('owner', 'spawn'), spawn('spawn', 'child'),
    event('done', 'subagent.completed', { toolCallId: 'spawn' }),
    event('repeated-start', 'subagent.started', { toolCallId: 'spawn' }, 'child'),
    event('followup', 'user.message', { content: 'Next turn' }, 'child'),
    event('turn', 'assistant.turn_start', { turnId: '0' }, 'child'),
    event('tool-owner', 'assistant.message', { toolRequests: [{ name: 'view', toolCallId: 'view' }] }, 'child'),
    event('failed-tool', 'tool.execution_complete', { toolCallId: 'view', success: false }, 'child'),
    event('failed', 'subagent.failed', { toolCallId: 'spawn', error: 'Child failure' }),
    event('later-message', 'assistant.message', { content: 'Continued execution' }, 'child'),
    event('cancel', 'subagent.completed', { toolCallId: 'spawn', cancelled: true }),
  ];
  for (let length = 3; length <= history.length; length++) {
    for (let split = 1; split < length; split++) {
      const window = new NativeWindow(undefined, true);
      accept(window, history.slice(split, length));
      accept(window, history.slice(0, split));
      compare(window, history.slice(0, length));
      const before = window.snapshot().messages;
      accept(window, [history[1]], 'forward', { hasMore: false });
      assert.equal(window.snapshot().messages, before, 'duplicate old start cannot overwrite later evidence');
    }
  }
});

test('repeated independent prepends fold each event once, equivalent to cumulative full replay', t => {
  for (const [size, length] of [[1, 128], [7, 512], [32, 4096]]) {
    const events = Array.from({ length }, (_, i) => event(`not-sorted-${length - i}`));
    const incremental = counted();
    let referenceCost = 0;
    for (let end = length; end > 0;) {
      const start = Math.max(0, end - size);
      const old = incremental.window.snapshot().messages;
      accept(incremental.window, events.slice(start, end));
      referenceCost += compare(incremental.window, events.slice(start));
      if (old.length) assert.equal(incremental.window.snapshot().messages.at(-1), old.at(-1));
      end = start;
    }
    assert.equal(incremental.count(), length);
    if (length === 4096) assert.equal(referenceCost, 264_192);
    t.diagnostic(`page=${size}, events=${length}, incremental=${incremental.count()}, full-refold=${referenceCost}`);
    const view = incremental.window.snapshot().messages;
    const cost = incremental.count();
    accept(incremental.window, []);
    accept(incremental.window, [events[0], events[0]]);
    assert.equal(incremental.window.snapshot().messages, view);
    assert.equal(incremental.count(), cost);
  }
});

test('every page split agrees with chronological replay across nested owners, tools, aliases and turn scratch', () => {
  const history = [
    event('u0', 'user.message'),
    event('r0', 'assistant.reasoning', { reasoningId: 'root-0', content: 'First thought' }),
    event('r1', 'assistant.reasoning', { reasoningId: 'root-1', content: 'Second thought' }),
    task('parent', 'outer'),
    spawn('outer', 'child'),
    event('child-r', 'assistant.reasoning', { reasoningId: 'cr', content: 'Child thought' }, 'child'),
    event('child-message', 'assistant.message', {
      toolRequests: [{ name: 'bash', toolCallId: 'bash', arguments: { command: 'echo synthetic' } }],
    }, 'child'),
    event('bash-start', 'tool.execution_start', { toolCallId: 'bash' }),
    task('child-task', 'inner', 'child'),
    spawn('inner', 'nested'),
    event('nested-r', 'assistant.reasoning', { reasoningId: 'nr', content: 'Nested pending' }, 'nested'),
    event('nested-end', 'assistant.turn_end', {}, 'nested'),
    event('nested-message', 'assistant.message', { messageId: 'shared' }, 'nested'),
    event('root-message', 'assistant.message', { messageId: 'shared' }),
    { ...event('aliased-message', 'assistant.message', {}, 'new-alias'), parentToolCallId: 'outer' },
    event('bash-result', 'tool.execution_complete', { toolCallId: 'bash', result: { content: 'Synthetic output' } }),
    event('ask-owner', 'assistant.message', { toolRequests: [{ name: 'ask_user', toolCallId: 'ask' }] }, 'nested'),
    event('ask-start', 'tool.execution_start', { toolCallId: 'ask', toolName: 'ask_user' }, 'nested'),
    event('ask-result', 'tool.execution_complete', { toolCallId: 'ask', result: { content: 'User selected: yes' } }, 'nested'),
    event('nested-done', 'subagent.completed', { toolCallId: 'inner', totalToolCalls: 1 }),
    event('child-done', 'subagent.completed', { toolCallId: 'outer', totalToolCalls: 3 }),
    event('u1', 'user.message'),
    event('only-thought', 'assistant.reasoning', { reasoningId: 'alone', content: 'Reason only' }),
    event('end1', 'session.idle'),
    event('u2', 'user.message'),
    event('answer2'),
  ];
  for (let size = 1; size <= history.length; size++) {
    const window = new NativeWindow(undefined, true);
    for (let end = history.length; end > 0;) {
      const start = Math.max(0, end - size);
      accept(window, history.slice(start, end));
      try { compare(window, history.slice(start)); }
      catch (error) { throw new Error(`page size=${size}, start=${start}`, { cause: error }); }
      end = start;
    }
  }
});

test('a distant owner repairs only its dependents amid interleaved durable forward updates', t => {
  const incremental = counted();
  const history: NativeChatEvent[] = [
    task('parent', 'outer'), spawn('outer', 'child'),
    event('child-owner', 'assistant.message', { toolRequests: [{ name: 'bash', toolCallId: 'bash' }] }, 'child'),
    event('child-result', 'tool.execution_complete', { toolCallId: 'bash', result: { content: 'done' } }, 'child'),
    ...Array.from({ length: 256 }, (_, i) => event(`old-${i}`)),
  ];
  let loaded: NativeChatEvent[] = [];
  let referenceCost = 0;
  for (let end = history.length; end > 0;) {
    const start = Math.max(0, end - 7);
    loaded = [...history.slice(start, end), ...loaded];
    accept(incremental.window, history.slice(start, end));
    referenceCost += compare(incremental.window, loaded);
    const live = event(`live-${end}`);
    loaded.push(live);
    accept(incremental.window, [live, live], 'forward', { hasMore: false });
    compare(incremental.window, loaded);
    if (end % 2) {
      incremental.window.disconnect();
      accept(incremental.window, [], 'forward', { hasMore: false });
    }
    end = start;
  }
  assert.ok(incremental.count() <= loaded.length + 4);
  t.diagnostic(`interleaved events=${loaded.length}, incremental=${incremental.count()}, full-refold=${referenceCost}`);
});

test('partial reasoning and child messages survive older pages, overlap, disconnect and final replacement', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [task('parent', 'outer'), spawn('outer', 'child'), event('stable')]);
  accept(window, [], 'forward', { hasMore: false });
  const ephemeral = (id: string, type: string, data: Record<string, unknown>) =>
    ({ ...event(id, type, data, 'child'), ephemeral: true });
  accept(window, [ephemeral('thought', 'assistant.reasoning_delta', { reasoningId: 'r', deltaContent: 'Live thought' })], 'forward', { hasMore: false });
  accept(window, [event('older-thought', 'assistant.reasoning', { reasoningId: 'old', content: 'Older thought' })]);
  accept(window, [
    ephemeral('start', 'assistant.message_start', { messageId: 'live' }),
    ephemeral('prefix', 'assistant.message_delta', { messageId: 'live', deltaContent: 'Prefix' }),
  ], 'forward', { hasMore: false });
  const child = () => window.snapshot().messages.find(message => message.subagent)?.subMessages;
  assert.equal(child()?.find(message => message.id === 'reasoning-r')?.thought, 'Live thought');
  assert.equal(child()?.at(-1)?.content, 'Prefix');
  accept(window, [event('older')]);
  window.disconnect();
  accept(window, [], 'forward', { hasMore: false });
  accept(window, [ephemeral('suffix', 'assistant.message_delta', { messageId: 'live', deltaContent: 'Lost suffix' })], 'forward', { hasMore: false });
  assert.equal(window.partial, true);
  assert.equal(child()?.at(-1)?.content, 'Prefix');
  const final = event('final', 'assistant.message', { messageId: 'live', content: 'Whole response', reasoningText: 'Whole thought' }, 'child');
  accept(window, [final, final], 'forward', { hasMore: false });
  assert.equal(child()?.at(-1)?.content, 'Whole response');
  assert.equal(child()?.find(message => message.thought)?.thought, 'Whole thought');
  assert.equal(child()?.filter(message => message.thought).length, 1);
  assert.equal(child()?.at(-1)?.thought, undefined);
  assert.equal(window.partial, false);
});

test('open durable reasoning heads are repaired while independent live reasoning remains intact', () => {
  const window = new NativeWindow(undefined, true);
  const thoughts = Array.from({ length: 12 }, (_, i) =>
    event(`thought-${i}`, 'assistant.reasoning', { reasoningId: `r-${i}`, content: `Thought ${i}` }));
  for (let i = thoughts.length - 1; i >= 0; i--) {
    accept(window, [thoughts[i]]);
    compare(window, thoughts.slice(i));
  }
  accept(window, [event('answer')], 'forward', { hasMore: false });
  compare(window, [...thoughts, event('answer')]);

  const live = new NativeWindow(undefined, true);
  accept(live, [], 'forward', { hasMore: false });
  accept(live, [{ ...event('live-thought', 'assistant.reasoning_delta', {
    reasoningId: 'live-r', deltaContent: 'Unpublished live thought',
  }), ephemeral: true }], 'forward', { hasMore: false });
  accept(live, [thoughts[0]]);
  accept(live, [event('live-answer')], 'forward', { hasMore: false });
  assert.equal(live.snapshot().messages.find(message => message.id === 'reasoning-live-r')?.thought, 'Unpublished live thought');
  assert.equal(live.snapshot().messages.at(-1)?.thought, undefined);
});

test('filtered child reasoning uses the normalized root lane across old page boundaries', () => {
  const window = new NativeWindow(['child']);
  accept(window, [event('answer', 'assistant.message', {}, 'child')]);
  accept(window, [event('reason-2', 'assistant.reasoning', { reasoningId: 'r2', content: 'Second' }, 'child')]);
  accept(window, [event('reason-1', 'assistant.reasoning', { reasoningId: 'r1', content: 'First' }, 'child')]);
  assert.deepEqual(window.snapshot().messages.map(message => message.thought), ['First', 'Second', undefined]);
  assert.equal(window.unresolved, false);
});

test('bootstrap adoption appends only beyond native overlap despite filtered entries and duplicate events', () => {
  const window = counted();
  const old = event('old');
  accept(window.window, [old], 'backward', { hasMore: true });
  const older = window.window.older;
  const request = { ...query(), bootstrap: true };
  const fresh = event('fresh');
  window.window.accept({
    sessionId: request.sessionId, source: 'live', direction: 'backward', cursor: 'adopted-old',
    liveCursor: 'captured-tail', cursorStatus: 'ok', hasMore: true,
    events: [event('ignored', 'session.start'), old, fresh, fresh], read: { rpc: 2, events: 4 },
  }, request);
  assert.equal(window.count(), 2);
  assert.equal(window.window.older, older);
  assert.equal(window.window.live?.cursor, 'captured-tail');
  accept(window.window, [old], 'forward', { hasMore: true });
  accept(window.window, [event('older')]);
  accept(window.window, [fresh, event('last')], 'forward', { hasMore: false });
  assert.deepEqual(window.window.snapshot().messages.map(message => message.id), ['older', 'old', 'fresh', 'last']);
  assert.equal(window.count(), 4);
});

test('unrelated sibling messages sharing a canonical ID are not reprojected during owner repair', () => {
  const window = counted();
  accept(window.window, [
    task('root-task', 'child-task'), spawn('child-task', 'child'),
    event('child-final', 'assistant.message', { messageId: 'same' }, 'child'),
  ]);
  const card = window.window.snapshot().messages.at(-1);
  const before = window.count();
  accept(window.window, [event('root-final', 'assistant.message', { messageId: 'same' })]);
  assert.equal(window.count() - before, 1);
  assert.equal(window.window.snapshot().messages.at(-1), card);
});

test('an alias introduced in the incoming older page repairs retained alias-only messages', () => {
  const introduction = { ...event('introduction', 'assistant.message', {}, 'alias'), parentToolCallId: 'spawn' };
  const history = [
    task('parent', 'spawn'), spawn('spawn', 'legacy'), introduction,
    event('retained', 'assistant.message', {}, 'alias'),
  ];
  for (let size = 1; size <= history.length; size++) {
    const window = new NativeWindow(undefined, true);
    for (let end = history.length; end > 0;) {
      const start = Math.max(0, end - size);
      accept(window, history.slice(start, end));
      compare(window, history.slice(start));
      end = start;
    }
    assert.deepEqual(window.snapshot().messages.at(-1)?.subMessages?.map(message => message.id), ['introduction', 'retained']);
    assert.equal(window.unresolved, false);
  }
});

test('reasoning-only rows retain each native anchor when older distinct blocks prepend', () => {
  for (const boundary of ['assistant.turn_end', 'user.message', 'abort', 'session.idle']) {
    const window = new NativeWindow(undefined, true);
    const thoughts = Array.from({ length: 8 }, (_, i) =>
      event(`thought-${i}`, 'assistant.reasoning', { reasoningId: `r-${i}`, content: `Thought ${i}` }));
    const end = event('boundary', boundary);
    accept(window, [thoughts.at(-1)!, end, event('following')]);
    const anchorId = window.snapshot().messages[0].id;
    for (let i = thoughts.length - 2; i >= 0; i--) {
      accept(window, [thoughts[i]]);
      compare(window, [...thoughts.slice(i), end, event('following')]);
      assert.equal(window.snapshot().messages.filter(message => message.id === anchorId).length, 1);
      assert.equal(window.snapshot().messages.filter(message => message.thought).length, thoughts.length - i);
    }
  }
});

test('nested lifecycle-flushed reasoning records its order and updates ancestors during repair', () => {
  const history = [
    task('parent', 'outer'), spawn('outer', 'child'),
    task('child-task', 'inner', 'child'), spawn('inner', 'nested'),
    event('r1', 'assistant.reasoning', { reasoningId: 'r1', content: 'First' }, 'nested'),
    event('r2', 'assistant.reasoning', { reasoningId: 'r2', content: 'Second' }, 'nested'),
    event('complete', 'subagent.completed', { toolCallId: 'inner' }),
    event('following', 'assistant.message', {}, 'nested'),
    event('outer-complete', 'subagent.completed', { toolCallId: 'outer' }),
  ];
  for (let size = 1; size <= history.length; size++) {
    const window = new NativeWindow(undefined, true);
    for (let end = history.length; end > 0;) {
      const start = Math.max(0, end - size);
      accept(window, history.slice(start, end));
      compare(window, history.slice(start));
      end = start;
    }
  }
});

test('unknown ephemeral owners survive ring eviction as identities, not a retained delta log', () => {
  const window = new NativeWindow(undefined, true);
  accept(window, [], 'forward', { hasMore: false });
  accept(window, [{ ...event('unknown-start', 'assistant.message_start', { messageId: 'partial' }, 'child'), ephemeral: true }],
    'forward', { hasMore: false });
  for (let i = 0; i < 300; i++) {
    accept(window, [{ ...event(`delta-${i}`, 'assistant.reasoning_delta', {
      reasoningId: 'r', deltaContent: 'Unowned fragment',
    }, 'child'), ephemeral: true }], 'forward', { hasMore: false });
  }
  assert.equal(window.unresolved, true);
  assert.equal(window.retainedEventCount, 256);
  accept(window, []);
  assert.equal(window.unresolved, true);
  window.disconnect();
  accept(window, [task('parent', 'spawn'), spawn('spawn', 'child')]);
  assert.equal(window.unresolved, false);
  assert.equal(window.partial, true);
  assert.deepEqual(window.snapshot().messages.at(-1)?.subMessages, []);
  accept(window, [event('final', 'assistant.message', { messageId: 'partial' }, 'child')], 'forward', { hasMore: false });
  assert.equal(window.partial, false);
});

test('repeated aliased child pages wait for their owner without repeatedly folding the unresolved window', t => {
  const history = [
    task('parent', 'spawn'), spawn('spawn', 'child'),
    ...Array.from({ length: 512 }, (_, i) => ({
      ...event(`child-${i}`, 'assistant.message', {}, 'child'), parentToolCallId: 'spawn',
    })),
  ];
  const incremental = counted();
  let referenceCost = 0;
  for (let end = history.length; end > 0;) {
    const start = Math.max(0, end - 32);
    accept(incremental.window, history.slice(start, end));
    referenceCost += compare(incremental.window, history.slice(start));
    if (start) assert.equal(incremental.count(), history.length - start);
    end = start;
  }
  assert.equal(incremental.count(), 1026);
  assert.equal(incremental.window.snapshot().messages.at(-1)?.subMessages?.length, 512);
  t.diagnostic(`aliased child events=${history.length}, incremental=${incremental.count()}, full-refold=${referenceCost}`);
});
