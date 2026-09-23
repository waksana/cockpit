import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compile } from 'sass';

const stylesheet = (name: string) => new URL(`../styles/${name}.scss`, import.meta.url);
const css = (name: string) => compile(stylesheet(name).pathname).css;
const source = (name: string) => readFileSync(stylesheet(name), 'utf8');

test('shared compositions own their styles without importing a consuming page', () => {
  const owners = [
    ['copy', ['chat-copy', 'chat-copy-button', 'chat-copy-error', 'copy-value', 'copy-value-button']],
    ['markdown', ['message-body', 'chat-code-block', 'chat-table-scroll']],
    ['role-picker', ['role-picker', 'role-picker-options', 'role-option-heading', 'role-option-description']],
  ] as const;
  const entry = css('index');
  const pages = ['chat', 'info-panel', 'dialog'].map(name => css(`components/${name}`)).join('\n');
  for (const [owner, selectors] of owners) {
    const shared = css(`components/${owner}`);
    assert.doesNotMatch(source(`components/${owner}`), /@use|@import|@forward/);
    for (const selector of selectors) {
      const rule = new RegExp(`^\\.${selector} \\{`, 'gm');
      assert.equal([...shared.matchAll(rule)].length, 1, `${selector} has one owner`);
      assert.equal([...entry.matchAll(rule)].length, 1, `${selector} is loaded once`);
      assert.doesNotMatch(pages, rule, `${selector} does not belong to a page`);
    }
  }
});

test('copy styles preserve feedback geometry and touch sizing while queue layout stays contextual', () => {
  const shared = css('components/copy');
  const chat = css('components/chat');
  assert.match(shared, /\.chat-copy-label > span \{[^}]*grid-area: 1\/1;/);
  assert.match(shared, /\.chat-copy-label-size \{\s*visibility: hidden;/);
  assert.match(shared, /\.copy-value-text, \.copy-value-feedback \{\s*grid-area: 1\/1;/);
  assert.match(shared, /\.copy-value-text\[aria-hidden=true\] \{\s*visibility: hidden;/);
  assert.match(shared, /@media \(pointer: coarse\) \{\s*\.chat-copy-button\.ck-button \{\s*min-block-size: var\(--ck-control-size\);/);
  assert.doesNotMatch(shared, /\.chat-queue|\.info-session-id/);
  assert.match(chat, /\.chat-queue \{\s*--ck-control-size: var\(--chat-control-compact\);/);
  assert.match(chat, /\.chat-queue-copy \.chat-copy \{[^}]*flex-direction: column;/);
  assert.match(chat, /\.chat-queue-copy \.chat-copy-button \{\s*min-block-size: var\(--ck-control-size\);/);
  assert.doesNotMatch(chat, /\.chat-sr-only/);
  assert.match(css('base'), /\.chat-sr-only \{[^}]*position: absolute;[^}]*clip-path: inset\(50%\);/);
});

test('shared Markdown retains fallback typography and chat keeps its deliberate differences', () => {
  const shared = css('components/markdown');
  const chat = css('components/chat');
  const entry = css('index');
  assert.match(shared, /\.message-body \{[^}]*font-size: var\(--chat-text-body, var\(--messages-text-size\)\);[^}]*line-height: var\(--chat-leading-prose, 1\.7\);/);
  assert.match(shared, /\.message-body h3 \{\s*font-size: 1\.1em;/);
  assert.match(chat, /\.chat \.message-body h3 \{\s*font-size: 1\.125em;/);
  assert.match(chat, /\.chat \.message-body h5, \.chat \.message-body h6 \{\s*font-size: 0\.875em;/);
  assert.ok(entry.indexOf('.message-body h3 {') < entry.indexOf('.chat .message-body h3 {'));
  assert.match(chat, /\.chat-pending-summary \.message-body > :first-child \{\s*margin-top: 0;/);
  assert.match(shared, /\.chat-code-block pre:focus-visible \{\s*outline-offset: -3px;/);
});

test('role cards put the check after left-aligned wrapping content without changing other choice cards', () => {
  const roles = css('components/role-picker');
  const shared = css('primitives/host-ui');
  assert.match(roles, /\.role-option > \.ui-choice-check \{\s*order: 1;\s*\}/);
  assert.match(roles, /\.role-option-heading \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.doesNotMatch(roles, /justify-content: space-between|padding-inline-start|margin-inline-start/);
  assert.match(roles, /\.role-option-name \{[^}]*overflow-wrap: anywhere;/);
  assert.match(roles, /\.role-option-description \{[^}]*overflow-wrap: anywhere;/);
  assert.match(shared, /\.ui-choice-check \{[^}]*flex: none;[^}]*visibility: hidden;/);
  assert.match(shared, /\.ui-choice-card\[data-selected\] \.ui-choice-check \{\s*visibility: visible;/);
  assert.doesNotMatch(shared, /(?:^|\s)order:|row-reverse/);
});

test('page controls inherit equivalent public defaults without losing their own geometry', () => {
  const sidebar = css('components/sidebar');
  const search = sidebar.match(/\.input-search-input \{([^}]+)\}/)?.[1];
  const row = sidebar.match(/\.chatlist-chat \{([^}]+)\}/)?.[1];
  const subagent = css('components/chat').match(/\.subagent-head \{([^}]+)\}/)?.[1];
  assert.ok(search && row && subagent);
  assert.doesNotMatch(search, /(?:^|\s)(?:color|font-size|line-height):/);
  assert.doesNotMatch(row, /(?:^|\s)(?:color|cursor):/);
  assert.doesNotMatch(subagent, /(?:^|\s)(?:border|background|cursor):/);
  assert.match(search, /border-radius: calc\(var\(--height\) \/ 2\);/);
  assert.match(row, /grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(subagent, /min-height: 44px;[^}]*font: inherit;[^}]*color: inherit;/);
});
