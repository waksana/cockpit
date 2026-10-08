import { act, fireEvent, render, screen, userEvent, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, useState } from 'react';
import type { ElicitationContent, ElicitationRequest, PendingDecision } from '@cockpit/protocol';
import { PendingDecisionCard } from './PendingDecision';
import { Thread } from './Thread';
import { fixtureSession } from '../dev/chat-fixtures';
import { useCockpit } from '../net/store';

const request: ElicitationRequest = {
  requestId: 'form', message: 'Confirm synthetic action', actions: ['accept', 'decline', 'cancel'],
  requestedSchema: { type: 'object', properties: {
    confirmed: { type: 'boolean', title: 'Confirm', description: 'An explicit yes or no is required.' },
    label: { type: 'string', title: 'Label', minLength: 2 },
    count: { type: 'integer', title: 'Count', minimum: 0, maximum: 3, default: 0 },
    choice: { type: 'string', title: 'Choice', enum: ['', 'b'], enumNames: ['Empty value', 'Bee'], default: 'b' },
    tags: { type: 'array', title: 'Tags', items: { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] } },
  }, required: ['confirmed', 'label'] },
};
type Reply = [string, string, ElicitationContent | undefined];

function Fixture({ requests = [request], replies, disabled = false, sessionId = 'synthetic' }: {
  requests?: ElicitationRequest[]; replies: Reply[]; disabled?: boolean; sessionId?: string;
}) {
  const decisions: PendingDecision[] = requests.map(request => ({ kind: 'elicitation', request }));
  const [selected, select] = useState(decisions[0]);
  return createElement(PendingDecisionCard, { sessionId, decisions, selected, onSelect: select,
    pending: false, disabled: { ask: false, plan: false, elicitation: disabled },
    onChoice: () => assert.fail(), onPlan: () => assert.fail(),
    onElicitation: (request, action, content) => { replies.push([request.requestId, action, content]); } });
}

test('typed fields require valid input and submit explicit false, zero, defaults and multi-select values', async () => {
  const replies: Reply[] = [];
  render(createElement(Fixture, { replies }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '同意' }));
  assert.equal(replies.length, 0);
  assert.match(screen.getByRole('alert').textContent!, /confirmed/);
  await user.selectOptions(screen.getByLabelText('Confirm *'), 'false');
  await user.type(screen.getByLabelText('Label *'), 'ok');
  await user.selectOptions(screen.getByLabelText('Choice'), '0');
  await user.selectOptions(screen.getByLabelText('Tags'), ['0', '1']);
  await user.click(screen.getByRole('button', { name: '同意' }));
  assert.deepEqual(replies, [['form', 'accept', { confirmed: false, label: 'ok', count: 0, choice: '', tags: ['a', 'b'] }]]);
});

test('decline/cancel never validate or submit unfinished form values; unsupported forms explain the missing accept', async () => {
  const replies: Reply[] = [];
  const view = render(createElement(Fixture, { replies }));
  await userEvent.setup().click(screen.getByRole('button', { name: '拒绝' }));
  await userEvent.setup().click(screen.getByRole('button', { name: '取消' }));
  assert.deepEqual(replies, [['form', 'decline', undefined], ['form', 'cancel', undefined]]);
  view.unmount();
  render(createElement(Fixture, { replies, requests: [{ requestId: 'url', message: 'External action',
    actions: ['decline', 'cancel'], unsupportedReason: 'URL elicitation acceptance is unsupported.' }] }));
  assert.equal(screen.queryByRole('button', { name: '同意' }), null);
  assert.match(screen.getByRole('status').textContent!, /URL elicitation/);
});

test('optional enum defaults can be cleared without submitting an empty-string enum value', async () => {
  const replies: Reply[] = [];
  render(createElement(Fixture, { replies }));
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Confirm *'), 'false');
  await user.type(screen.getByLabelText('Label *'), 'ok');
  await user.selectOptions(screen.getByLabelText('Choice'), '');
  await user.click(screen.getByRole('button', { name: '同意' }));
  assert.deepEqual(replies, [['form', 'accept', { confirmed: false, label: 'ok', count: 0 }]]);
});

