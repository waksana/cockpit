import { render, screen, userEvent, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { SessionDeleteDialog } from './SessionDeleteDialog';
import { useCockpit } from '../net/store';

function withStore(t: TestContext, deleteSession: (sessionId: string) => Promise<void>) {
  const previous = useCockpit.getState();
  useCockpit.setState({ ...previous, connState: 'open', deleteSession }, true);
  t.after(() => { useCockpit.setState(previous, true); });
}

test('native deletion uses the ordinary confirmation and retains module data without preflight', async t => {
  const fetchCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    throw new Error(`Unexpected fetch: ${String(input)}`);
  });
  let resolveDelete!: () => void;
  const deleted: string[] = [];
  const successes: string[] = [];
  withStore(t, async sessionId => {
    deleted.push(sessionId);
    await new Promise<void>(resolve => { resolveDelete = resolve; });
  });

  render(createElement(SessionDeleteDialog, {
    sessionId: 'target-a', name: 'Target A',
    onCancel() {},
    onSuccess() { successes.push('done'); },
  }));

  assert.equal(screen.getByRole('dialog', { name: '永久删除会话' }).getAttribute('aria-busy'), 'false');
  assert.match(screen.getByText(/永久删除「Target A」/).textContent ?? '', /无法恢复/);
  assert.match(screen.getByText(/永久删除「Target A」/).textContent ?? '', /工作目录、托管文件和外部数据不会删除/);
  assert.equal(screen.queryByText(/原生|解除关联并删除|预览|planId|operationId/), null);

  const user = userEvent.setup();
  const confirm = screen.getByRole('button', { name: '永久删除' });
  await user.dblClick(confirm);
  assert.deepEqual(deleted, ['target-a']);
  assert.deepEqual(successes, []);
  assert.equal(fetchCalls.length, 0);
  assert.equal(screen.getByRole('dialog', { name: '永久删除会话' }).getAttribute('aria-busy'), 'true');
  assert.equal(screen.getByRole('button', { name: '处理中…' }).getAttribute('disabled'), '');

  resolveDelete();
  await waitFor(() => assert.deepEqual(successes, ['done']));
  assert.equal(fetchCalls.length, 0);
});
