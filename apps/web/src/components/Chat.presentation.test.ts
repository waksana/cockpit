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
import { getDraftSession } from '../lib/draftSelection';
import { existsSync, readFileSync } from 'node:fs';
import { ActivityHeader } from './ActivityHeader';
import { ChatHeader } from './ChatHeader';
import { PlanCard } from './PendingDecision';
import { useCockpit } from '../net/store';

test('chat header keeps session and model details without any mode display or switch', () => {
  const html = renderToStaticMarkup(createElement(ChatHeader, {
    title: 'Session title', modelLabel: 'Native model', moreRef: { current: null }, moreOpen: false,
    onBack() {}, onInfo() {}, onMore() {},
  }));
  assert.match(html, /Session title/);
  assert.match(html, /Native model/);
  assert.match(html, /aria-label="查看会话信息：Session title"/);
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

test('Markdown edge rules follow class-based paragraphs without changing bubble padding or paragraph rhythm', () => {
  const css = compile(new URL('../styles/index.scss', import.meta.url).pathname).css;
  const paragraph = css.indexOf('.message-body .markdown-paragraph {');
  assert.ok(paragraph >= 0);
  assert.ok(css.indexOf('.message-body > :first-child {') > paragraph);
  assert.ok(css.indexOf('.message-body > :last-child {') > paragraph);
  assert.match(css, /\.message-body > :first-child \{\s*margin-top: 0;/);
  assert.match(css, /\.message-body > :last-child \{\s*margin-bottom: 0;/);
  assert.match(css, /--chat-gap-prose: 0\.65em;/);
  assert.match(css, /--chat-inset-bubble: 0\.65rem 0\.85rem;/);
  assert.match(css, /\.message-body \.markdown-paragraph \{[^}]*margin: var\(--chat-gap-prose, 0\.65em\) 0;/);
  assert.match(css, /\.message\.is-out \{[^}]*padding: var\(--chat-inset-bubble\);/);
});

test('tool and thought details inherit the same indentation without moving their header', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /--chat-inset-detail: var\(--host-space-xl\);/);
  assert.match(css, /\.activity-detail \{[^}]*margin: var\(--chat-gap-meta\) 0 var\(--chat-gap-message\);[^}]*padding-inline-start: var\(--chat-inset-detail\);/);
  const tool = css.match(/\.activity-detail\.tool-detail \{([^}]+)\}/)?.[1];
  assert.ok(tool);
  assert.doesNotMatch(tool, /padding|margin/);
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
  assert.match(html, /class="process-summary ck-button"/);
  assert.match(html, /class="activity-head tool-head tool-toggle ck-button"/);
  assert.match(html, /记录：本次执行已结束/);
  assert.doesNotMatch(html, /任务目标已完成<\/span>|🤖/);
});

test('Chat dark theme targets the mounted chat, not an impossible nested chat', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*\.chat \{[^}]*--primary-text-color:/);
  assert.doesNotMatch(css, /\.chat \.chat \{/);
});

