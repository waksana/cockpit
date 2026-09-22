import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@cockpit/protocol';
import { fixtureSession } from '../dev/chat-fixtures';
import { MessageProcess, Thread } from './Thread';
import { CopyButton } from './CopyButton';
import { groupTranscript } from '../lib/transcriptRows';
import { ToolCallRow } from './ToolCallRow';
import { PlanCard, ElicitationCard } from './PendingDecision';

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

test('classic process rows and decision cards share activity semantic icons', () => {
  for (const [name, icon] of [['bash', 'shell'], ['functions.read_bash', 'shell_output'], ['task', 'agent'],
    ['read_agent', 'agent_result'], ['view', 'read_file'], ['ask_user', 'decision']] as const) {
    const html = renderToStaticMarkup(createElement(ToolCallRow, {
      sessionId: 'fixture', tc: { toolCallId: name, name, title: name, status: 'completed' },
    }));
    assert.match(html, new RegExp(`data-icon="${icon}"`));
    assert.match(html, /data-icon="success"/, 'execution outcome remains independent of tool kind');
  }
  for (const html of [
    renderToStaticMarkup(createElement(PlanCard, { request: { requestId: 'plan', summary: 'Plan' }, pending: false, onSelect() {} })),
    renderToStaticMarkup(createElement(ElicitationCard, { request: { requestId: 'tool', message: 'Confirm' }, pending: false, onSelect() {} })),
  ]) assert.match(html, /data-icon="decision"/);
  assert.match(renderToStaticMarkup(createElement(Thread, {
    session: fixtureSession('process'), readOnly: true, onLoadMore() {},
  })), /class="subagent-ico"><span class="ck-icon" data-icon="agent"/);
});

test('skill and thought icons stay distinct without changing process grouping or disclosure', () => {
  const skill: ChatMessage = { ...message, id: 'skill', subtype: 'skill', content: 'fixture-skill' };
  const html = renderProcess([skill, ...items], true);
  assert.equal((html.match(/class="process-summary ck-button"/g) ?? []).length, 1);
  assert.match(html, /3 次工具调用 · 1 次思考 · Skill · fixture-skill/);
  assert.match(html, /class="activity-head skill-activity"><span class="activity-icon"><span class="ck-icon" data-icon="skills"/);
  assert.match(html, /class="activity-head ck-button thought-toggle" aria-expanded="false"[^>]*><span class="activity-icon"><span class="ck-icon" data-icon="thought"/);
  assert.match(html, /lucide-book-open/);
  assert.match(html, /lucide-lightbulb/);
  assert.ok(html.indexOf('data-icon="skills"') < html.indexOf('data-icon="thought"'));
  for (const latest of [false, true]) {
    const single = renderProcess([skill], latest);
    assert.match(single, /process-summary-title">Skill · fixture-skill/);
    assert.ok(single.includes(`class="process-summary ck-button" aria-expanded="${latest}"`));
    assert.equal(single.includes('class="activity-head skill-activity"'), latest);
  }
});

test('older overview summarizes consecutive items and retains failures without mounting hidden tool bodies', t => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Process disclosure must not read history'); });
  const html = renderProcess();
  assert.match(html, /class="process-summary ck-button" aria-expanded="false"/);
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
  assert.match(html, /class="process-summary ck-button" aria-expanded="true"/);
  assert.doesNotMatch(html, /Recorded reasoning/);
  assert.match(html, /class="activity-head ck-button thought-toggle" aria-expanded="false"/);
  assert.equal((html.match(/class="activity-head tool-head tool-toggle ck-button"/g) ?? []).length, 3);
  assert.match(html, /展开细节：view · Read source · 已完成/);
  assert.doesNotMatch(html, /class="activity-status"/);
  assert.match(html, /data-status="failed" class="ck-icon tool-state-icon"/);
  assert.match(html, /data-status="unknown" class="ck-icon tool-state-icon"/);
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
    assert.match(html, /class="activity-head ck-button thought-toggle" aria-expanded="false"/);
  }
  session.messages = [items[1], items[0]];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.match(html, /class="activity-detail msg-thought"><div class="message-body"><p class="markdown-paragraph">Recorded reasoning/);
});

test('thought content uses the shared Markdown renderer without changing its original text', () => {
  const session = fixtureSession('thought-markdown');
  const original = session.messages[0].thought;
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.match(html, /class="activity-detail msg-thought"><div class="message-body">/);
  assert.match(html, /<h2>检查思路<\/h2>/);
  assert.match(html, /<strong>实际内容<\/strong>/);
  assert.match(html, /<code>src\/components\/Thread\.tsx<\/code>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /data-chat-table="true"/);
  assert.match(html, /href="https:\/\/example.com\/reference"/);
  assert.match(html, /aria-label="复制代码"/);
  assert.match(html, /const answer = &quot;&lt;exact&gt;&quot;;/);
  assert.equal(session.messages[0].thought, original);
});

test('response reasoning is placed before its body without a provisional region or repeated content', () => {
  const session = fixtureSession('empty');
  session.messages = [
    items[0], items[1],
    { ...message, id: 'response', content: 'Visible body', thought: 'Associated thinking' },
  ];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.equal((html.match(/class="process-summary ck-button"/g) ?? []).length, 1);
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
  assert.equal((html.match(/class="process-summary ck-button"/g) ?? []).length, 1);
  assert.equal((html.match(/data-message-frame=/g) ?? []).length, 1);
  assert.match(html, /3 次工具调用 · 2 次思考/);
  assert.doesNotMatch(html, /<article class="message is-doc"|class="message-actions"|复制消息|doc-byline|data-message-id="empty"/);
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
  assert.match(copy, /data-icon="copy"/);
});

test('speech boundaries split consecutive process with no extra round or message hierarchy', () => {
  const session = fixtureSession('empty');
  session.messages = [items[0], { ...message, content: 'Before the tool', id: 'speech' },
    items[1], { ...message, role: 'user', content: 'Next request', id: 'user' }, items[2]];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.equal((html.match(/class="process-summary ck-button"/g) ?? []).length, 3);
  assert.equal((html.match(/class="process-summary ck-button" aria-expanded="true"/g) ?? []).length, 1);
  assert.equal((html.match(/class="process-summary ck-button" aria-expanded="false"/g) ?? []).length, 2);
  assert.ok(html.indexOf('1 次思考') < html.indexOf('Before the tool'));
  assert.ok(html.indexOf('Before the tool') < html.indexOf('1 次工具调用'));
  assert.doesNotMatch(html, /第.*轮|含思考|耗时/);
});