test('optional formatted strings can be explicitly omitted after clearing a default', async () => {
  const replies: Reply[] = [];
  const schema = { type: 'object', properties: { email: { type: 'string', format: 'email', default: 'default@example.com' } } } as const;
  render(createElement(Fixture, { replies, requests: [{ ...request, requestedSchema: schema }] }));
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText('email'));
  await user.click(screen.getByRole('button', { name: '同意' }));
  assert.equal(replies.length, 0);
  await user.click(screen.getByRole('button', { name: '不提供 email' }));
  await user.click(screen.getByRole('button', { name: '同意' }));
  assert.deepEqual(replies, [['form', 'accept', {}]]);
});

test('field drafts survive decision tabs but do not leak into a different session', async () => {
  const replies: Reply[] = [];
  const second = { ...request, requestId: 'second' };
  const view = render(createElement(Fixture, { requests: [request, second], replies }));
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Label *'), 'first draft');
  await user.click(screen.getByRole('tab', { name: '工具确认 2' }));
  assert.equal((screen.getByLabelText('Label *') as HTMLInputElement).value, '');
  await user.type(screen.getByLabelText('Label *'), 'second draft');
  await user.click(screen.getByRole('tab', { name: '工具确认 1' }));
  assert.equal((screen.getByLabelText('Label *') as HTMLInputElement).value, 'first draft');
  view.rerender(createElement(Fixture, { requests: [request, second], replies, sessionId: 'another' }));
  assert.equal((screen.getByLabelText('Label *') as HTMLInputElement).value, '');
});

test('disconnected form controls and synthetic submit cannot send a response', async () => {
  const replies: Reply[] = [];
  const view = render(createElement(Fixture, { replies, disabled: true }));
  assert.equal((screen.getByLabelText('Label *') as HTMLInputElement).disabled, true);
  await act(() => fireEvent.submit(view.container.querySelector('form')!));
  await userEvent.setup().click(screen.getByRole('button', { name: '取消' }));
  assert.equal(replies.length, 0);
});

test('Thread forwards form content once, retains drafts on failure, and empty forms use explicit content', async t => {
  const previous = useCockpit.getState();
  useCockpit.setState({ connState: 'open', snapshotReady: true });
  t.after(() => useCockpit.setState(previous, true));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No real backend requests'));
  const replies: Reply[] = [];
  let finish!: (value: boolean) => void;
  const held = new Promise<boolean>(resolve => { finish = resolve; });
  const session = { ...fixtureSession('elicitation'), sessionId: 'form-thread', elicitation: request };
  const view = render(createElement(Thread, { session, onLoadMore: () => {}, onRespondElicitation: async (...args) => {
    replies.push([args[0], args[1], args[2]]);
    return held;
  } }));
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Confirm *'), 'true');
  await user.type(screen.getByLabelText('Label *'), 'ready');
  await user.click(screen.getByRole('button', { name: '同意' }));
  await act(() => { fireEvent.submit(view.container.querySelector('form')!); });
  assert.deepEqual(replies, [['form', 'accept', { confirmed: true, label: 'ready', count: 0, choice: 'b' }]]);
  await act(async () => finish(false));
  await waitFor(() => assert.equal((screen.getByRole('button', { name: '同意' }) as HTMLButtonElement).disabled, false));
  assert.equal((screen.getByLabelText('Label *') as HTMLInputElement).value, 'ready');
  view.unmount();
  render(createElement(Fixture, { replies, requests: [{ requestId: 'empty', message: 'Confirm',
    actions: ['accept', 'decline', 'cancel'], requestedSchema: { type: 'object', properties: {} } }] }));
  await user.click(screen.getByRole('button', { name: '同意' }));
  assert.deepEqual(replies.at(-1), ['empty', 'accept', {}]);
});
