import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSession } from '../net/types';
import { Thread } from './Thread';
import { useCockpit } from '../net/store';
import { getSessionDraft } from '../lib/textDraft';
import { getDraftSession } from '../lib/draftSelection';

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const initialState = useCockpit.getInitialState();
const previousConnection = initialState.connState;
const previousReady = initialState.snapshotReady;
before(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  initialState.connState = 'open';
  initialState.snapshotReady = true;
});
after(() => {
  initialState.connState = previousConnection;
  initialState.snapshotReady = previousReady;
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
  assert.match(html, /<button type="button" class="chat-typing-stop ck-button">[\s\S]*?停止并清空队列<\/button>/);
  assert.equal((html.match(/class="chat-typing-stop ck-button"/g) ?? []).length, 1);
});

test('Stop stays concise when the authoritative queue is empty', () => {
  assert.match(render(), /<button type="button" class="chat-typing-stop ck-button">[\s\S]*?停止<\/button>/);
  assert.doesNotMatch(render(), /停止并清空队列/);
});

test('the execution indicator follows native running status, not queued message count', () => {
  assert.match(render(), /chat-execution-label[^>]*data-running="true"[^>]*>执行中…/);
  assert.match(render({ intent: 'Reading source' }), /chat-execution-label[^>]*data-running="true"[^>]*>Reading source/);
  assert.match(render({ cancelling: true }), /chat-execution-label[^>]*data-running="true"[^>]*>正在停止…/);
  for (const status of ['idle', 'unloaded', 'error'] as const) {
    assert.doesNotMatch(render({ status, queue: [{ id: 'q', text: 'Waiting' }] }), /data-running=/);
  }
});

test('queue contents do not change the existing running and compacting visibility guards', () => {
  const queue = [{ id: 'queued', text: 'Next request' }];
  for (const status of ['idle', 'unloaded', 'error'] as const) {
    assert.doesNotMatch(render({ status, queue }), /class="chat-typing-stop ck-button"/);
  }
  assert.doesNotMatch(render({ compacting: true, queue }), /class="chat-typing-stop ck-button"/);
});

test('interrupt action keeps its context without the removed persistent hint or stale description reference', () => {
  const queue = [{ id: 'q', text: 'next' }];
  const html = render({ queue });
  assert.match(html, /打断并处理队列/);
  assert.doesNotMatch(html, /只打断主回合|后台任务继续，可能延后处理|interrupt-help|chat-execution-hint/);
  assert.match(html, /停止并清空队列/);
  assert.doesNotMatch(render(), /打断并处理队列/);
  for (const patch of [{ loaded: false }, { status: 'idle' as const }, { nativeProcessing: false },
    { cancelling: true }, { closing: true }, { loading: true }, { compacting: true }]) {
    assert.doesNotMatch(render({ queue, ...patch }), /打断并处理队列/);
  }
  assert.match(render({ queue, activeOperations: 1 }), /class="chat-interrupt ck-button" disabled=""/);
});

test('stop and interrupt share one execution action group outside the scrolling transcript', () => {
  const html = render({ intent: 'Working on the response', queue: [{ id: 'q', text: 'Next request' }] });
  const section = html.slice(html.indexOf('<details class="chat-input-card"'));
  assert.ok(section);
  const actions = section.match(/class="chat-execution-actions"[^>]*>([\s\S]+?)<\/summary>/)?.[1];
  assert.ok(actions);
  assert.match(actions, /打断并处理队列/);
  assert.match(actions, /停止并清空队列/);
  assert.match(section, /Working on the response/);
  assert.match(section, /aria-label="排队中的消息"/);
  assert.doesNotMatch(section, /chat-queue-label|排队消息 · 1/);
  assert.ok(section.indexOf('chat-execution-actions') < section.indexOf('chat-queue-item'));
  assert.doesNotMatch(html.slice(0, html.indexOf('<details class="chat-input-card"')), /chat-typing-stop|class="chat-interrupt ck-button"/);
});

