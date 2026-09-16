import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@cockpit/protocol';
import { fixtureSession } from '../dev/chat-fixtures';
import { MessageProcess, Thread } from './Thread';
import { CopyButton } from './CopyButton';
import { groupTranscript } from '../lib/transcriptRows';

const message: ChatMessage = { id: 'body', role: 'assistant', content: '', timestamp: 1000 };
const items: ChatMessage[] = [
  { ...message, id: 'thought', thought: 'Recorded reasoning, not a generated summary.' },
  ...[
    { toolCallId: 'done', name: 'view', title: 'Read source', status: 'completed' as const, output: 'Native output' },
    { toolCallId: 'failed', name: 'bash', title: 'Command failed', status: 'failed' as const, output: 'Exact error output' },
    { toolCallId: 'unknown', title: 'Unknown tool state' },
  ].map(tool => ({ ...message, id: tool.toolCallId, toolCalls: [tool] })),
];
const renderProcess = (value = items, latest = false) =>
  renderToStaticMarkup(createElement(MessageProcess, {
    items: groupTranscript(value).flatMap(row => row.kind === 'process' ? row.items : []), sessionId: 'fixture', latest,
  }));

test('older overview summarizes consecutive items and retains failures without mounting hidden tool bodies', t => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Process disclosure must not read history'); });
  const html = renderProcess();
  assert.match(html, /class="process-summary" aria-expanded="false"/);
  assert.match(html, /3 次工具调用 · 1 次思考/);
  assert.match(html, /1 项失败/);
  assert.match(html, /1 项状态未知/);
  assert.match(html, /<time dateTime="1970-01-01T00:00:01.000Z" title="[^"]+" aria-label="[^"]+">/);
  assert.match(html, /class="message-process-content" hidden=""/);
  assert.doesNotMatch(html, /Native output|Exact error output|Recorded reasoning|tool-toggle|耗时/);
  const contentId = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(contentId && html.includes(`id="${contentId}"`));
});

test('latest overview starts open even when idle and completed tools do not repeat their visual status', () => {
  const html = renderProcess(items, true);
  assert.match(html, /class="process-summary" aria-expanded="true"/);
  assert.doesNotMatch(html, /Recorded reasoning/);
  assert.match(html, /class="activity-head thought-toggle" aria-expanded="false"/);
  assert.equal((html.match(/class="activity-head tool-head tool-toggle"/g) ?? []).length, 3);
  assert.match(html, /展开细节：view · Read source · 已完成/);
  assert.doesNotMatch(html, /class="activity-status"/);
  assert.match(html, /class="tool-state-icon" data-status="failed"/);
  assert.match(html, /class="tool-state-icon" data-status="unknown"/);
});

test('reasoning opens by default only when it is the latest visible item, not the latest thought', () => {
  const session = fixtureSession('empty');
  for (const next of [
    items[1],
    { ...message, id: 'reply', content: 'New assistant reply' },
    { ...message, id: 'request', role: 'user' as const, content: 'New user request' },
  ]) {
    session.messages = [items[0], next];
    const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
    assert.doesNotMatch(html, /class="activity-detail msg-thought"/);
    assert.match(html, /class="activity-head thought-toggle" aria-expanded="false"/);
  }
  session.messages = [items[1], items[0]];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.match(html, /class="activity-detail msg-thought">Recorded reasoning/);
});

test('response reasoning is placed before its body without a provisional region or repeated content', () => {
  const session = fixtureSession('empty');
  session.messages = [
    items[0], items[1],
    { ...message, id: 'response', content: 'Visible body', thought: 'Associated thinking' },
  ];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.equal((html.match(/class="process-summary"/g) ?? []).length, 1);
  assert.match(html, /1 次工具调用 · 2 次思考/);
  assert.doesNotMatch(html, /provisional|待完整记录/);
  assert.match(html, /Visible body/);
  assert.ok(html.indexOf('2 次思考') < html.indexOf('Visible body'));
  assert.doesNotMatch(html, /class="activity-detail msg-thought"/);
});

test('thought-only and incomplete states have literal counts, never invented success or duration', () => {
  const thought = renderProcess([items[0], { ...items[0], id: 'second-thought' }]);
  assert.match(thought, /process-summary-title">2 次思考/);
  assert.doesNotMatch(thought, /0 次工具|已完成|耗时/);
  for (const [status, summary] of [
    ['in_progress', '1 项执行中'], ['pending', '1 项待执行'], [undefined, '1 项状态未知'],
  ] as const) {
    const html = renderProcess([{ ...message, toolCalls: [{ toolCallId: 'one', title: 'Tool', status }] }]);
    assert.ok(html.includes(summary));
    assert.doesNotMatch(html, /含思考|已完成/);
  }
});
test('unsupported reasoning association stays visible as uncertainty even while its text is collapsed', () => {
  const html = renderProcess([{ ...items[0], incomplete: '缺少可确认的原生响应引用，未猜测归属。' }], true);
  assert.match(html, /思考归属未确认/);
  assert.match(html, /role="status">缺少可确认的原生响应引用/);
});

test('consecutive process items share an overview and blank bodies do not create a boundary or space', () => {
  const session = fixtureSession('empty');
  session.messages = [
    ...items,
    { ...message, id: 'blank', content: '\n  ' }, { ...message, id: 'empty' },
    { ...items[0], id: 'second-thought' },
  ];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.equal((html.match(/class="process-summary"/g) ?? []).length, 1);
  assert.equal((html.match(/data-message-frame=/g) ?? []).length, 1);
  assert.match(html, /3 次工具调用 · 2 次思考/);
  assert.doesNotMatch(html, /class="message-body"|class="message-actions"|复制消息|doc-byline|data-message-id="empty"/);
});

test('formal text stays visible outside the process without a whole-message copy footer', () => {
  const session = fixtureSession('empty');
  session.messages = [...items, { ...message, content: '  Actual answer, unchanged.  ' }];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.match(html, /class="message-body"/);
  assert.match(html, /Actual answer, unchanged/);
  assert.doesNotMatch(html, /class="message-actions"|aria-label="复制消息"/);
  const copy = renderToStaticMarkup(createElement(CopyButton, { text: '  Exact original code  ', label: '复制代码' }));
  assert.match(copy, /aria-label="复制代码"/);
  assert.match(copy, /role="status"/);
  assert.match(copy, /data-icon="file"/);
});

test('speech boundaries split consecutive process with no extra round or message hierarchy', () => {
  const session = fixtureSession('empty');
  session.messages = [items[0], { ...message, content: 'Before the tool', id: 'speech' },
    items[1], { ...message, role: 'user', content: 'Next request', id: 'user' }, items[2]];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.equal((html.match(/class="process-summary"/g) ?? []).length, 3);
  assert.equal((html.match(/class="process-summary" aria-expanded="true"/g) ?? []).length, 1);
  assert.equal((html.match(/class="process-summary" aria-expanded="false"/g) ?? []).length, 2);
  assert.ok(html.indexOf('1 次思考') < html.indexOf('Before the tool'));
  assert.ok(html.indexOf('Before the tool') < html.indexOf('1 次工具调用'));
  assert.doesNotMatch(html, /第.*轮|含思考|耗时/);
});
