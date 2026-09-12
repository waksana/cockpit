import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessage, SessionMeta } from '@cockpit/protocol';
import { MessageBody } from './MessageBody';
import { Thread } from './Thread';
import { fixtureSession, scenarios } from '../dev/chat-fixtures';
import { messageCopyText, copyText } from '../lib/copyText';
import { formatFileSize } from '../lib/managedFile';
import { compile } from 'sass';
import { getSessionDraft } from '../lib/attachmentSend';
import { existsSync, readFileSync } from 'node:fs';
import { ActivityHeader } from './ActivityHeader';

test('all component scenes conform to the actual message and metadata contracts', () => {
  for (const [scene] of scenarios) {
    const session = fixtureSession(scene);
    SessionMeta.parse(session);
    session.messages.forEach(message => ChatMessage.parse(message));
  }
});

test('Markdown keeps semantic headings and exact code text in a labeled copyable block', () => {
  const html = renderToStaticMarkup(createElement(MessageBody, {
    body: '# Heading\n\n## Section\n\nInline `x < 2`.\n\n```ts\nconst x = "<tag>";\n\nrun(x);\n```\n\n| A | B |\n| --- | --- |\n| long | cell |',
  }));
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<h2>Section<\/h2>/);
  assert.match(html, /aria-label="复制代码"/);
  assert.match(html, /<pre tabindex="0" aria-label="ts代码块"><code class="language-ts">const x = &quot;&lt;tag&gt;&quot;;\n\nrun\(x\);\n<\/code><\/pre>/);
  assert.match(html, /role="region" aria-label="表格（可横向滚动）" tabindex="0"/);
  assert.equal((html.match(/class="chat-code-block"/g) ?? []).length, 1, 'inline code remains text, not an extra copy block');
});

test('message copy preserves ordered parts and handles invalid file addresses without crashing rendering', () => {
  const base: ChatMessage = { id: 'copy', role: 'user', content: '', timestamp: 0 };
  const attachment = { kind: 'file' as const, name: 'notes.txt', url: '/uploads/notes.txt' };
  assert.equal(messageCopyText({ ...base, parts: [
    { type: 'text', text: 'Before' }, { type: 'file', attachment }, { type: 'text', text: 'After' },
  ] }), 'Before\n\n[notes.txt](/uploads/notes.txt)\n\nAfter');
  assert.equal(messageCopyText({ ...base, attachment, content: 'Caption' }), '[notes.txt](/uploads/notes.txt)\n\nCaption');
  assert.equal(messageCopyText({ ...base, attachment: { ...attachment, url: 'bad-address' } }), 'notes.txt（文件地址无效）');
});

test('clipboard failure is propagated, never reported as success', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: {
    writeText: async () => { throw new Error('Permission denied'); },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : Reflect.deleteProperty(globalThis, 'navigator'));
  await assert.rejects(copyText('retained'), /Permission denied/);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  await assert.rejects(copyText('retained'), /浏览器不支持剪贴板/);
});

test('tool records expose status text, a full-row disclosure and unknown rather than inferred pending', () => {
  const html = renderToStaticMarkup(createElement(Thread, {
    session: fixtureSession('process'), readOnly: true, onLoadMore() {},
  }));
  assert.match(html, /data-status="unknown"/);
  assert.match(html, /展开细节：缺少状态的工具记录 · 状态未知/);
  assert.match(html, /class="activity-head tool-head tool-toggle"/);
  assert.match(html, /class="activity-status">已完成/);
  assert.match(html, /记录：本次执行已结束/);
  assert.doesNotMatch(html, /任务目标已完成<\/span>|🤖/);
});

test('human file sizes preserve small-byte precision without pretending an unknown size is zero', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(12), '12 B');
  assert.equal(formatFileSize(1024), '1 KiB');
  assert.equal(formatFileSize(1536), '1.5 KiB');
  assert.equal(formatFileSize(25 * 1024 * 1024), '25 MiB');
});

test('Chat dark theme targets the mounted chat, not an impossible nested chat', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*\.chat \{\s*--primary-text-color:/);
  assert.doesNotMatch(css, /\.chat \.chat \{/);
});

test('the transcript does not make long decisions compete with its scroll-content intrinsic height', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-transcript \{[^}]*flex: 1 1 0;[^}]*min-height: min\(6rem, 20%\)/);
  assert.match(css, /\.chat-ask \{[^}]*flex: 0 1 auto;/);
  assert.match(css, /\.chat-execution \{[^}]*flex: 0 1 auto;[^}]*min-height: 40px/);
  assert.match(css, /\.chat \.chat-staged-list \{[^}]*flex: 0 1 auto;[^}]*min-height: 2\.5rem/);
});

test('the composer is a full-width bottom bar without a floating outer frame', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  const bar = css.match(/\.chat-input \{([^}]+)\}/)![1];
  assert.match(bar, /width: 100%;\s*margin: 0;/);
  assert.match(bar, /padding: 0\.25rem .*calc\(0\.25rem \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.doesNotMatch(bar, /border:|border-radius:|max-width:/);
  assert.match(css, /\.chat-input-message \{[^}]*min-height: 2\.5rem;[^}]*padding: 0\.5rem 0\.75rem;/);
  assert.match(css, /max-height: min\(9rem, \(100dvh - var\(--ux-error-height, 0px\)\) \/ 5\)/);
  const controls = [...css.matchAll(/\.chat-input-btn \{([^}]+)\}/g)];
  assert.equal(controls.length, 1, 'narrow screens must not override the square button dimensions');
  assert.match(controls[0][1], /width: 2\.5rem;\s*height: 2\.5rem;/);
  assert.match(controls[0][1], /border-radius: 50%/);
  assert.match(css, /\.chat \.chat-input-message:focus-visible \{\s*outline: none;/);
  assert.doesNotMatch(css, /\.chat-input:focus-within/);
});

