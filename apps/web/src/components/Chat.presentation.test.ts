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
  assert.match(html, /class="tool-head tool-toggle"/);
  assert.match(html, /class="tool-status">已完成/);
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

test('a native cancelling flag disables duplicate stop clicks without claiming cancellation is complete', () => {
  const html = renderToStaticMarkup(createElement(Thread, {
    session: fixtureSession('cancelling'), readOnly: true, onLoadMore() {}, onCancel() {},
  }));
  assert.match(html, /class="chat-typing-stop" disabled="">正在停止…/);
  assert.doesNotMatch(html, /class="chat-typing-stop"[^>]*>已取消/);
});