test('one CSS height budget pins ordinary input but scrolls answer input with its question', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-transcript \{[^}]*flex: 1 1 0;[^}]*min-height: min\(6rem, 20%\)/);
  assert.match(css, /\.chat-input-area \{[^}]*flex: 0 1 auto;[^}]*min-height: 0;[^}]*max-height: 70%/);
  assert.match(css, /\.chat-input-card::details-content \{[^}]*display: flex;[^}]*min-height: 0;/);
  assert.match(css, /\.chat-input-card-body \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*min-height: 0;[^}]*overflow: hidden/);
  assert.match(css, /\.chat-input-context \{[^}]*flex: 0 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto/);
  assert.match(css, /\.chat-input-context:empty \{\s*display: none;/);
  assert.match(css, /\.chat-input-card\[data-question\] \.chat-input-card-body \{\s*display: block;\s*overflow-y: auto;/);
  assert.match(css, /\.chat-input-card\[data-question\] \.chat-input-context \{\s*overflow: visible;/);
  assert.match(css, /\.chat-input-notices \{[^}]*flex: none;[^}]*max-height: min\(12rem, 30dvh\)/);
  for (const selector of ['chat-decisions', 'chat-queue', 'chat-composer-context', 'chat-pending-body']) {
    assert.doesNotMatch(css.match(new RegExp(`\\.${selector} \\{([^}]+)\\}`))?.[1] ?? '', /overflow-y: auto|max-height:/);
  }
  assert.doesNotMatch(css, /\.chat-dock \{|\.chat-execution \{/);
});
test('one card frame retains compact execution/queue typography and independent actions', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-input-card \{[^}]*border: 1px solid/);
  assert.doesNotMatch(css.match(/\.chat-ask \{([^}]+)\}/)?.[1] ?? '', /border:|background:/);
  assert.match(css, /\.chat-execution-actions button \{[^}]*min-block-size: var\(--chat-control-compact\);[^}]*font-size: var\(--chat-text-meta\)/);
  assert.match(css, /\.chat-queue-item \{[^}]*font-size: var\(--chat-text-meta\)/);
  assert.doesNotMatch(css, /\.chat-queue-label|\.chat-composer-hint/);
  assert.match(css, /\.chat-queue-copy \{[^}]*display: flex;/);
  assert.doesNotMatch(css, /\.chat-queue-entry\[open\] \+ \.chat-queue-copy/);
  assert.doesNotMatch(css, /\.chat-execution-label\[data-running\]::before/);
  assert.match(css, /\.chat-execution-label \{[^}]*flex: 1 1 0;[^}]*min-width: 4em;[^}]*text-overflow: ellipsis;/);
  const activity = compile(new URL('../styles/components/session-activity.scss', import.meta.url).pathname).css;
  assert.match(activity, /\.session-activity \{[^}]*white-space: nowrap/);
});

test('only answer drafts opt into the shared question scroller', () => {
  for (const scene of ['reading', 'idle-queued', 'plan-queued', 'elicitation-queued', 'ask-queued', 'choice-only', 'freeform', 'decision-stack'] as const) {
    const session = fixtureSession(scene);
    const html = renderToStaticMarkup(createElement(Thread, { session, onLoadMore() {} }));
    const card = html.match(/<details class="chat-input-card"[^>]*>/)?.[0];
    assert.ok(card, scene);
    assert.equal(card.includes('data-question="true"'), !!session.ask, scene);
    assert.ok(html.includes('class="chat-input-context"'), scene);
    assert.equal((html.match(/<textarea/g) ?? []).length, 1, scene);
  }
  const readOnly = renderToStaticMarkup(createElement(Thread, {
    session: fixtureSession('ask-queued'), readOnly: true, onLoadMore() {},
  }));
  assert.doesNotMatch(readOnly, /data-question="true"|<textarea/);
});

test('spacing tokens own visible boundaries and placeholder stays distinct on focus in both themes', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  const foundations = compile(new URL('../styles/tokens.scss', import.meta.url).pathname).css;
  for (const [name, role, pixels] of [['meta','xs',4],['message','sm',8],['process','md',12],['speaker','lg',16],['region','sm',8],['content','md',12],['control','sm',8]]) {
    assert.ok(css.includes(`--chat-gap-${name}: var(--host-space-${role});`));
    assert.ok(foundations.includes(`--host-space-${role}: ${pixels}px;`));
  }
  assert.match(css, /\.msg-group\[data-gap=speaker\] \{[^}]*padding-block-start: var\(--chat-gap-speaker\)/);
  assert.match(css, /\.chat-input-message::placeholder \{[^}]*color: var\(--chat-placeholder-color\);[^}]*opacity: 1;/);
  assert.doesNotMatch(css, /:focus(?:::placeholder|[^{}]*\{[^}]*--chat-placeholder-color)/);
  assert.equal((css.match(/--chat-placeholder-color:/g) ?? []).length, 2);
});

