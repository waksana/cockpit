import { act, fireEvent, render, screen, userEvent, waitFor, within } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { NativeChatEvent, type NativeChatRead } from '@cockpit/protocol';
import type { ActivateFrontend, MessageIdentity } from '@cockpit/module-api/frontend';
import { askMarkdownChoices, askMarkdownQuestion } from '../dev/ask-markdown-fixture';
import { fixtureSession } from '../dev/chat-fixtures';
import { getDraftSession, retireDraftSession } from '../lib/draftSelection';
import { ModuleRuntime, moduleRuntime } from '../lib/moduleRuntime';
import { NativeWindow } from '../net/nativeWindow';
import { useCockpit } from '../net/store';
import { ModuleRuntimeProvider } from './ModuleComponents';
import { AnsweredAskCard, PendingDecisionCard, type PendingDecisionHandlers } from './PendingDecision';
import { Thread } from './Thread';
import { MarkdownLabel } from './MessageBody';

const ask = { requestId: 'markdown-question', question: askMarkdownQuestion, choices: askMarkdownChoices, allowFreeform: true };
const decision = { kind: 'ask' as const, request: ask };
const handlers: PendingDecisionHandlers = {
  sessionId: 'markdown-session', pending: false, disabled: { ask: false, plan: false, elicitation: false },
  onChoice() {}, onPlan() {}, onElicitation() {},
};
const pending = (props: Partial<PendingDecisionHandlers> = {}) => createElement(PendingDecisionCard, {
  ...handlers, ...props, decisions: [decision], selected: decision, onSelect() {},
});

function assertButtonLabel(button: HTMLElement) {
  const phrasing = new Set(['SPAN', 'STRONG', 'EM', 'DEL', 'CODE', 'BR', 'SUP']);
  for (const element of Array.from(button.querySelectorAll('*'))) {
    assert.ok(phrasing.has(element.tagName), `button contains only noninteractive phrasing, not ${element.tagName}`);
    assert.equal(element.hasAttribute('tabindex'), false);
    assert.equal(element.hasAttribute('role'), false);
    assert.equal(element.hasAttribute('href'), false);
    assert.equal(element.hasAttribute('src'), false);
  }
  assert.equal(button.getAttribute('aria-label'), null, 'the visible choice itself supplies the accessible name');
  assert.equal(button.getAttribute('aria-labelledby'), null);
}

function assertMarkdownQuestion(element: HTMLElement) {
  assert.ok(within(element).getByRole('heading', { name: '选择实现方案', level: 2 }));
  assert.equal(element.querySelector('strong')?.textContent, '原始选项');
  assert.equal(element.querySelector('em')?.textContent, '自由回复');
  assert.equal(element.querySelector('del')?.textContent, '不要替换字符串');
  assert.ok(element.querySelector('ul'));
  assert.ok(element.querySelector('ol'));
  assert.ok(element.querySelector('blockquote'));
  assert.equal(within(element).getByRole('link', { name: '说明' }).getAttribute('href'), '/synthetic/ask-guide');
  assert.ok(within(element).getByRole('button', { name: '复制代码' }));
  assert.ok(within(element).getByRole('region', { name: '表格（可横向滚动）' }));
  assert.ok(element.querySelector('pre code.language-ts'));
}

function connect(t: TestContext) {
  const previous = useCockpit.getState();
  useCockpit.setState({ connState: 'open', snapshotReady: true });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No backend request is allowed'));
  t.after(() => useCockpit.setState(previous, true));
}

test('pending ask uses full chat Markdown and preserves the exact ask message boundary', async t => {
  const seen: MessageIdentity[] = [];
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'observer', name: 'Observer', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/observer/${digest}/api`, entry: `/_modules/assets/observer/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate: (() => ({ apiVersion: 2, components: [{
      id: 'message-observer', boundary: 'message', wrap: Base => props => {
        seen.push(props.identity);
        assert.equal(props.complete, true);
        return createElement(Base, { ...props, adornment: createElement('span', { 'aria-label': 'Module marker' }) });
      },
    }] })) satisfies ActivateFrontend }),
  });
  await runtime.start();
  t.after(() => runtime.stop());
  const view = render(createElement(ModuleRuntimeProvider, { runtime, children: pending() }));
  const question = view.container.querySelector<HTMLElement>('.chat-ask-q')!;
  assertMarkdownQuestion(question);
  assert.deepEqual(seen, [{ sessionId: handlers.sessionId, kind: 'ask', id: ask.requestId }]);
  assert.equal(question.nextElementSibling?.getAttribute('aria-label'), 'Module marker',
    'message adornments remain siblings of the original question boundary');
});

