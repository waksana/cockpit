import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSession } from '../net/types';
import { createSessionDrafts } from '../lib/textDraft';
import { Composer } from './Composer';
import { Thread } from './Thread';

const base: ChatSession = {
  sessionId: 'history-display', title: 'History', cwd: '/project', lastActivity: 0,
  status: 'idle', loaded: false, error: null, queue: [], ask: null,
  messages: [], materialized: false, historyStale: true, hasMore: false, loadingHistory: true,
};
const render = (overrides: Partial<ChatSession>) => renderToStaticMarkup(createElement(Thread, {
  session: { ...base, ...overrides }, readOnly: true,
  onLoadMore() { assert.fail('render must not load history'); },
  onRetryHistory() { assert.fail('render must not retry history'); },
}));

test('plan cards render only native actions in offered order, including no actions', () => {
  const plan = (actions?: NonNullable<ChatSession['planRequest']>['actions']) =>
    renderToStaticMarkup(createElement(Thread, {
      session: { ...base, planRequest: { requestId: 'plan', summary: 'Native plan', actions } },
      onLoadMore() { assert.fail('render must not read'); },
      onRespondPlan() { assert.fail('render must not respond'); },
      onPlanSupersede() { assert.fail('render must not supersede'); },
    }));
  for (const actions of [undefined, []]) {
    const html = plan(actions);
    assert.doesNotMatch(html, /开始执行（交互）|自动执行|并行执行（fleet）|仅退出计划/);
    assert.match(html, actions ? /原生未提供可用的计划操作/ : /原生计划操作列表不可用/);
    assert.match(html, /下方直接输入新指令/);
  }
  const html = plan(['exit_only', 'autopilot_fleet', 'interactive']);
  assert.ok(html.indexOf('仅退出计划') < html.indexOf('并行执行（fleet）'));
  assert.ok(html.indexOf('并行执行（fleet）') < html.indexOf('开始执行（交互）'));
  assert.doesNotMatch(html, /自动执行/);
});

test('composer keeps the input without a persistent draft-storage explanation', () => {
  const html = renderToStaticMarkup(createElement(Thread, {
    session: base, onLoadMore() { assert.fail('render must not load history'); },
  }));
  assert.match(html, /aria-label="消息输入"/);
  assert.doesNotMatch(html, /chat-draft-storage|本地草稿保存说明|新开的标签页不会自动接管原草稿/);
});

