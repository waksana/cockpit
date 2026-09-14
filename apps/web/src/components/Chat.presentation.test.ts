import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionMeta } from '@cockpit/protocol';
import { ChatMessage } from '@cockpit/protocol/validation';
import { MessageBody } from './MessageBody';
import { Thread } from './Thread';
import { fixtureSession, scenarios } from '../dev/chat-fixtures';
import { copyText } from '../lib/copyText';
import { compile } from 'sass';
import { getSessionDraft } from '../lib/textDraft';
import { existsSync, readFileSync } from 'node:fs';
import { ActivityHeader } from './ActivityHeader';
import { ChatHeader } from './ChatHeader';

test('chat header keeps session and model details without any mode display or switch', () => {
  const html = renderToStaticMarkup(createElement(ChatHeader, {
    title: 'Session title', modelLabel: 'Native model', moreRef: { current: null }, moreOpen: false,
    onBack() {}, onInfo() {}, onMore() {},
  }));
  assert.match(html, /Session title/);
  assert.match(html, /Native model/);
  assert.match(html, /aria-label="查看会话信息"/);
  assert.match(html, /aria-label="更多操作"/);
  assert.equal((html.match(/aria-haspopup="menu"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-mode=|模式|mode-menu|chat-topbar-mode(?:\s|")/);
  for (const file of ['../App.tsx', '../dev/chat-lab.tsx', './ChatHeader.tsx']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /ModeMenu|setMode\b|modeRef|modeOpen|onMode\b|currentMode\b/);
  }
  assert.equal(existsSync(new URL('./ModeMenu.tsx', import.meta.url)), false);
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.doesNotMatch(css, /\.mode-menu|\[data-mode|\.chat-topbar-mode(?:\s|[.{])/);
});

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

test('latest tool overview exposes explicit recorded failure and unknown states', () => {
  const html = renderToStaticMarkup(createElement(Thread, {
    session: fixtureSession('process'), readOnly: true, onLoadMore() {},
  }));
  assert.match(html, /1 项状态未知/);
  assert.match(html, /1 项失败/);
  assert.match(html, /class="process-summary"/);
  assert.match(html, /class="activity-head tool-head tool-toggle"/);
  assert.match(html, /记录：本次执行已结束/);
  assert.doesNotMatch(html, /任务目标已完成<\/span>|🤖/);
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

test('the native composer keeps a compact send action without parked file or voice controls', t => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-input-btn\.send \{[^}]*background-color: transparent;/);
  assert.doesNotMatch(css, /\.chat-input-btn\.(?:attach|mic)/);
  assert.match(css, /\.chat-input-btn\.send \{[^}]*color: var\(--chat-accent-ink\)/);
  assert.match(css, /\.chat-input-btn\.send:disabled \{[^}]*color: var\(--secondary-text-color\)/);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const html = renderToStaticMarkup(createElement(Thread, { session: fixtureSession('empty'), onLoadMore() {} }));
  assert.match(html, /data-icon="arrow_up" aria-hidden="true" style="font-size:22px"/);
  assert.doesNotMatch(html, /data-icon="attach"|data-icon="microphone"|type="file"/);
  assert.doesNotMatch(html, /添加文件一起讨论/);
});

test('decision send semantics stay visible without inflating an empty textarea placeholder', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  for (const [scene, placeholder] of [['ask', '输入回答…'], ['plan', '输入新指令…'], ['compacting', '正在压缩…']] as const) {
    const html = renderToStaticMarkup(createElement(Thread, { session: fixtureSession(scene), onLoadMore() {} }));
    assert.ok(html.includes(`placeholder="${placeholder}"`), html);
    if (scene === 'plan') assert.match(html, /发送新指令将替代当前待确认计划/);
    if (scene === 'ask') assert.match(html, /输入内容将回答当前问题/);
  }
});

test('a choice-only request keeps the draft editable but does not offer a freeform send', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const session = fixtureSession('choice-only');
  getSessionDraft(session.sessionId).edit('Retained draft');
  const html = renderToStaticMarkup(createElement(Thread, { session, onLoadMore() {} }));
  assert.match(html, /class="chat-input-btn send rp" disabled="" aria-label="提交回答"/);
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

test('user time stays outside its bubble without external copy controls on either message role', () => {
  const session = fixtureSession('reading');
  session.messages = [
    { id: 'short', role: 'user', content: 'Short', timestamp: 1000 },
    { id: 'long', role: 'user', content: 'Long\n'.repeat(8), timestamp: 2000 },
    { id: 'third', role: 'user', content: 'Third native message', timestamp: 3000 },
    { id: 'answer', role: 'assistant', content: 'Answer', timestamp: 4000 },
  ];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.equal((html.match(/class="user-message"/g) ?? []).length, 3);
  assert.equal((html.match(/class="message-time"/g) ?? []).length, 3);
  assert.equal((html.match(/class="user-message-meta"><span class="message-time">\d{2}:\d{2}<\/span><\/div>/g) ?? []).length, 3);
  assert.doesNotMatch(html, /class="message-actions"|aria-label="复制消息"|class="chat-copy"/);
  for (const id of ['short', 'long', 'third']) assert.match(html, new RegExp(`class="message is-out[^"]*" data-message-id="${id}"`));
  assert.match(html, /class="doc-time"/);
});

test('question replies retain the original question without an emoji or repeated options', () => {
  const session = fixtureSession('empty');
  session.messages = [
    { id: 'reply', role: 'user', subtype: 'ask-reply', content: 'Yes', replyQuestion: 'Keep this setting?', timestamp: 1 },
    { id: 'missing', role: 'user', subtype: 'ask-reply', content: 'Unlinked answer', timestamp: 2 },
  ];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.match(html, /class="ask-reply-question" aria-label="回答的问题"/);
  assert.match(html, /Keep this setting\?/);
  assert.match(html, /原问题记录不可用/);
  assert.match(html, /Unlinked answer/);
  assert.doesNotMatch(html, /↩|ask-reply-tag/);
  assert.ok(html.indexOf('Keep this setting?') < html.indexOf('<p>Yes</p>'));
});

test('chat leaves right-click and text selection to the browser instead of mounting a copy menu', () => {
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(thread, /onContextMenu|ContextMenu|MessageMenu|msgMenu|openMsgMenu|copyNotice|messageCopyText/);
  const base = compile(new URL('../styles/base.scss', import.meta.url).pathname).css;
  assert.match(base, /\.chat-messages[^{}]*\{[^}]*user-select: text;[^}]*-webkit-touch-callout: default/);
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.doesNotMatch(css, /\.chat-copy-notice/);
});

test('tool and thought rows stay single-line while expanded skill records can show their full name', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.activity-head \{[^}]*height: 44px/);
  assert.match(css, /\.activity-title \{[^}]*overflow: hidden;[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.tool-name|\.skill-label|\.tool-title/);
  assert.match(css, /\.message-process-content\[hidden\] \{[^}]*display: none/);
  const html = renderToStaticMarkup(createElement(Thread, { session: fixtureSession('process'), readOnly: true, onLoadMore() {} }));
  assert.match(html, /class="process-summary"/);
  assert.doesNotMatch(html, /class="activity-head thought-toggle"/);
  assert.match(html, /class="activity-head tool-head tool-toggle"/);
  assert.doesNotMatch(html, /class="tool-detail-name"|class="msg-thought"/);
  const skillSession = fixtureSession('empty');
  skillSession.messages = [{ id: 'skill', role: 'system', subtype: 'skill', content: 'example', timestamp: 1 }];
  const skills = renderToStaticMarkup(createElement(Thread, { session: skillSession, readOnly: true, onLoadMore() {} }));
  assert.match(skills, /Skill · example/);
  assert.match(skills, /<div class="activity-head /);
  assert.match(skills, /skill · example/);
  assert.doesNotMatch(skills, /次工具调用/);
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

test('expanded tools keep their header geometry and show full metadata only when clipped', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.doesNotMatch(css, /\.msg-tool\[data-open=true\]/);
  assert.match(css, /\.tool-label \{[^}]*max-width: min\(18ch, 45%\);[^}]*direction: rtl/);
  assert.match(css, /\.tool-description \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.activity-detail\.tool-detail \{[^}]*margin: 0;[^}]*border-inline-start: 0/);
  const source = readFileSync(new URL('./ToolCallRow.tsx', import.meta.url), 'utf8');
  assert.match(source, /nameClipped &&/);
  assert.match(source, /descriptionClipped && description/);
  assert.doesNotMatch(source, /activity-chevron|activity-status/);
});

test('message process spacing does not retain old document or copy toolbar gaps', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.msg-group\[data-assistant-message\] > \.message\.is-doc \{\s*margin: 0/);
  assert.doesNotMatch(css, /\.msg-group\[data-assistant-message\] \+ \.msg-group\[data-assistant-message\]/);
  assert.match(css, /\.message-process-content \{\s*padding: 0;/);
  assert.match(css, /\.user-message \{[^}]*margin: 0/);
  assert.doesNotMatch(css, /\.message-actions|\.chat-copy\.is-text/);
  assert.doesNotMatch(css, /\.message-process \+ \.message-body/);
});

test('message and activity hover do not add fill while keyboard focus and local copy remain visible', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1].includes(':hover')) continue;
    assert.doesNotMatch(rule[1], /\.(?:message-body|process-summary|activity-head|subagent-head|msg-group|msg-tool)\b/);
  }
  assert.match(css, /\.chat :is\(button, a, textarea, summary, \[tabindex\]\):focus-visible \{[^}]*outline: 2px/);
  assert.match(css, /\.chat-copy-button:hover/);
});

test('code copying inside user and assistant Markdown quotes survives removal of external message copying', () => {
  const session = fixtureSession('reading');
  session.messages = [
    { id: 'user-code', role: 'user', content: '> Quoted source\n>\n> ```ts\n> const answer = 42;\n> ```', timestamp: 1 },
    { id: 'assistant-code', role: 'assistant', content: '```sh\nprintf "exact\\n"\n```', timestamp: 2 },
  ];
  const html = renderToStaticMarkup(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  assert.equal((html.match(/aria-label="复制代码"/g) ?? []).length, 2);
  assert.match(html, /<blockquote>/);
  assert.doesNotMatch(html, /aria-label="复制消息"|class="message-actions"/);
});
