import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, NativeChatEvent, NativeChatRead } from '@cockpit/protocol';
import { NativeWindow } from './nativeWindow';
import { nativeCaptures } from './nativeCaptures.fixture';

function accept(window: NativeWindow, events: NativeChatEvent[], direction: 'forward' | 'backward' = 'forward') {
  const request: NativeChatRead = { sessionId: 'capture', source: direction === 'forward' ? 'live' : 'persisted',
    direction, max: 256, waitMs: 0, bootstrap: false };
  return window.accept({ sessionId: 'capture', source: request.source, direction, events, cursor: 'next',
    cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: events.length } }, request);
}
const content = (messages: ChatMessage[]) => messages.map(({ timestamp: _timestamp, ...message }) => message);

for (const capture of nativeCaptures) {
  test(`native capture ${capture.name}: every event, backward partition, duplicate and disconnect cut`, () => {
    const cold = new NativeWindow();
    const expected = accept(cold, capture.persisted, 'backward');
    assert.equal(expected.filter(message => message.thought).length,
      capture.persisted.filter(event => event.type === 'assistant.message' && event.data.reasoningText).length);
    const live = new NativeWindow();
    accept(live, []);
    for (const event of capture.notification) {
      const before = content(live.snapshot().messages);
      const messages = accept(live, [event,event]);
      assert.deepEqual(content(accept(live, [event])), content(messages), 'event IDs deduplicate');
      if (event.type === 'assistant.reasoning' && event.ephemeral) {
        assert.deepEqual(content(messages), before, 'post-message full reasoning never adds a third response');
      }
      if (event.type === 'assistant.message') {
        const response = messages.find(message => message.id === event.data.messageId);
        assert.equal(response?.content ?? '', event.data.content);
        assert.equal(response?.thought, event.data.reasoningText);
      }
    }
    assert.deepEqual(live.snapshot().messages, expected);
    for (let size = 1; size <= capture.persisted.length; size++) {
      const paged = new NativeWindow();
      for (let end = capture.persisted.length; end > 0; end -= size) {
        const page = capture.persisted.slice(Math.max(0,end-size),end);
        accept(paged,page,'backward');
        accept(paged,page,'backward');
      }
      assert.deepEqual(paged.snapshot().messages,expected, `backward page size ${size}`);
    }
    for (let partition = 0; partition < 2 ** (capture.persisted.length - 1); partition++) {
      const boundaries = [0,...capture.persisted.flatMap((_,i) => i > 0 && (partition & (1 << (i-1))) ? [i] : []),capture.persisted.length];
      const paged = new NativeWindow();
      for (let i = boundaries.length - 2; i >= 0; i--) {
        accept(paged,capture.persisted.slice(boundaries[i],boundaries[i+1]),'backward');
      }
      assert.deepEqual(paged.snapshot().messages,expected,`backward partition ${partition}`);
    }
    for (let cut = 0; cut <= capture.notification.length; cut++) {
      const resumed = new NativeWindow();
      accept(resumed,[]);
      for (const event of capture.notification.slice(0,cut)) accept(resumed,[event]);
      resumed.disconnect();
      accept(resumed,capture.persisted);
      for (const event of capture.notification.slice(cut)) accept(resumed,[event]);
      assert.deepEqual(resumed.snapshot().messages,expected,`disconnect cut ${cut}`);
      assert.equal(resumed.partial,false);
    }
  });
}

test('body-first captures keep the native body ID when later thought appears above that body', () => {
  for (const capture of nativeCaptures.filter(capture => capture.name.includes('BODY_THEN'))) {
    const window = new NativeWindow();
    accept(window,[]);
    let bodyId: string | undefined;
    for (const event of capture.notification) {
      const messages = accept(window,[event]);
      if (event.type === 'assistant.message_delta') bodyId ??= String(event.data.messageId);
      if (bodyId) assert.equal(messages.length,1);
      if (event.type === 'assistant.reasoning_delta') {
        assert.equal(messages[0].id,bodyId);
        assert.ok(messages[0].content);
        assert.ok(messages[0].thought);
      }
    }
  }
});

test('native thought disclosure keys survive message ID adoption, finalization and persisted reload', () => {
  for (const capture of nativeCaptures) {
    const window = new NativeWindow();
    accept(window,[]);
    const manualChoices = new Map<string, boolean>();
    for (const event of capture.notification) {
      for (const message of accept(window,[event])) {
        if (!message.thought) continue;
        assert.ok(message.thoughtKey, `${capture.name} has an exact response-parent reference`);
        manualChoices.set(message.thoughtKey,false);
      }
    }
    const cold = accept(new NativeWindow(),capture.persisted,'backward').filter(message => message.thought);
    assert.deepEqual([...manualChoices.keys()],cold.map(message => message.thoughtKey));
    assert.equal(manualChoices.size,cold.length,'neither native ID adoption nor finalization resets the manual choice');
  }
});

test('captured reasoning streams recover after bootstrap omits turn_start and disconnect loses full reasoning', () => {
  for (const capture of nativeCaptures) {
    const firstThought = capture.notification.findIndex(event => event.type === 'assistant.reasoning_delta');
    if (firstThought < 0) continue;
    const window = new NativeWindow();
    accept(window,[]);
    for (const event of capture.notification.slice(0,firstThought+1)) {
      if (event.type !== 'assistant.turn_start') accept(window,[event]);
    }
    assert.equal(window.snapshot().messages.filter(message => message.thought).length,1);
    window.disconnect();
    const boundedDurable = capture.persisted.filter(event => event.type !== 'assistant.turn_start');
    accept(window,boundedDurable);
    const cold = accept(new NativeWindow(),boundedDurable,'backward');
    assert.deepEqual(window.snapshot().messages,cold,capture.name);
    assert.equal(window.partial,false,capture.name);
  }
});