test('composer displays a dismissible notice only for unconfirmed outcomes, not normal editing or sending', async () => {
  const draft = createSessionDrafts()('composer-notice');
  const renderComposer = () => renderToStaticMarkup(createElement(Composer, {
    draft, onSend: async () => assert.fail('render must not send'),
  }));
  draft.edit('Retained input');
  assert.doesNotMatch(renderComposer(), /chat-input-notice/);
  let finish!: (accepted: boolean) => void;
  const sending = draft.send(() => new Promise(resolve => { finish = resolve; }));
  const pending = renderComposer();
  assert.match(pending, /aria-label="正在提交"/);
  assert.doesNotMatch(pending, /chat-input-notice|<textarea[^>]*disabled/);
  finish(false);
  await sending;
  const failed = renderComposer();
  assert.match(failed, /chat-input-notice" role="alert"/);
  assert.match(failed, /aria-label="关闭发送提示"/);
  assert.match(failed, /重发前请先检查会话/);
  draft.dismissNotice();
  const dismissed = renderComposer();
  assert.doesNotMatch(dismissed, /chat-input-notice/);
  assert.match(dismissed, /Retained input<\/textarea>/);
});

test('cold history loading is not presented as an empty conversation', () => {
  const html = render({});
  assert.match(html, /正在同步对话历史/);
  assert.doesNotMatch(html, /开始对话|重新读取最新历史/);
});

test('failed history remains visibly unsynchronized and offers an explicit read retry', () => {
  const html = render({ loadingHistory: false, error: '加载失败: offline' });
  assert.match(html, /对话历史尚未同步/);
  assert.match(html, /重新读取最新历史/);
  assert.doesNotMatch(html, /开始对话/);
});

test('failed reconciliation keeps cached text with an explicit latest retry, without the old range warning', () => {
  const html = render({
    materialized: true, loadingHistory: false, error: '历史同步中断，请重新读取最新历史',
    messages: [{ id: 'cached', role: 'assistant', content: 'Retained reading window', timestamp: 1 }],
  });
  assert.match(html, /Retained reading window/);
  assert.doesNotMatch(html, /无法确认原阅读范围/);
  assert.match(html, /重新读取最新历史/);
  assert.doesNotMatch(html, /开始对话|正在同步对话历史/);
});

test('only an authoritative empty history displays the new conversation hint', () => {
  const html = render({ materialized: true, historyStale: false, loadingHistory: false });
  assert.match(html, /开始对话/);
  assert.doesNotMatch(html, /尚未同步|重新读取最新历史/);
});

test('closed native child cards show summaries but neither render nor fetch inline transcripts', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Closed card must not fetch'); });
  const html = render({
    materialized: true, historyStale: false, loadingHistory: false,
    messages: [{
      id: 'card', role: 'assistant', content: '', timestamp: 1, subtype: 'subagent',
      subagent: {
        toolCallId: 'native-spawn', name: 'explore', displayName: 'Explorer', status: 'running',
        description: 'Find the implementation', prompt: 'Private full task body',
      },
      subMessages: [{ id: 'child', role: 'assistant', content: 'Large nested transcript', timestamp: 1 }],
    }],
  });
  assert.match(html, /Explorer/);
  assert.match(html, /Find the implementation/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Private full task body|Large nested transcript|正在读取子代理历史/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('child headers expose recorded execution evidence, not a guessed current task state', t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Status display must not fetch'); });
  for (const [status, label] of [
    ['running', '已启动'], ['activity', '有后续活动'], ['completed', '本次执行已结束'],
    ['failed', '失败'], ['cancelled', '已取消'], ['unknown', '未知'],
  ] as const) {
    const html = render({
      materialized: true, historyStale: false, loadingHistory: false,
      messages: [{
        id: 'card', role: 'assistant', content: '', timestamp: 1, subtype: 'subagent',
        subagent: { name: 'explore', displayName: 'Child', status },
      }],
    });
    assert.ok(html.includes(`data-status="${status}"`));
    assert.ok(html.includes(`记录：${label}`));
    assert.match(html, /待同步/);
    assert.match(html, /不代表当前仍在运行或任务目标已完成/);
    assert.doesNotMatch(html, /子代理处理中|目标已完成<\/span>/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('all loaded message content remains mounted behind stable outer geometry markers', () => {
  const messages = Array.from({ length: 120 }, (_, i) => ({
    id: `message-${i}`, role: 'assistant' as const, content: `Retained text ${i}`, timestamp: i,
  }));
  const html = render({ materialized: true, historyStale: false, loadingHistory: false, messages });
  assert.equal([...html.matchAll(/data-message-frame=/g)].length, messages.length);
  assert.equal([...html.matchAll(/data-message-id=/g)].length, messages.length);
  assert.doesNotMatch(html, /data-measured-layout|--message-height/);
  for (const message of messages) assert.ok(html.includes(message.content));
});

test('initial history has a measurement-only body while its complete initial batch is prepared', () => {
  const html = render({
    historyStale: false, materialized: false, loadingHistory: true,
    messages: [{ id: 'partial-page', role: 'assistant', content: 'Not yet a complete initial viewport', timestamp: 1 }],
  });
  assert.match(html, /chat-history-controls/);
  assert.match(html, /正在同步对话历史/);
  assert.match(html, /class="chat-message-rows" data-preparing="true" aria-hidden="true" inert=""/);
  assert.match(html, /Not yet a complete initial viewport/);
});

test('loading more history never hides an already materialized reading window', () => {
  const html = render({
    materialized: true, historyStale: false, loadingHistory: true, hasMore: true,
    messages: [{ id: 'visible', role: 'assistant', content: 'Keep this reading position', timestamp: 1 }],
  });

  test('normal history has no load button while failures keep explicit recovery', () => {
    const ready = { materialized: true, historyStale: false, loadingHistory: false, hasMore: true };
    assert.doesNotMatch(render(ready), /加载更早的历史|重试加载历史|继续补齐消息边界/);
    assert.match(render({ ...ready, historyError: 'offline' }), /历史加载失败：offline.*重试加载历史/);
    assert.doesNotMatch(render({ ...ready, incompleteBoundary: true }), /已暂停自动加载|继续补齐消息边界/);
    assert.match(render({ ...ready, hasMore: false, incompleteBoundary: true }), /现有历史无法补齐/);
  });
  assert.match(html, /加载更早的消息/);
  assert.match(html, /Keep this reading position/);
  assert.doesNotMatch(html, /data-preparing|aria-hidden="true" inert/);
});