test('all input states share one full-width unframed editor row inside the same card', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  const publicCss = compile(new URL('../styles/primitives/public-ui.scss', import.meta.url).pathname).css;
  const bar = publicCss.match(/(?:^|\n)\.ck-input-row \{([^}]+)\}/)![1];
  assert.match(bar, /width: 100%;\s*margin: 0;/);
  assert.match(bar, /padding: var\(--host-space-xs\);/);
  assert.match(bar, /gap: var\(--host-space-xs\);/);
  assert.match(publicCss, /\.ck-input-hint \{[^}]*font-size: max\(var\(--ck-input-font-min\), var\(--messages-text-size\)\);/);
  assert.match(publicCss, /\.ck-status-text \{[^}]*font-size: var\(--host-text-meta\);/);
  assert.match(publicCss, /\.ck-input-status \{[^}]*width: 100%;[^}]*height: 32px;/);
  assert.match(publicCss, /\.ck-status-action \{[^}]*margin-inline-start: auto;/);
  assert.doesNotMatch(publicCss, /\.chat-/);
  assert.match(css, /\.chat-input-card-body \{[^}]*scrollbar-gutter: stable both-edges;/);
  assert.doesNotMatch(css, /\.chat-input-card\[data-decision\] \.chat-input/);
  assert.doesNotMatch(css, /\.chat-input-card\[data-header\] \.chat-input(?:-message)? \{/);
  assert.doesNotMatch(css, /\.chat-input-message:focus \{/);
  assert.match(css, /\.chat-input-message \{[^}]*background: transparent;/);
  assert.match(css, /\.chat-input-message \{[^}]*padding-inline-end: var\(--chat-gap-meta\);/);
  assert.match(css, /\.chat-input-message:not\(:first-child\) \{[^}]*padding-inline-start: var\(--chat-gap-meta\);/);
  assert.match(css, /\.chat-input-area \{[^}]*margin-block-end: calc\(var\(--chat-inset-bottom\) \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.doesNotMatch(bar, /border:|border-radius:|max-width:/);
  assert.match(css, /--chat-inset-field: var\(--host-space-sm\) var\(--host-space-md\);/);
  assert.match(css, /\.chat-input-message \{[^}]*min-height: var\(--ck-control-size\);[^}]*padding: var\(--chat-inset-field\);/);
  assert.match(css, /\.chat-input-message \{[^}]*padding-block: max\(var\(--chat-gap-control\), \(var\(--ck-control-size\) - 1lh\) \/ 2\);/);
  assert.match(bar, /align-items: flex-end;/, 'multiline drafts keep actions at the last line rather than midway up the editor');
  assert.match(css, /max-height: min\(9rem, \(100dvh - var\(--ux-error-height, 0px\)\) \/ 5\)/);
  const controls = [...css.matchAll(/\.chat-input-btn \{([^}]+)\}/g)];
  assert.equal(controls.length, 1, 'narrow screens must not override the square button dimensions');
  assert.match(controls[0][1], /width: var\(--ck-control-size\);\s*height: var\(--ck-control-size\);/);
  const primitives = compile(new URL('../styles/primitives/public-ui.scss', import.meta.url).pathname).css;
  assert.match(primitives, /:where\(\.ck-icon-button\) \{[^}]*border-radius: 50%/);
  assert.match(css, /\.chat \.chat-input-message:focus-visible \{\s*outline: none;/);
  assert.match(css, /\.chat \.chat-input-btn:focus-visible \{\s*outline-offset: -3px;/);
  assert.doesNotMatch(css, /\.chat-input:focus-within/);
});

test('dense process rows stay compact on touch without shrinking standalone controls', () => {
  const css = compile(new URL('../styles/index.scss', import.meta.url).pathname).css;
  assert.match(css, /--chat-row-process: 28px;/);
  assert.match(css, /\.activity-head \{[^}]*height: var\(--chat-row-process\);[^}]*min-block-size: var\(--chat-row-process\);/);
  assert.match(css, /\.process-summary \{[^}]*min-height: var\(--chat-row-process\);/);
  const coarseRules = [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  assert.doesNotMatch(coarseRules, /\.activity-head|\.process-summary/);
  assert.match(coarseRules, /\.chat-copy-button\.ck-button[^}]*min-block-size: var\(--ck-control-size\)/);
  assert.match(coarseRules, /\.chat-execution-actions \.ck-button[^}]*min-block-size: var\(--ck-control-size\)/);
});