test('CSS owns the shell again, with no replacement global JS viewport controller', () => {
  const shell = readFileSync(new URL('./Shell.tsx', import.meta.url), 'utf8');
  const styles = compile(new URL('../styles/components/shell.scss', import.meta.url).pathname).css;
  assert.match(styles, /\.cockpit-shell \{[^}]*inset: 0;[^}]*height: 100dvh;/);
  assert.doesNotMatch(shell + styles, /visualViewport|chat-viewport|useVisualViewport/);
  for (const file of ['../lib/visualViewport.ts', '../lib/useVisualViewport.ts', '../dev/viewport-fixture.ts']) {
    assert.equal(existsSync(new URL(file, import.meta.url)), false);
  }
});

test('decision details stay in their cards rather than inflating an empty textarea placeholder', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  for (const [scene, placeholder] of [['ask', '输入回答…'], ['plan', '输入新指令…'], ['compacting', '正在压缩…']] as const) {
    const html = renderToStaticMarkup(createElement(Thread, { session: fixtureSession(scene), onLoadMore() {} }));
    assert.ok(html.includes(`placeholder="${placeholder}"`), html);
    if (scene === 'plan') assert.match(html, /或在下方直接输入新指令/);
    if (scene === 'ask') assert.match(html, /也可以在下方输入自己的回答/);
  }
});

test('a choice-only request keeps the draft editable but does not offer a freeform send', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const session = fixtureSession('choice-only');
  getSessionDraft(session.sessionId).edit('Retained draft');
  const html = renderToStaticMarkup(createElement(Thread, { session, onLoadMore() {} }));
  assert.match(html, /class="chat-input-btn send rp" disabled="" aria-label="发送"/);
  assert.match(html, /<textarea[^>]*aria-label="消息输入"[^>]*>Retained draft<\/textarea>/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/);
});

test('a native cancelling flag disables duplicate stop clicks without claiming cancellation is complete', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const html = renderToStaticMarkup(createElement(Thread, {
    session: fixtureSession('cancelling'), onLoadMore() {}, onCancel() {},
  }));
  assert.match(html, /class="chat-typing-stop" disabled="">正在停止…/);
  assert.doesNotMatch(html, /class="chat-typing-stop"[^>]*>已取消/);
});

test('user copy and time share one footer outside the bubble without changing message identity or assistant bylines', () => {
  const session = fixtureSession('reading');
  session.messages = [
    { id: 'short', role: 'user', content: 'Short', timestamp: 1000 },
    { id: 'long', role: 'user', content: 'Long\n'.repeat(8), timestamp: 2000 },
    { id: 'file', role: 'user', content: '', timestamp: 3000,
      attachment: { kind: 'file', name: 'notes.txt', mime: 'text/plain', url: '/uploads/notes.txt' } },
    { id: 'answer', role: 'assistant', content: 'Answer', timestamp: 4000 },
  ];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.equal((html.match(/class="user-message"/g) ?? []).length, 3);
  assert.equal((html.match(/class="message-time"/g) ?? []).length, 3);
  assert.equal((html.match(/class="user-message-meta"><span class="chat-copy">/g) ?? []).length, 3);
  assert.equal((html.match(/<\/span><span class="message-time">\d{2}:\d{2}<\/span><\/div>/g) ?? []).length, 3);
  assert.doesNotMatch(html, /class="message-actions" data-role="user"/);
  for (const id of ['short', 'long', 'file']) assert.match(html, new RegExp(`class="message is-out[^"]*" data-message-id="${id}"`));
  assert.match(html, /class="doc-time"/);
});

test('thought, tool and skill use one single-line activity header, with static skill records', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.activity-head \{[^}]*height: 36px/);
  assert.match(css, /\.activity-title \{[^}]*overflow: hidden;[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.tool-name|\.skill-label|\.tool-title/);
  assert.match(css, /\.msg-tools \{[^}]*gap: 4px/);
  const html = renderToStaticMarkup(createElement(Thread, { session: fixtureSession('process'), readOnly: true, onLoadMore() {} }));
  assert.match(html, /class="activity-head thought-toggle"/);
  assert.match(html, /class="activity-head tool-head tool-toggle"/);
  assert.match(html, /class="message is-skill"[^>]*><div class="activity-head /);
  assert.doesNotMatch(html, /class="tool-detail-name"|class="msg-thought"/);
  const staticHeader = renderToStaticMarkup(createElement(ActivityHeader, { icon: 'icon', title: 'skill · long skill name' }));
  assert.doesNotMatch(staticHeader, /<button|aria-expanded|activity-chevron/);
});

test('activity disclosure labels retain the full title, state and keyboard button semantics', () => {
  const html = renderToStaticMarkup(createElement(ActivityHeader, {
    icon: 'icon', title: 'Long tool intent', status: '失败', disclosure: { open: true, onToggle() {} },
  }));
  assert.match(html, /<button type="button"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="收起细节：Long tool intent · 失败"/);
  assert.match(html, /title="Long tool intent"/);
});