test('each Markdown choice is one complete button with readable noninteractive content', () => {
  const view = render(pending());
  const options = view.container.querySelector<HTMLElement>('.chat-ask-choices')!;
  const buttons = within(options).getAllByRole('button');
  assert.equal(buttons.length, askMarkdownChoices.length);
  assert.ok(buttons.every(button => button.parentElement === options), 'no sibling label or separate Choose action');
  assert.equal(view.container.querySelector('.chat-ask-option, .chat-ask-option-body'), null);
  assert.equal(within(options).queryByRole('button', { name: '选择' }), null);
  const first = within(options).getByRole('button', { name: /^保留现有实现/ });
  assert.equal(first.querySelector('strong')?.textContent, '保留现有实现');
  assert.equal(first.querySelector('em')?.textContent, '继续复用');
  assert.equal(first.querySelector('del')?.textContent, '不用另造控件');
  assert.equal(first.querySelector('code')?.textContent, 'pnpm test');
  const complex = within(options).getByRole('button', { name: /^查看细节/ });
  for (const text of ['参考说明', 'pnpm --filter @cockpit/web test', 'long_option_argument_', '项目', '条件',
    '字符串', '原样提交', 'unbroken_choice_', '[x]', '[ ]', '已读条件', '保留草稿', '示意图', '链接图片']) {
    assert.ok(complex.textContent?.includes(text), `complex syntax keeps readable content: ${text}`);
  }
  assert.equal(buttons[2].textContent, askMarkdownChoices[2]);
  for (const button of buttons) assertButtonLabel(button);
});

test('block syntax, references and media become readable phrasing without consulting module renderers', t => {
  t.mock.method(moduleRuntime, 'renderer', () => assert.fail('Button labels must not request module replacements'));
  const body = '# Heading\n\nParagraph *one*.\nSoft break.\n\nParagraph **two**.\n\n'
    + '- Bullet one\n- Bullet two\n\n3. Ordered three\n4. Ordered four\n\n> Quote\n\n'
    + '[reference][target]\n\n[target]: https://example.invalid/guide\n\n'
    + '![Alt label](https://example.invalid/image.png)\n\n---\n\n'
    + 'Footnote[^note]\n\n[^note]: Footnote content.\n\n'
    + '<video src="https://example.invalid/movie.mp4" controls>Literal media</video>';
  const view = render(createElement('button', { type: 'button' }, createElement(MarkdownLabel, { body })));
  const button = screen.getByRole('button');
  assertButtonLabel(button);
  for (const value of ['Heading', 'Paragraph one.', 'Soft break.', 'Paragraph two.', 'Bullet one', 'Bullet two',
    'Ordered three', 'Ordered four', 'Quote', 'reference', 'Alt label', 'Footnote content.', 'Literal media']) {
    assert.ok(button.textContent?.includes(value), `retained content: ${value}`);
  }
  assert.equal(view.container.querySelector('video, a, img, input, section, div, p, ul, ol, li, h1'), null);
});

test('formatted descendants, the button surface and keyboard submit the exact raw Markdown choice', async t => {
  connect(t);
  const calls: Array<[string, string, boolean]> = [];
  const user = userEvent.setup();
  const session = { ...fixtureSession('empty'), sessionId: 'markdown-choice', ask };
  const draft = getDraftSession(session.sessionId).candidate({ kind: 'ask', requestId: ask.requestId });
  draft.edit('Keep this freeform draft');
  let finish!: (accepted: boolean) => void;
  const held = new Promise<boolean>(resolve => { finish = resolve; });
  const view = render(createElement(Thread, {
    session, onLoadMore() {}, onSend: async () => true,
    onRespondAsk: async (id, choice, freeform) => {
      calls.push([id, choice, freeform]);
      return calls.length === 1 ? held : true;
    },
  }));
  t.after(() => { view.unmount(); retireDraftSession(session.sessionId); });
  const select = screen.getByRole('button', { name: /^查看细节/ });
  assertButtonLabel(select);
  await user.click(within(select).getByText('查看细节'));
  assert.deepEqual(calls, [[ask.requestId, askMarkdownChoices[1], false]]);
  await act(() => { fireEvent.click(select); fireEvent.click(select); });
  assert.equal(calls.length, 1, 'pending choice submission is guarded against duplicate clicks');
  assert.equal(select.hasAttribute('disabled'), true);
  await act(async () => finish(false));
  await waitFor(() => assert.equal(select.hasAttribute('disabled'), false));
  assert.equal((screen.getByRole('textbox', { name: '消息输入' }) as HTMLTextAreaElement).value, 'Keep this freeform draft');
  await user.click(select.querySelector('code')!);
  await waitFor(() => assert.equal(select.hasAttribute('disabled'), false));
  await user.click(select);
  await waitFor(() => assert.equal(select.hasAttribute('disabled'), false));
  select.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => assert.equal(select.hasAttribute('disabled'), false));
  select.focus();
  await user.keyboard(' ');
  await waitFor(() => assert.equal(select.hasAttribute('disabled'), false));
  assert.deepEqual(calls, Array.from({ length: 5 }, () => [ask.requestId, askMarkdownChoices[1], false]),
    'clicking formatted content, button area, Enter or Space keeps the original string and wasFreeform=false');
  const first = screen.getByRole('button', { name: /^保留现有实现/ });
  first.focus();
  await user.tab();
  assert.equal(document.activeElement, select, 'no label link, checkbox or code action enters the tab order');
  await user.tab();
  assert.equal(document.activeElement, screen.getByRole('button', { name: askMarkdownChoices[2] }));
});