test('queue rows align their first line and controls without vertically centering expanded messages', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /--chat-control-compact: 32px;/);
  assert.match(css, /\.chat-queue \{[^}]*--ck-control-size: var\(--chat-control-compact\);/);
  assert.match(css, /\.chat-queue-item \{[^}]*align-items: flex-start;/);
  assert.match(css, /\.chat-queue-text \{[^}]*min-block-size: var\(--ck-control-size\);[^}]*line-height: var\(--chat-leading-ui\);[^}]*padding-block: max\(0px, \(var\(--ck-control-size\) - 1lh\) \/ 2\);/);
  assert.match(css, /\.chat-queue-copy \.chat-copy-button \{[^}]*min-block-size: var\(--ck-control-size\);/);
  assert.match(css, /\.chat-queue-remove \{[^}]*align-self: flex-start;/);
  assert.doesNotMatch(css.match(/\.chat-queue-copy \{([^}]+)\}/)?.[1] ?? '', /max-width: 5rem/);
  assert.match(css, /\.chat-queue-copy \{[^}]*inline-size: min-content;/, 'copy feedback wraps to the intrinsic button width instead of consuming the message and Remove columns');
});

test('decision text wraps at its actual component boundary without clipping long choices', () => {
  const session = fixtureSession('ask-unbroken');
  const html = renderToStaticMarkup(createElement(Thread, { session, onLoadMore() {} }));
  assert.ok(html.includes(session.ask!.question));
  assert.ok(html.includes(session.ask!.choices![0]));
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-pending-body \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.chat-ask-q \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.chat-ask-choice \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/);
});

test('execution actions wrap within the card rather than shrinking text or clipping Stop', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-execution-head \{[^}]*flex-wrap: wrap;[^}]*gap: var\(--chat-gap-meta\);/);
  assert.match(css, /\.chat-execution-actions \{[^}]*flex-wrap: wrap;[^}]*max-width: 100%;[^}]*gap: var\(--chat-gap-meta\);/);
  assert.match(css, /\.chat-execution-actions button \{[^}]*max-width: 100%;[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
  assert.doesNotMatch(css, /@container chat-dock \(max-width: 21rem\)/, 'narrow cards use flow, not a smaller spacing scale');
});

test('standalone native disclosures share touch targets and public control geometry', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  for (const selector of ['.chat-execution-head', '.chat-pending-detail > summary']) {
    assert.ok(coarse.includes(selector), `${selector} follows the coarse target`);
  }
  assert.match(coarse, /min-block-size: var\(--ck-control-size\);/);
  assert.match(css, /\.chat-pending-detail summary \{[^}]*align-content: center;/);
  const publicCss = compile(new URL('../styles/primitives/public-ui.scss', import.meta.url).pathname).css;
  assert.match(publicCss, /:where\(\.ck-button, \.ck-icon-button\) \{[^}]*min-block-size: var\(--ck-control-size\);[^}]*border-radius: var\(--ck-radius\);/);
  assert.match(css, /\.chat-execution-actions button \{[^}]*padding: var\(--chat-gap-meta\) var\(--chat-inset-compact\);/);
  assert.match(css, /\.chat-input-card \{[^}]*border-radius: var\(--host-radius-control\);/);
  assert.doesNotMatch(css, /\.module-draft-recovery/);
});

