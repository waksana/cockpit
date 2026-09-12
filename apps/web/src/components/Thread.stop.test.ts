import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSession } from '../net/types';
import { Thread } from './Thread';

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
before(() => { Object.defineProperty(globalThis, 'window', { configurable: true, value: {} }); });
after(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const session: ChatSession = {
  sessionId: 'stop-label', title: 'Stop label', cwd: '/fixture', lastActivity: 0,
  status: 'running', loaded: true, error: null, queue: [], ask: null,
  messages: [], materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
};

function render(patch: Partial<ChatSession> = {}) {
  return renderToStaticMarkup(createElement(Thread, {
    session: { ...session, ...patch },
    onLoadMore() { assert.fail('Rendering must not load history'); },
    onCancel() { assert.fail('Rendering must not cancel'); },
    async onInterrupt() { assert.fail('Rendering must not interrupt'); },
  }));
}

test('Stop exposes queue-clearing semantics in visible text and its native accessible name', () => {
  const html = render({ queue: [{ id: 'queued', text: 'Next request' }] });
  assert.match(html, /<button type="button" class="chat-typing-stop">停止并清空队列<\/button>/);
  assert.equal((html.match(/class="chat-typing-stop"/g) ?? []).length, 1);
});

test('Stop stays concise when the authoritative queue is empty', () => {
  assert.match(render(), /<button type="button" class="chat-typing-stop">停止<\/button>/);
  assert.doesNotMatch(render(), /停止并清空队列/);
});

test('queue contents do not change the existing running and compacting visibility guards', () => {
  const queue = [{ id: 'queued', text: 'Next request' }];
  for (const status of ['idle', 'unloaded', 'error'] as const) {
    assert.doesNotMatch(render({ status, queue }), /class="chat-typing-stop"/);
  }
  assert.doesNotMatch(render({ compacting: true, queue }), /class="chat-typing-stop"/);
});

test('interrupt action is contextual to a loaded running queue and describes background work', () => {
  const queue = [{ id: 'q', text: 'next' }];
  const html = render({ queue });
  assert.match(html, /打断并继续/);
  assert.match(html, /保留队列；后台任务继续，可能延后处理/);
  assert.match(html, /aria-describedby="interrupt-help-stop-label"/);
  assert.match(html, /停止并清空队列/);
  assert.doesNotMatch(render(), /打断并继续/);
  for (const patch of [{ loaded: false }, { status: 'idle' as const }, { nativeProcessing: false },
    { cancelling: true }, { closing: true }, { loading: true }, { compacting: true }]) {
    assert.doesNotMatch(render({ queue, ...patch }), /打断并继续/);
  }
  assert.match(render({ queue, activeOperations: 1 }), /disabled="" aria-describedby="interrupt-help-stop-label"/);
});

test('stop and interrupt share one execution action group outside the scrolling transcript', () => {
  const html = render({ intent: 'Working on the response', queue: [{ id: 'q', text: 'Next request' }] });
  const section = html.match(/<section class="chat-execution"[\s\S]+?<\/section>/)?.[0];
  assert.ok(section);
  const actions = section.match(/class="chat-execution-actions"[^>]*>([\s\S]+?)<\/div>/)?.[1];
  assert.ok(actions);
  assert.match(actions, /打断并继续/);
  assert.match(actions, /停止并清空队列/);
  assert.match(section, /Working on the response/);
  assert.match(section, /排队消息 · 1/);
  assert.ok(section.indexOf('chat-execution-actions') < section.indexOf('chat-queue-item'));
  assert.doesNotMatch(html.slice(0, html.indexOf('<section class="chat-execution"')), /chat-typing-stop|class="chat-interrupt"/);
});

test('idle queues show their messages without inventing a running operation, and read-only views have no controls', () => {
  const html = render({ status: 'idle', queue: [{ id: 'q', text: 'Next request' }] });
  assert.match(html, /chat-execution-label[^>]*>排队中的消息/);
  assert.doesNotMatch(html, /chat-execution-actions/);
  const readonly = renderToStaticMarkup(createElement(Thread, {
    session, readOnly: true, onLoadMore() {}, onCancel() {}, async onInterrupt() { return { ok: true, interrupted: true }; },
  }));
  assert.doesNotMatch(readonly, /chat-typing-stop|chat-interrupt"|chat-execution-actions/);
});
