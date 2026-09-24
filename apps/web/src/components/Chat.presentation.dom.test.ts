import { render, screen, userEvent, within } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { fixtureSession } from '../dev/chat-fixtures';
import { getDraftSession } from '../lib/draftSelection';
import { getSessionDraft } from '../lib/textDraft';
import { useCockpit } from '../net/store';
import { Shell, DetailPane } from './Shell';
import { Thread } from './Thread';
import { ToolCallRow } from './ToolCallRow';
import type { ToolCall } from '../net/types';

function withConnectedStore(t: TestContext) {
  const previous = useCockpit.getState();
  useCockpit.setState({ ...previous, connState: 'open', snapshotReady: true }, true);
  t.after(() => { useCockpit.setState(previous, true); });
}

test('chat input uses one disclosure-owned composer without measuring or mode controls', async t => {
  withConnectedStore(t);
  const session = fixtureSession('ask-queued');
  const prompt = getSessionDraft(session.sessionId);
  prompt.edit('');
  getDraftSession(session.sessionId).candidate({ kind: 'ask', requestId: session.ask!.requestId }).edit('');
  t.after(() => {
    prompt.edit('');
    getDraftSession(session.sessionId).candidate({ kind: 'ask', requestId: session.ask!.requestId }).edit('');
  });

  render(createElement(Thread, { session, onLoadMore() {} }));

  const card = document.querySelector<HTMLElement>('.chat-input-card');
  assert.ok(card);
  assert.equal(card.dataset.open, 'true');
  assert.equal(card.dataset.header, 'true');
  assert.equal(card.dataset.decision, 'true');
  assert.equal(card.dataset.question, 'true');
  assert.equal(screen.getAllByRole('textbox', { name: '消息输入' }).length, 1);
  assert.equal(screen.queryByRole('button', { name: /模式|mode/i }), null);
  assert.equal(document.body.textContent?.includes('mode-menu'), false);
  assert.equal(document.body.textContent?.includes('chat-topbar-mode'), false);
  assert.equal(document.body.textContent?.includes('chat-answer-toggle'), false);
  await userEvent.setup().click(screen.getByRole('button', { name: /^收起输入卡片：/ }));
  assert.equal(card.dataset.open, 'false');
  assert.equal(card.dataset.open, 'false');
});

test('CSS shell ownership has no JavaScript viewport controller side effects', () => {
  render(createElement(Shell, {
    ariaLabel: 'layout',
    main: createElement(DetailPane, {
      ariaLabel: 'content', mobileVisible: true,
      children: createElement('div', { className: 'owned-scroll' }, 'content'),
    }),
  }));
  assert.ok(document.querySelector('.cockpit-shell'));
  assert.equal('visualViewport' in window, false);
  assert.equal(document.querySelector('[data-chat-viewport], .chat-viewport'), null);
});

test('right click keeps browser text selection ownership instead of mounting a copy menu', () => {
  const session = fixtureSession('reading');
  render(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  const transcript = screen.getByLabelText('对话消息');
  transcript.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(screen.queryByRole('menu'), null);
  assert.equal(screen.queryByRole('button', { name: '复制消息' }), null);
  assert.equal(document.body.textContent?.includes('copyNotice'), false);
});

test('expanded tools show full metadata only when observable clipping requires it', async t => {
  let clipped = false;
  const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) {
    return this.classList.contains('tool-description') && clipped ? 200 : 100;
  } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) {
    return 100;
  } });
  t.after(() => {
    if (scrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scrollWidth);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  });
  const tool: ToolCall = {
    toolCallId: 'mcp', name: 'cockpit-task-task_read', title: 'task_read',
    mcpServerName: 'cockpit-task', mcpToolName: 'task_read', status: 'completed',
  };
  const view = render(createElement(ToolCallRow, { tc: tool, sessionId: 'session' }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /展开细节：cockpit-task-task_read/ }));
  assert.ok(screen.getByText('工具名'));
  assert.ok(screen.getByText('cockpit-task-task_read'));
  assert.ok(screen.getByText('MCP 服务器'));
  assert.ok(screen.getAllByText('cockpit-task').length >= 2);
  assert.ok(screen.getByText('MCP 工具名'));
  assert.equal(within(document.querySelector('.tool-detail') as HTMLElement).queryByText('说明'), null);

  await user.click(screen.getByRole('button', { name: /收起细节：cockpit-task-task_read/ }));
  view.unmount();
  clipped = true;
  const builtin: ToolCall = { ...tool, toolCallId: 'builtin', name: 'functions.view', title: 'Read source', mcpServerName: 'ignored' };
  render(createElement(ToolCallRow, { tc: builtin, sessionId: 'session' }));
  await user.click(screen.getByRole('button', { name: /展开细节：functions.view/ }));
  assert.ok(screen.getByText('functions.view'));
  assert.ok(screen.getByText('说明'));
  assert.ok(screen.getAllByText('Read source').length >= 2);
  assert.equal(document.body.textContent?.includes('activity-chevron'), false);
  assert.equal(document.body.textContent?.includes('activity-status'), false);
});