test('chat buttons consume public appearance and retain only contextual geometry and state exceptions', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  const publicCss = compile(new URL('../styles/primitives/public-ui.scss', import.meta.url).pathname).css;
  for (const selector of ['chat-ask-choice', 'chat-execution-actions button']) {
    const rule = css.match(new RegExp(`\\.${selector} \\{([^}]+)\\}`))?.[1];
    assert.ok(rule);
    assert.doesNotMatch(rule, /(?:^|\s)(?:appearance|background|color|border-radius|font|line-height|cursor|opacity):/);
  }
  assert.doesNotMatch(css, /\.dialog-btn|\.is-recommended|\.chat-typing-stop/);
  assert.match(css, /\.chat-history-retry \{\s*color: var\(--ck-color-accent\);/);
  assert.match(css, /\.chat-execution-actions \{[^}]*--ck-disabled-opacity: 0\.5;/);
  assert.match(css, /\.chat-execution-actions button\[aria-disabled=true\] \{\s*cursor: default;/);
  assert.match(publicCss, /\.ck-primary \{[^}]*background: var\(--ck-color-accent\);[^}]*color: var\(--ck-color-on-accent\);/);
  assert.match(publicCss, /\.ck-danger \{\s*color: var\(--ck-color-danger\);/);
  assert.match(publicCss, /:is\(:disabled, \[aria-disabled=true\]\) \{[^}]*opacity: var\(--ck-disabled-opacity\);/);
});

test('only the recommended offered plan action consumes the public primary treatment, including when disabled', () => {
  const request = fixtureSession('plan').planRequest!;
  for (const pending of [false, true]) {
    const html = renderToStaticMarkup(createElement(PlanCard, { request, pending, onSelect() {} }));
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map(match => match[0]);
    assert.equal(buttons.length, request.actions!.length);
    assert.equal(buttons.filter(button => button.includes('ck-primary')).length, 1);
    assert.equal(buttons[request.actions!.indexOf(request.recommendedAction!)].includes('ck-primary'), true);
    for (const button of buttons) assert.equal(button.includes('disabled=""'), pending);
    assert.doesNotMatch(html, /is-recommended/);
  }
  const withoutRecommended = renderToStaticMarkup(createElement(PlanCard, {
    request: { ...request, actions: ['exit_only'] }, pending: false, onSelect() {},
  }));
  assert.doesNotMatch(withoutRecommended, /ck-primary/);
});

test('history retries own their accent intent while session-error retry uses ordinary public text', () => {
  for (const historyStale of [false, true]) {
    const html = renderToStaticMarkup(createElement(Thread, {
      session: { ...fixtureSession('history-error'), historyStale }, onLoadMore() {}, onRetryHistory() {},
    }));
    assert.match(html, /class="chat-history-retry ck-button rp"/);
    assert.doesNotMatch(html, /dialog-btn/);
  }
  const html = renderToStaticMarkup(createElement(Thread, {
    session: { ...fixtureSession('reading'), error: 'Synthetic error' }, onLoadMore() {}, onRetryHistory() {},
  }));
  assert.match(html, /class="ck-button rp">重试同步<\/button>/);
  assert.doesNotMatch(html, /dialog-btn|chat-history-retry/);
});

test('Chat regions and optional composer context each have a single spacing owner', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat \{[^}]*row-gap: var\(--chat-gap-region\)/);
  assert.match(css, /\.chat-messages \{[^}]*scrollbar-gutter: stable both-edges;[^}]*padding: var\(--chat-inset-transcript\) var\(--chat-gutter\) 0;/);
  assert.match(css, /\.chat-composer \{[^}]*flex: none;/);
  assert.match(css, /\.chat-composer-body \{[^}]*gap: var\(--chat-gap-region\);/);
  assert.match(css, /\.chat-composer-context \{[^}]*display: none;[^}]*gap: var\(--chat-gap-region\);[^}]*min-height: 0;/);
  assert.match(css, /\.chat-composer-context:has\(> :not\(:empty\)\) \{\s*display: flex;/);
  assert.match(css, /\.chat-input-notice \{[^}]*margin: 0;/);
  assert.doesNotMatch(css, /\.draft-attachments|\.module-draft-recovery/);
  assert.match(css, /\.chat-pending-head \{[^}]*margin: 0;/);
  assert.match(css, /\.chat-pending-body > \* \+ \* \{\s*margin-block-start: var\(--chat-gap-content\);/);
  assert.match(css, /\.message-body \+ \.message-attachments \{[^}]*margin-block-start: var\(--chat-gap-content\);/);
  assert.match(css, /\.message-attachments > \* \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
  assert.match(css, /\.message-attachments \{[^}]*flex-direction: column;[^}]*align-items: flex-start;/);
  assert.match(css, /\.message-attachment \{[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\.chat-history-actions:empty \{\s*display: none;/);
  assert.doesNotMatch(css, /--chat-space-/);
  assert.doesNotMatch(css, /data-preparing/);
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(thread, /readySession|preparingHistory|data-preparing/);
});

test('the entire input card uses one default-open disclosure without an arrow or nested question frame', () => {
  const html = renderToStaticMarkup(createElement(Thread, {
    session: fixtureSession('ask-queued'), onLoadMore() {},
  }));
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
  assert.match(html, /<details class="chat-input-card" open="" data-header="true" data-decision="true" data-question="true"><summary class="chat-execution-head"/);
  assert.match(html, /aria-label="活动待同步，展开或收起输入卡片"/);
  assert.match(html, /class="chat-pending-body chat-answer-question" role="group" aria-label="需要你的选择"/);
  assert.ok(html.indexOf('class="chat-queue"') < html.indexOf('class="chat-composer"'));
  assert.doesNotMatch(html, /class="chat-decisions"|class="chat-ask chat-pending/);
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.chat-execution-head \{[^}]*min-block-size: var\(--chat-control-compact\);/);
  assert.doesNotMatch(css, /\.chat-input-card:not\(\[open\]\) \.chat-execution-head/, 'folding does not introduce a different control size');
  assert.match(css, /\.chat-execution-head \{[^}]*cursor: pointer;[^}]*list-style: none;/);
  assert.match(css, /\.chat-execution-head\[hidden\] \{[^}]*display: none;/);
  assert.match(css, /\.chat-execution-head::-webkit-details-marker \{[^}]*display: none;/);
  assert.match(css, /\.chat-ask-q \{[^}]*user-select: text/);
  assert.doesNotMatch(html, /chat-answer-toggle|chat-answer-chevron/);
  const source = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /onToggle|scrollHeight|clientHeight|getBoundingClientRect|ResizeObserver|requestAnimationFrame/);
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

test('Chat typography is role-based and narrow layouts follow their own available width', () => {
  const css = compile(new URL('../styles/index.scss', import.meta.url).pathname).css;
  const tokens = compile(new URL('../styles/components/chat-design.scss', import.meta.url).pathname).css;
  assert.doesNotMatch(tokens, /:root|body \{/);
  assert.match(tokens, /--chat-text-body: var\(--messages-text-size\)/);
  const foundations = compile(new URL('../styles/tokens.scss', import.meta.url).pathname).css;
  assert.match(tokens, /--chat-text-label: var\(--font-size-13\)/);
  for (const [role, hostRole, size] of [['secondary','body',14],['meta','meta',12]]) {
    assert.ok(tokens.includes(`--chat-text-${role}: var(--host-text-${hostRole})`));
    assert.ok(foundations.includes(`--host-text-${hostRole}: var(--font-size-${size})`));
  }
  assert.match(css, /\.chat-input-message \{[^}]*font-size: max\(var\(--ck-input-font-min\), var\(--chat-text-body\)\)/);
  assert.match(css, /\.chat-ask-q \{[^}]*font-size: var\(--chat-text-body\)/);
  assert.match(css, /\.subagent-prompt \.message-body \{[^}]*font-size: var\(--chat-text-secondary\)/);
  assert.match(css, /\.message-time, \.doc-time \{[^}]*font-size: var\(--chat-text-meta\);[^}]*line-height: var\(--chat-leading-ui\);[^}]*font-variant-numeric: tabular-nums/);
  assert.match(css, /\.message\.is-doc \.doc-byline \{[^}]*margin: 0 0 var\(--chat-gap-meta\)/);
  assert.doesNotMatch(css, /\.doc-mark/);
  assert.match(css, /\.chat-input-area \{[^}]*container: chat-dock\/inline-size/);
  assert.match(css, /@container chat-dock \(max-width: 36rem\)/);
  assert.match(css, /@container chat-process \(max-width: 36rem\)/);
  assert.match(css, /@container chat-agent \(max-width: 36rem\)/);
  assert.match(css, /\.subagent-overview \{[^}]*container: chat-agent\/inline-size/);
  assert.doesNotMatch(css, /\.subagent-card \{[^}]*container:/);
  assert.match(css, /\.chat-copy-label \{[^}]*display: grid/);
  assert.match(css, /\.chat-copy-label > span \{[^}]*grid-area: 1\/1/);
  assert.match(css, /\.chat-copy-label-size \{[^}]*visibility: hidden/);
});

test('the native composer keeps a compact send action without parked file or voice controls', t => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  const primitives = compile(new URL('../styles/primitives/public-ui.scss', import.meta.url).pathname).css;
  assert.match(primitives, /:where\(\.ck-button, \.ck-icon-button\) \{[^}]*background: transparent;/);
  assert.doesNotMatch(css, /\.chat-input-btn\.(?:attach|mic)/);
  assert.match(css, /\.chat-input-btn\.send \{[^}]*color: var\(--ck-color-accent\)/);
  assert.match(primitives, /:is\(\.ck-button, \.ck-icon-button, \.ck-input\):is\(:disabled, \[aria-disabled=true\]\) \{[^}]*opacity: var\(--ck-disabled-opacity\)/);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const html = renderToStaticMarkup(createElement(Thread, { session: fixtureSession('empty'), onLoadMore() {} }));
  assert.match(html, /data-icon="arrow_up" aria-hidden="true" style="width:24px;height:24px"/);
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
    if (scene === 'plan') assert.match(html, /aria-label="发送新指令"/);
    if (scene === 'ask') assert.match(html, /aria-label="提交回答"/);
    assert.doesNotMatch(html, /chat-composer-hint|aria-describedby=/);
  }
});

