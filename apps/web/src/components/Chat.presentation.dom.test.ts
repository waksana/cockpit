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

test('chat input uses one disclosure-owned composer without mode controls', async t => {
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
  assert.equal(card.dataset.question, undefined, 'the question lives in the transcript card');
  assert.equal(card.querySelector('.chat-decision-card, .chat-ask-q'), null);
  assert.equal(screen.getAllByRole('textbox', { name: '消息输入' }).length, 1);
  assert.equal(screen.queryByRole('button', { name: /模式|mode/i }), null);
  assert.equal(document.querySelector('.mode-menu, .chat-topbar-mode, .chat-answer-toggle, .chat-answer-chevron'), null);
  await userEvent.setup().click(screen.getByRole('button', { name: /^收起输入卡片：/ }));
  assert.equal(card.dataset.open, 'false');
});

test('one decision card holds every pending request; the input answers the selected tab', async t => {
  withConnectedStore(t);
  const session = { ...fixtureSession('decision-stack'), sessionId: 'decision-tabs' };
  const sent: unknown[] = [];
  const planned: string[] = [];
  render(createElement(Thread, {
    session, onLoadMore() {},
    onSend: async request => { sent.push(request); return true; },
    onRespondAsk: async () => true,
    onRespondPlan: async (_id, action) => { planned.push(action); return true; },
    onRespondElicitation: async () => true,
  }));
  t.after(() => { for (const kind of ['ask', 'plan', 'elicitation'] as const) {
    getDraftSession(session.sessionId).candidate({ kind, requestId: `lab-${kind}` }).edit('');
  } });
  assert.equal(document.querySelectorAll('.chat-decision-card[data-state=pending]').length, 1);
  const tabs = screen.getAllByRole('tab');
  assert.deepEqual(tabs.map(tab => tab.textContent), ['问题 1', '计划', '问题 2', '工具确认']);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  const input = () => screen.getByRole('textbox', { name: '消息输入' });
  assert.equal(input().getAttribute('placeholder'), '回答上方问题…');
  const user = userEvent.setup();
  tabs[0].focus();
  await user.keyboard('{ArrowRight}');
  const [, plan] = screen.getAllByRole('tab');
  assert.equal(plan.getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, plan, 'arrow keys move focus with the selection');
  assert.equal(input().getAttribute('placeholder'), '输入修改意见…');
  assert.ok(within(screen.getByRole('tabpanel')).getByText('组件精修计划'));
  await user.type(input(), 'Change step two');
  await user.click(screen.getByRole('button', { name: '提交修改意见' }));
  assert.deepEqual(sent, [{ intent: 'planSupersede', body: { sessionId: session.sessionId, requestId: 'lab-plan', message: 'Change step two' } }]);
  await user.click(screen.getByRole('button', { name: /开始执行（交互）（推荐）/ }));
  assert.deepEqual(planned, ['interactive']);
  await user.click(screen.getAllByRole('tab')[3]);
  assert.equal(input().getAttribute('placeholder'), '请在上方卡片中选择');
});

test('CSS shell ownership has no JavaScript viewport controller side effects', t => {
  const viewportListeners: string[] = [];
  const viewport = Object.assign(new EventTarget(), { width: 1000, height: 800, offsetTop: 0, offsetLeft: 0, scale: 1 });
  t.mock.method(viewport, 'addEventListener', (type: string) => { viewportListeners.push(type); });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  t.after(() => { Reflect.deleteProperty(window, 'visualViewport'); });
  const windowListeners: string[] = [];
  const addWindowListener = window.addEventListener.bind(window);
  t.mock.method(window, 'addEventListener', (type: string, ...rest: [EventListenerOrEventListenerObject, AddEventListenerOptions?]) => {
    windowListeners.push(type);
    addWindowListener(type, ...rest);
  });
  render(createElement(Shell, {
    ariaLabel: 'layout',
    main: createElement(DetailPane, {
      ariaLabel: 'content', mobileVisible: true,
      children: createElement('div', { className: 'owned-scroll' }, 'content'),
    }),
  }));
  assert.ok(document.querySelector('.cockpit-shell'));
  assert.deepEqual(viewportListeners, []);
  assert.equal(windowListeners.includes('resize'), false);
  assert.equal(document.querySelector('[data-chat-viewport], .chat-viewport'), null);
});

test('right click keeps browser text selection ownership instead of mounting a copy menu', () => {
  const session = fixtureSession('reading');
  render(createElement(Thread, { session, readOnly: true, onLoadMore() {} }));
  const transcript = screen.getByLabelText('对话消息');
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  transcript.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(screen.queryByRole('menu'), null);
  assert.equal(screen.queryByRole('button', { name: '复制消息' }), null);
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
  assert.equal(document.querySelector('.activity-chevron, .activity-status'), null);
});
