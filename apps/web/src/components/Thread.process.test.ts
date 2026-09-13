import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@cockpit/protocol';
import { fixtureSession } from '../dev/chat-fixtures';
import { MessageProcess, Thread } from './Thread';
import { CopyButton } from './CopyButton';

const message: ChatMessage = {
  id: 'process-message', role: 'assistant', content: '', timestamp: 1000,
  thought: 'Recorded reasoning, not a generated summary.',
  toolCalls: [
    { toolCallId: 'done', name: 'view', title: 'Read source', status: 'completed', output: 'Native output' },
    { toolCallId: 'failed', name: 'bash', title: 'Command failed', status: 'failed', output: 'Exact error output' },
    { toolCallId: 'unknown', title: 'Unknown tool state' },
  ],
};
const renderProcess = (value = message, live = false) =>
  renderToStaticMarkup(createElement(MessageProcess, { message: value, sessionId: 'fixture', live }));

test('history summarizes only this message and retains failures without mounting hidden tool bodies', t => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Process disclosure must not read history'); });
  const html = renderProcess();
  assert.match(html, /class="process-summary" aria-expanded="false"/);
  assert.match(html, /3 次工具 · 含思考/);
  assert.match(html, /1 项失败/);
  assert.match(html, /1 项状态未知/);
  assert.match(html, /<time dateTime="1970-01-01T00:00:01.000Z">/);
  assert.match(html, /class="message-process-content" hidden=""/);
  assert.doesNotMatch(html, /Native output|Exact error output|Recorded reasoning|tool-toggle|耗时/);
  const contentId = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(contentId && html.includes(`id="${contentId}"`));
});

test('live records start open and completed tools do not repeat their visual status', () => {
  const html = renderProcess(message, true);
  assert.match(html, /class="process-summary" aria-expanded="true"/);
  assert.match(html, /Recorded reasoning/);
  assert.equal((html.match(/class="activity-head tool-head tool-toggle"/g) ?? []).length, 3);
  assert.match(html, /展开细节：Read source · 已完成/);
  assert.doesNotMatch(html, /class="activity-status">已完成/);
  assert.match(html, /class="activity-status">失败/);
  assert.match(html, /class="activity-status">状态未知/);
});

test('thought-only and incomplete states have literal summaries, never invented counts or success', () => {
  const thought = renderProcess({ ...message, toolCalls: [] });
  assert.match(thought, /process-summary-title">思考过程/);
  assert.doesNotMatch(thought, /0 次工具|1 次思考|已完成/);
  for (const [status, summary] of [
    ['in_progress', '1 项执行中'], ['pending', '1 项待执行'], [undefined, '1 项状态未知'],
  ] as const) {
    const html = renderProcess({ ...message, thought: undefined, toolCalls: [{ toolCallId: 'one', title: 'Tool', status }] });
    assert.ok(html.includes(summary));
    assert.doesNotMatch(html, /含思考|已完成/);
  }
});

test('different native messages keep separate groups; blank answers create no body or copy controls', () => {
  const session = fixtureSession('empty');
  session.messages = [
    message,
    { ...message, id: 'next', content: ' \n ', thought: undefined, toolCalls: message.toolCalls?.slice(0, 1) },
    { ...message, id: 'blank', content: '\n  ' },
    { id: 'empty', role: 'assistant', content: '', timestamp: 1001 },
  ];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.equal((html.match(/class="process-summary"/g) ?? []).length, 3);
  assert.equal((html.match(/data-message-frame=/g) ?? []).length, 4);
  assert.equal((html.match(/data-message-id=/g) ?? []).length, 4);
  assert.doesNotMatch(html, /class="message-body"|class="message-actions"|复制消息|doc-byline/);
  assert.match(html, /data-message-frame="empty" data-empty="true"/);
});

test('formal text stays visible outside the process with compact text-only copy', () => {
  const session = fixtureSession('empty');
  session.messages = [{ ...message, content: '  Actual answer, unchanged.  ' }];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.match(html, /class="message-body"/);
  assert.match(html, /Actual answer, unchanged/);
  assert.match(html, /class="message-actions" data-role="assistant"><span class="chat-copy is-text">/);
  const copy = renderToStaticMarkup(createElement(CopyButton, { text: '  Exact original text  ', label: '复制消息', textOnly: true }));
  assert.match(copy, /aria-label="复制消息"/);
  assert.match(copy, /role="status"/);
  assert.doesNotMatch(copy, /tgico|data-icon/);
  const defaultCopy = renderToStaticMarkup(createElement(CopyButton, { text: 'code', label: '复制代码' }));
  assert.match(defaultCopy, /data-icon="file"/);
});