test('a choice-only request keeps the draft editable but does not offer a freeform send', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const session = fixtureSession('choice-only');
  const prompt = getSessionDraft(session.sessionId);
  prompt.edit('Cached prompt not an answer');
  getDraftSession(session.sessionId).candidate({ kind: 'ask', requestId: session.ask!.requestId }).edit('Retained draft');
  const html = renderToStaticMarkup(createElement(Thread, { session, onLoadMore() {} }));
  assert.match(html, /class="chat-input-btn ck-icon-button send rp" disabled="" aria-label="提交回答"/);
  assert.match(html, /<textarea[^>]*aria-label="消息输入"[^>]*>Retained draft<\/textarea>/);
  assert.doesNotMatch(html, /<textarea[^>]*disabled/);
  assert.doesNotMatch(html, /Cached prompt not an answer/);
});

test('a native cancelling flag disables duplicate stop clicks without claiming cancellation is complete', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : Reflect.deleteProperty(globalThis, 'window'));
  const state = useCockpit.getInitialState();
  const previousConnection = state.connState;
  const previousReady = state.snapshotReady;
  state.connState = 'open';
  state.snapshotReady = true;
  t.after(() => { state.connState = previousConnection; state.snapshotReady = previousReady; });
  const html = renderToStaticMarkup(createElement(Thread, {
    session: fixtureSession('cancelling'), onLoadMore() {}, onCancel() {},
  }));
  assert.match(html, /class="chat-typing-stop ck-button ck-danger" aria-disabled="true" aria-busy="true">[\s\S]*?正在停止…<\/button>/);
  assert.doesNotMatch(html, /class="chat-typing-stop ck-button ck-danger"[^>]*>已取消/);
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
  assert.equal((html.match(/class="user-message-meta"><time class="message-time"[^>]*>\d{2}:\d{2}<\/time><\/div>/g) ?? []).length, 3);
  assert.match(html, /class="message-time" dateTime="1970-01-01T00:00:01\.000Z" title="[^"]+" aria-label="[^"]+"/);
  assert.doesNotMatch(html, /class="message-actions"|aria-label="复制消息"|class="chat-copy"/);
  for (const id of ['short', 'long', 'third']) assert.match(html, new RegExp(`class="message is-out[^"]*" data-message-id="${id}"`));
  assert.match(html, /class="doc-time"/);
  assert.doesNotMatch(html, /doc-mark|data-icon="compose"/);
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
  assert.match(html, />Yes</);
  assert.ok(html.indexOf('Keep this setting?') < html.indexOf('>Yes<'));
});

