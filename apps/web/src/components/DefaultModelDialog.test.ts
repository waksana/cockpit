import { render, screen, userEvent, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { DefaultModelDialog } from './DefaultModelDialog';
import { useCockpit } from '../net/store';
import { cockpitApi } from '../net/api';
import { OperationRejected } from '../lib/operationErrors';

const models = [{ modelId: 'gpt-6-astra', name: 'GPT-6 Astra' }, { modelId: 'second', name: 'Second' }];
function fixture(t: TestContext) {
  const previous = useCockpit.getState();
  useCockpit.setState({ connState: 'open' });
  t.after(() => { useCockpit.setState(previous, true); });
  let saved = 'gpt-6-astra';
  const writes: string[] = [];
  t.mock.method(cockpitApi, 'sessionDefaults', async () => ({ modelId: saved, models, modelError: null }));
  t.mock.method(cockpitApi, 'setSessionDefaults', async (modelId: string) => {
    writes.push(modelId); saved = modelId; return { modelId };
  });
  return { writes };
}

test('default-model dialog saves only a selected model and rereads the saved value on reopening', async t => {
  const f = fixture(t);
  let closed = 0;
  const props = { onClose: () => { closed++; } };
  const first = render(createElement(DefaultModelDialog, props));
  const user = userEvent.setup();
  const select = await screen.findByRole('combobox', { name: '新会话模型' });
  await waitFor(() => assert.equal((select as HTMLSelectElement).value, 'gpt-6-astra'));
  assert.ok(screen.getByText(/仅影响之后新建的会话/));
  assert.equal(screen.queryByRole('combobox', { name: '思考力度' }), null);
  assert.equal(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled'), true);
  await user.selectOptions(select, 'second');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => assert.equal(closed, 1));
  assert.deepEqual(f.writes, ['second']);
  first.unmount();
  render(createElement(DefaultModelDialog, props));
  await waitFor(() => assert.equal((screen.getByRole('combobox') as HTMLSelectElement).value, 'second'));
});

test('saving failure stays in the dialog and retains the draft without a success claim', async t => {
  fixture(t);
  t.mock.method(cockpitApi, 'setSessionDefaults', async () => { throw new OperationRejected('disk full'); });
  const close = t.mock.fn();
  render(createElement(DefaultModelDialog, { onClose: close }));
  const user = userEvent.setup();
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  await user.selectOptions(screen.getByRole('combobox'), 'second');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByRole('alert');
  assert.match(screen.getByRole('alert').textContent!, /disk full/);
  assert.equal((screen.getByRole('combobox') as HTMLSelectElement).value, 'second');
  assert.ok(screen.getByText('当前默认值：gpt-6-astra'));
  assert.equal(close.mock.callCount(), 0);
});

for (const catalogFailed of [false, true]) {
  test(`saved unavailable model stays visible when catalog failed=${catalogFailed}`, async t => {
    fixture(t);
    t.mock.method(cockpitApi, 'sessionDefaults', async () => ({
      modelId: 'retired', models: catalogFailed ? null : models,
      modelError: catalogFailed ? 'catalog offline' : 'retired is unavailable',
    }));
    render(createElement(DefaultModelDialog, { onClose() {} }));
    await screen.findByText('当前默认值：retired');
    assert.match(screen.getByRole('alert').textContent!, catalogFailed ? /catalog offline/ : /retired/);
    assert.equal((screen.getByRole('combobox') as HTMLSelectElement).value, 'retired');
    assert.equal(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled'), true);
    if (!catalogFailed) {
      await userEvent.setup().selectOptions(screen.getByRole('combobox'), 'second');
      assert.equal(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled'), false);
    }
  });
}

test('settings read failure is visible and can be explicitly refreshed', async t => {
  fixture(t);
  t.mock.method(cockpitApi, 'sessionDefaults', async () => { throw new Error('settings unreadable'); });
  render(createElement(DefaultModelDialog, { onClose() {} }));
  await screen.findByText(/settings unreadable/);
  assert.equal(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled'), true);
  t.mock.method(cockpitApi, 'sessionDefaults', async () => ({ modelId: 'gpt-6-astra', models, modelError: null }));
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByText('当前默认值：gpt-6-astra');
});