test('idle queues show their messages without inventing a running operation, and read-only views have no controls', () => {
  const html = render({ status: 'idle', queue: [{ id: 'q', text: 'Next request' }] });
  assert.match(html, /<summary class="chat-queue-text" aria-label="查看排队消息：Next request">Next request<\/summary>/);
  assert.doesNotMatch(html, /queue-chevron/);
  assert.match(html, /chat-execution-label[^>]*>等待处理/);
  assert.doesNotMatch(html, /chat-execution-actions/);
  const readonly = renderToStaticMarkup(createElement(Thread, {
    session, readOnly: true, onLoadMore() {}, onCancel() {}, async onInterrupt() { return { ok: true, interrupted: true }; },
  }));
  assert.doesNotMatch(readonly, /chat-typing-stop|chat-interrupt ck-button"|chat-execution-actions/);
});

test('a pending question shares the card below its only status and action header', () => {
  const html = render({ intent: 'Generic running intent', ask: {
    requestId: 'question', question: 'Which option?', choices: ['A', 'B'], allowFreeform: true,
  } });
  const region = html.match(/<summary class="chat-execution-head"[\s\S]+?<\/summary>/)![0];
  assert.match(html, /<div class="chat-composer" data-question="true"/);
  assert.doesNotMatch(html, /class="chat-decisions"/);
  assert.ok(html.indexOf('class="chat-execution-head"') < html.indexOf('class="chat-composer"'));
  assert.ok(html.indexOf('Which option?') < html.indexOf('class="chat-input"'));
  assert.doesNotMatch(html, /chat-answer-toggle|chat-answer-chevron/);
  assert.match(html, /Which option\?/);
  assert.doesNotMatch(region, /Which option\?|class="chat-ask/);
  assert.match(region, /chat-execution-label[^>]*>等待你的回答<\/span>/);
  assert.doesNotMatch(region, /Generic running intent/);
  assert.match(region, /class="chat-typing-stop ck-button">[\s\S]*?停止/);
  assert.doesNotMatch(html, /输入内容将回答当前问题|chat-composer-hint/);
});

test('multiple native decisions stay separate from one execution/queue area', () => {
  const html = render({
    ask: { requestId: 'ask', question: 'Question?' },
    planRequest: { requestId: 'plan', summary: 'Proposed plan', actions: ['exit_only'] },
    elicitation: { requestId: 'confirm', message: 'Tool confirmation' },
  });
  assert.match(html, /Question\?/);
  assert.match(html, /Proposed plan/);
  assert.match(html, /Tool confirmation/);
  assert.equal((html.match(/class="chat-execution-head"/g) ?? []).length, 1);
  assert.equal((html.match(/class="chat-typing-stop ck-button"/g) ?? []).length, 1);
});

test('stop remains natively disabled for unavailable states and unrelated active operations', () => {
  for (const patch of [{ loaded: false }, { loading: true }, { closing: true }, { activeOperations: 1 }]) {
    assert.match(render({ ...patch, ask: { requestId: 'ask', question: 'Choose' } }),
      /class="chat-typing-stop ck-button" disabled=""/);
  }
  initialState.connState = 'connecting';
  try {
    assert.match(render(), /class="chat-typing-stop ck-button" disabled=""/);
    assert.match(render({ cancelling: true }), /class="chat-typing-stop ck-button" disabled=""/);
  }
  finally { initialState.connState = 'open'; }
});

test('native cancellation keeps its Stop target focusable while blocking repeated activation', () => {
  const html = render({ cancelling: true, activeOperations: 1 });
  const stop = html.match(/<button[^>]*class="chat-typing-stop ck-button"[^>]*>/)![0];
  assert.match(stop, /aria-disabled="true" aria-busy="true"/);
  assert.doesNotMatch(stop, / disabled=/);
  for (const patch of [{ loaded: false }, { loading: true }, { closing: true }]) {
    assert.match(render({ cancelling: true, ...patch }), /class="chat-typing-stop ck-button" disabled=""/);
  }
});

test('offline decisions, sending and queue removal are disabled without locking editable drafts or inventing pending work', () => {
  const prompt = getSessionDraft(session.sessionId);
  prompt.edit('Cached prompt is not the answer');
  const draft = getDraftSession(session.sessionId).candidate({ kind: 'ask', requestId: 'ask' });
  draft.edit('Offline draft remains editable');
  const props = {
    session: { ...session, queue: [{ id: 'q', text: 'Queued message' }],
      ask: { requestId: 'ask', question: 'Choose', choices: ['Choice'] },
      planRequest: { requestId: 'plan', summary: 'Plan', actions: ['exit_only' as const] },
      elicitation: { requestId: 'tool', message: 'Tool confirmation' } },
    onLoadMore() {}, onRemoveQueued() {}, onSend: async () => true,
    onRespondAsk: async () => true, onRespondPlan: async () => true,
    onRespondElicitation: async () => true,
  };
  const renderState = () => renderToStaticMarkup(createElement(Thread, props));
  initialState.connState = 'connecting';
  try {
    const offline = renderState();
    for (const control of offline.matchAll(/<button[^>]*class="(?:chat-ask-choice|chat-input-btn|chat-queue-remove)[^"]*"[^>]*>/g)) {
      assert.match(control[0], /disabled=""/);
    }
    assert.doesNotMatch(offline.match(/<textarea[^>]*>/)![0], /disabled/);
    assert.match(offline, /Offline draft remains editable<\/textarea>/);
    assert.doesNotMatch(offline, /Cached prompt is not the answer/);
    assert.doesNotMatch(offline, /aria-busy="true"/);
    initialState.connState = 'open';
    const online = renderState();
    for (const control of online.matchAll(/<button[^>]*class="(?:chat-ask-choice|chat-input-btn|chat-queue-remove)[^"]*"[^>]*>/g)) {
      assert.doesNotMatch(control[0], /disabled=""/);
    }
  } finally {
    initialState.connState = 'open';
    draft.edit('');
    prompt.edit('');
  }
});

test('each decision keeps queue-clearing controls outside its answer options', () => {
  const queue = [{ id: 'q', text: 'Queued text' }];
  for (const patch of [
    { ask: { requestId: 'ask', question: 'Choose', choices: ['A'] } },
    { planRequest: { requestId: 'plan', summary: 'Plan' } },
    { elicitation: { requestId: 'elicit', message: 'Confirm' } },
  ]) {
    const html = render({ queue, ...patch });
    const execution = html.match(/<summary class="chat-execution-head"[\s\S]+?<\/summary>/)![0];
    assert.match(execution, /停止并清空队列/);
    assert.match(execution, /打断并处理队列/);
    assert.match(html, /Queued text/);
    assert.doesNotMatch(execution, /class="chat-ask-choice ck-button"/);
  }
});

test('idle and read-only views do not reserve empty dock regions', () => {
  assert.doesNotMatch(render({ status: 'idle' }), /class="chat-dock"|class="chat-execution"/);
  const idleQuestion = render({ status: 'idle', ask: { requestId: 'ask', question: 'Question' } });
  assert.match(idleQuestion, /class="chat-composer" data-question="true"/);
  assert.match(render({ status: 'idle' }), /<summary class="chat-execution-head" hidden=""/);
  assert.doesNotMatch(idleQuestion, /class="chat-decisions"/);
  assert.doesNotMatch(idleQuestion, /class="chat-execution"/);
});

test('queue text has a keyboard-readable expansion with separate copy and removal actions', () => {
  const html = render({ queue: [{ id: 'q', text: 'A long queued request' }] });
  assert.match(html, /<details class="chat-queue-entry"><summary class="chat-queue-text"/);
  assert.match(html, /<\/details><div class="chat-queue-copy"><span class="chat-copy"><button type="button" class="chat-copy-button ck-button" aria-label="复制排队消息"/);
  assert.match(html, /<\/div><button type="button" class="chat-queue-remove ck-icon-button"/);
  assert.equal((html.match(/aria-label="复制排队消息"/g) ?? []).length, 1);
  assert.match(html, /placeholder="加入队列"/);
  assert.doesNotMatch(html, /发送后加入队列|chat-composer-hint/);
  assert.doesNotMatch(html, /重排|编辑排队/);
});

test('running composer uses only a queue placeholder while idle and questions keep their own semantics', () => {
  assert.match(render(), /placeholder="加入队列"/);
  assert.doesNotMatch(render(), /发送后加入队列|chat-composer-hint/);
  assert.match(render({ status: 'idle' }), /placeholder="输入消息…"/);
  assert.match(render({ ask: { requestId: 'ask', question: 'Question?' } }), /placeholder="输入回答…"/);
});

test('submitting uses an existing header without adding an idle header or duplicate progress', async () => {
  for (const patch of [
    { ask: { requestId: 'ask', question: 'Question', choices: ['A'] } },
    { planRequest: { requestId: 'plan', summary: 'Plan', actions: ['exit_only' as const] } },
    { elicitation: { requestId: 'confirm', message: 'Confirm' } },
    {},
  ]) {
    const draft = getDraftSession(session.sessionId).current({ ...session, ...patch });
    draft.edit('Retained answer');
    let finish!: (accepted: boolean) => void;
    const pending = draft.runAction(() => new Promise(resolve => { finish = resolve; }));
    try {
      const html = render(patch);
      assert.match(html, /chat-execution-label[^>]*>正在提交(?:回答)?…<\/span>/);
      assert.doesNotMatch(html, /chat-pending-hint[^>]*>正在提交|data-icon="sending"/);
      assert.match(html, /class="chat-input-btn ck-icon-button send rp" disabled="" aria-label="正在提交" aria-busy="true"/);
      if (draft.reference.purpose.kind === 'prompt') {
        const idle = render({ status: 'idle' });
        assert.match(idle, /<summary class="chat-execution-head" hidden=""/);
        assert.match(idle, /data-icon="sending"/);
        assert.doesNotMatch(idle, /data-header="true"/);
      }
    } finally {
      finish(false);
      await pending;
    }
    const failure = render(patch);
    assert.ok(failure.indexOf('chat-input-notice" role="alert"') >= 0);
    assert.ok(failure.indexOf('chat-input-notice" role="alert"') < failure.indexOf('<details class="chat-input-card"'));
    assert.match(failure, /Retained answer<\/textarea>/);
    draft.dismissNotice(); draft.edit('');
  }
});