test('elicitation selects a separate draft and cannot send its text as an ordinary prompt', t => {
  const state = useCockpit.getInitialState();
  const previousConnection = state.connState;
  const previousReady = state.snapshotReady;
  state.connState = 'open';
  state.snapshotReady = true;
  t.after(() => { state.connState = previousConnection; state.snapshotReady = previousReady; });
  const session = { ...fixtureSession('elicitation'), sessionId: 'elicitation-with-native-file' };
  const draft = getSessionDraft(session.sessionId);
  draft.edit('CACHED_PROMPT_NOT_AN_ANSWER');
  t.after(() => draft.edit(''));
  const html = renderToStaticMarkup(createElement(Thread, { session, onLoadMore() {}, onSend: async () => true }));
  assert.doesNotMatch(html, /当前回答或确认操作不接受附件/);
  assert.doesNotMatch(html, /CACHED_PROMPT_NOT_AN_ANSWER/);
  assert.equal(draft.getSnapshot().text, 'CACHED_PROMPT_NOT_AN_ANSWER');
  const send = html.match(/<button[^>]*class="chat-input-btn ck-icon-button send rp"[^>]*>/)?.[0];
  assert.ok(send);
  assert.match(send, /disabled/);
  assert.doesNotMatch(html, /普通消息不会代替确认|chat-composer-hint/);
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
  assert.match(css, /\.activity-head \{[^}]*height: var\(--chat-row-process\)/);
  assert.match(css, /\.activity-title \{[^}]*overflow: hidden;[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis/);
  assert.doesNotMatch(css, /\.tool-name|\.skill-label|\.tool-title/);
  assert.match(css, /\.message-process-content\[hidden\] \{[^}]*display: none/);
  const html = renderToStaticMarkup(createElement(Thread, { session: fixtureSession('process'), readOnly: true, onLoadMore() {} }));
  assert.match(html, /class="process-summary ck-button"/);
  assert.doesNotMatch(html, /class="activity-head ck-button thought-toggle"/);
  assert.match(html, /class="activity-head tool-head tool-toggle ck-button"/);
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
  assert.match(css, /\.activity-detail\.tool-detail \{[^}]*border-inline-start: 0/);
  const source = readFileSync(new URL('./ToolCallRow.tsx', import.meta.url), 'utf8');
  assert.match(source, /nameClipped &&/);
  assert.match(source, /descriptionClipped && description/);
  assert.doesNotMatch(source, /activity-chevron|activity-status/);
});

test('process rows use compact typography with leading status and a trailing name tag', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.match(css, /\.process-summary \{[^}]*min-height: var\(--chat-row-process\);[^}]*font-family: var\(--chat-font-mono\)[^}]*font-size: var\(--chat-text-label\)/);
  assert.match(css, /\.activity-head \{[^}]*grid-template-columns: 1rem minmax\(0, 1fr\)/);
  assert.match(css, /\.activity-icon \{[^}]*grid-column: 1/);
  assert.match(css, /\.tool-label \{[^}]*margin-inline-start: auto/);
  assert.match(css, /\.tool-label \{[^}]*border-radius: var\(--ck-radius\);[^}]*font-size: var\(--chat-text-meta\)/);
  assert.match(css, /\.tool-state-icon\[data-status=in_progress\] \{[^}]*animation: spinner-rotate 0\.7s linear infinite/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.tool-state-icon\[data-status=in_progress\] \{[^}]*animation-duration: 1\.6s/);
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

test('host controls do not add decorative hover while selection and keyboard focus remain visible', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  const all = compile(new URL('../styles/index.scss', import.meta.url).pathname).css;
  assert.doesNotMatch(all, /:hover/);
  assert.match(css, /\.chat :is\(button, a, textarea, summary, \[tabindex\]\):focus-visible \{[^}]*outline: 2px/);
  const primitives = compile(new URL('../styles/primitives/public-ui.scss', import.meta.url).pathname).css;
  assert.match(primitives, /--ck-color-hover: var\(--ripple-color\)/, 'retain the public token for module compatibility');
  assert.match(primitives, /:is\(\.ck-button, \.ck-icon-button, \.ck-input\):focus-visible \{[^}]*outline: 2px/);
  assert.match(all, /\.chatlist-chat\.active \{[^}]*background-color: var\(--selected-fill\)/);
  assert.match(all, /\.manage-row\.is-clickable\.is-active \{[^}]*background: color-mix/);
  assert.match(primitives, /\.ck-primary \{[^}]*background: var\(--ck-color-accent\)/);
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