test('disabled ask selection keeps Markdown readable without enabling submission', async () => {
  let calls = 0;
  const view = render(pending({ disabled: { ask: true, plan: false, elicitation: false }, onChoice: () => { calls++; } }));
  for (const button of Array.from(view.container.querySelectorAll<HTMLButtonElement>('button.chat-ask-choice'))) {
    assert.equal(button.disabled, true);
    assertButtonLabel(button);
    await userEvent.setup().click(button);
    await userEvent.setup().click(button.querySelector('strong, span')!);
  }
  assert.equal(calls, 0);
  assertMarkdownQuestion(view.container.querySelector<HTMLElement>('.chat-ask-q')!);
});

test('pending and answered ask reuse Markdown URL and raw-HTML handling', () => {
  const question = '[unsafe](javascript:alert%281%29)\n\n<script>unsafe()</script>\n\n<strong>literal HTML</strong>';
  const unsafe = { ...decision, request: { ...ask, question, choices: [question] } };
  const view = render(createElement(PendingDecisionCard, {
    ...handlers, decisions: [unsafe], selected: unsafe, onSelect() {},
  }));
  assert.equal(view.container.querySelector('script, strong, [href^="javascript:"]'), null);
  view.unmount();
  const answered = render(createElement(AnsweredAskCard, { question, children: 'Answer' }));
  assert.equal(answered.container.querySelector('script, strong, [href^="javascript:"]'), null);
  assert.match(answered.container.textContent!, /literal HTML/);
});

test('restored native ask history renders original Markdown and the answer without changing stored strings', t => {
  connect(t);
  const session = { ...fixtureSession('empty'), sessionId: 'markdown-history' };
  const events: NativeChatEvent[] = [
    { id: 'start', type: 'tool.execution_start', timestamp: 1, data: {
      toolCallId: 'ask', toolName: 'ask_user', arguments: { question: askMarkdownQuestion },
    } },
    { id: 'complete', type: 'tool.execution_complete', timestamp: 2, data: {
      toolCallId: 'ask', success: true, result: { content: `User selected: ${askMarkdownChoices[0]}` },
    } },
  ];
  const query: NativeChatRead = {
    sessionId: session.sessionId, source: 'persisted', direction: 'backward', max: 32, waitMs: 0, bootstrap: false,
  };
  for (const restoredEvents of [events, NativeChatEvent.array().parse(JSON.parse(JSON.stringify(events)))]) {
    const history = new NativeWindow(undefined, true);
    history.accept({
      ...query, events: restoredEvents, cursor: 'synthetic-end', cursorStatus: 'ok', hasMore: false,
      read: { rpc: 1, events: restoredEvents.length },
    }, query);
    const reply = history.snapshot().messages.find(message => message.subtype === 'ask-reply');
    assert.equal(reply?.replyQuestion, askMarkdownQuestion);
    assert.equal(reply?.content, askMarkdownChoices[0]);
    const view = render(createElement(Thread, {
      session: { ...session, messages: history.snapshot().messages }, readOnly: true, onLoadMore() {},
    }));
    const card = screen.getByRole('group', { name: '已回答的问题' });
    assertMarkdownQuestion(within(card).getByLabelText('回答的问题'));
    assert.equal(card.querySelector('.chat-decision-answer strong')?.textContent, '保留现有实现');
    assert.equal(card.querySelector('button.chat-ask-choice'), null);
    view.unmount();
  }
});

test('missing original questions keep the existing explicit fallback', () => {
  const view = render(createElement(AnsweredAskCard, { children: 'Unlinked answer' }));
  assert.equal(view.container.querySelector('.chat-ask-q')?.textContent, '原问题记录不可用');
  assert.match(view.container.textContent!, /Unlinked answer/);
});
