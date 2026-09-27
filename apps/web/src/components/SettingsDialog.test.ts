import { act, fireEvent, render, screen, userEvent, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement, Fragment, useState } from 'react';
import type { ActivateFrontend } from '@cockpit/module-api/frontend';
import { cockpitApi } from '../net/api';
import { useCockpit } from '../net/store';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { ModuleRuntimeProvider } from './ModuleComponents';
import { SettingsDialog } from './SettingsDialog';
import { dismissUxError, getUxErrors } from '../lib/errorReporter';
import { recordOperationFailure } from '../lib/operationErrors';

function fixture(t: TestContext) {
  const previous = useCockpit.getState();
  useCockpit.setState({ connState: 'open' });
  t.after(() => useCockpit.setState(previous, true));
  let modelId = 'gpt-6-astra';
  const reads = t.mock.method(cockpitApi, 'sessionDefaults', async () => ({
    modelId, models: [{ modelId: 'gpt-6-astra', name: 'GPT-6 Astra' }, { modelId: 'second', name: 'Second' }], modelError: null,
  }));
  const writes = t.mock.method(cockpitApi, 'setSessionDefaults', async (next: string) => {
    modelId = next;
    return { modelId };
  });
  t.mock.method(cockpitApi, 'identity', async () => ({
    instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 'dev+fixture', sourceSha: 'a'.repeat(40),
  }));
  const close = t.mock.fn();
  return { close, reads, writes };
}

async function moduleFixture(t: TestContext, crashOnClick = false, withPeer = false) {
  const digest = 'a'.repeat(64);
  const disposed: string[] = [];
  function Preferences() {
    const [failed, setFailed] = useState(false);
    if (failed) throw new Error('Synthetic settings render failure');
    return createElement('section', { 'aria-label': '模块偏好' },
      createElement('h3', null, '模块偏好'),
      createElement('button', {
        type: 'button', role: 'switch', 'aria-checked': false,
        onClick: () => { if (crashOnClick) setFailed(true); },
      }, '示例开关'));
  }
  function HealthyPreferences() {
    return createElement('section', { 'aria-label': '健康模块' }, createElement('h3', null, '健康模块'));
  }
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: ['preferences', ...(withPeer ? ['z-healthy'] : [])].map(id => ({
      id, name: id, version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/${id}/${digest}/api`, entry: `/_modules/assets/${id}/${digest}/entry.js`,
    })), errors: [] }),
    load: async () => ({ activate: ((context => {
      assert.equal(context.settingsVersion, 1);
      return {
        apiVersion: 2,
        components: [{
          id: 'preferences', boundary: 'settings',
          wrap: Base => props => createElement(Fragment, null, createElement(Base, props),
            createElement(context.moduleId === 'preferences' ? Preferences : HealthyPreferences)),
        }],
        dispose() { disposed.push(context.moduleId); },
      };
    }) satisfies ActivateFrontend) }),
  });
  t.after(() => runtime.stop());
  await runtime.start();
  return { runtime, disposed: () => disposed.includes('preferences'), disposedModules: disposed };
}

test('a crashing settings module reports once and keeps host preferences and their draft usable', async t => {
  const f = fixture(t);
  const module = await moduleFixture(t, true);
  t.mock.method(console, 'error', () => {});
  t.after(() => { for (const error of getUxErrors()) dismissUxError(error.id); });
  render(createElement(ModuleRuntimeProvider, {
    runtime: module.runtime, children: createElement(SettingsDialog, { onClose: f.close }),
  }));
  const user = userEvent.setup();
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  await user.selectOptions(screen.getByRole('combobox'), 'second');
  await user.click(screen.getByRole('switch', { name: '示例开关' }));
  assert.equal(module.disposed(), true);
  assert.equal(screen.queryByRole('region', { name: '模块偏好' }), null);
  assert.equal((screen.getByRole('combobox') as HTMLSelectElement).value, 'second');
  assert.equal(f.reads.mock.callCount(), 1);
  assert.equal(screen.getAllByRole('alert').length, 1);
  assert.match(screen.getByRole('alert').textContent!, /Synthetic settings render failure/);
  assert.ok(screen.getByRole('heading', { name: '关于 Cockpit' }));
  await user.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByText('已保存默认模型。');
});

test('a settings section failure revokes its own module, not the healthy inner peer', async t => {
  const f = fixture(t);
  const module = await moduleFixture(t, true, true);
  t.mock.method(console, 'error', () => {});
  t.after(() => { for (const error of getUxErrors()) dismissUxError(error.id); });
  render(createElement(ModuleRuntimeProvider, {
    runtime: module.runtime, children: createElement(SettingsDialog, { onClose: f.close }),
  }));
  const user = userEvent.setup();
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  await user.selectOptions(screen.getByRole('combobox'), 'second');
  await user.click(screen.getByRole('switch', { name: '示例开关' }));
  assert.deepEqual(module.disposedModules, ['preferences']);
  assert.deepEqual(module.runtime.getSnapshot().map(value => value.asset.id), ['z-healthy']);
  assert.ok(screen.getByRole('region', { name: '健康模块' }));
  assert.equal((screen.getByRole('combobox') as HTMLSelectElement).value, 'second');
  assert.equal(f.reads.mock.callCount(), 1);
  await user.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByText('已保存默认模型。');
});

test('disconnect keeps the draft but rejects a late success from the old connection', async t => {
  const f = fixture(t);
  let finish!: (result: { modelId: string }) => void;
  t.mock.method(cockpitApi, 'setSessionDefaults',
    () => new Promise<{ modelId: string }>(resolve => { finish = resolve; }));
  render(createElement(SettingsDialog, { onClose: f.close }));
  const user = userEvent.setup();
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  await user.selectOptions(screen.getByRole('combobox'), 'second');
  await user.click(screen.getByRole('button', { name: '保存' }));
  act(() => useCockpit.setState({ connState: 'connecting' }));
  assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), true);
  assert.equal(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled'), true);
  assert.equal((screen.getByRole('combobox') as HTMLSelectElement).value, 'second');
  await act(async () => finish({ modelId: 'second' }));
  assert.equal(screen.queryByText('已保存默认模型。'), null);
  act(() => useCockpit.setState(state => ({ connState: 'open', connectionGeneration: state.connectionGeneration + 1 })));
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  assert.equal((screen.getByRole('combobox') as HTMLSelectElement).value, 'second');
  assert.equal(f.reads.mock.callCount(), 2);
});

test('a late mutation failure after closing settings retains one global error owner', async t => {
  const f = fixture(t);
  let reject!: (reason: Error) => void;
  t.mock.method(cockpitApi, 'setSessionDefaults',
    () => new Promise<{ modelId: string }>((_, fail) => { reject = fail; }));
  t.mock.method(console, 'error', () => {});
  t.after(() => { for (const error of getUxErrors()) dismissUxError(error.id); });
  const view = render(createElement(SettingsDialog, { onClose: f.close }));
  const user = userEvent.setup();
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  await user.selectOptions(screen.getByRole('combobox'), 'second');
  await user.click(screen.getByRole('button', { name: '保存' }));
  view.unmount();
  const failure = new Error('Synthetic model save lost acknowledgement');
  recordOperationFailure(failure, { message: failure.message, mutation: true, uncertain: true });
  await act(async () => reject(failure));
  assert.equal(getUxErrors().filter(error => error.message === failure.message).length, 1);
  assert.equal(screen.queryByText('已保存默认模型。'), null);
});

test('settings are a single dialog with module sections between the model and About', async t => {
  const f = fixture(t);
  const { runtime } = await moduleFixture(t);
  render(createElement(ModuleRuntimeProvider, {
    runtime, children: createElement(SettingsDialog, { onClose: f.close }),
  }));
  await screen.findByText('dev+fixture');
  assert.equal(screen.getAllByRole('dialog').length, 1);
  assert.deepEqual(screen.getAllByRole('heading').map(node => node.textContent),
    ['设置', '默认模型', '模块偏好', '关于 Cockpit']);
  assert.ok(screen.getByRole('switch', { name: '示例开关' }));
  fireEvent.click(screen.getByRole('heading', { name: '设置' }));
  assert.equal(f.close.mock.callCount(), 0);
  fireEvent(screen.getByRole('dialog', { name: '设置' }), new Event('cancel', { cancelable: true }));
  assert.equal(f.close.mock.callCount(), 1);
});

test('removing a settings module preserves the host draft, read owner and pending save', async t => {
  const f = fixture(t);
  const module = await moduleFixture(t);
  let finish!: (result: { modelId: string }) => void;
  const save = t.mock.method(cockpitApi, 'setSessionDefaults',
    () => new Promise<{ modelId: string }>(resolve => { finish = resolve; }));
  render(createElement(ModuleRuntimeProvider, {
    runtime: module.runtime, children: createElement(SettingsDialog, { onClose: f.close }),
  }));
  const user = userEvent.setup();
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  await user.selectOptions(screen.getByRole('combobox'), 'second');
  await user.click(screen.getByRole('button', { name: '保存' }));
  act(() => module.runtime.unregister(module.runtime.getSnapshot()[0]));
  assert.equal(module.disposed(), true);
  assert.equal(screen.queryByRole('region', { name: '模块偏好' }), null);
  assert.equal((screen.getByRole('combobox') as HTMLSelectElement).value, 'second');
  assert.equal(screen.getByRole('button', { name: '保存中…' }).hasAttribute('disabled'), true);
  assert.equal(f.reads.mock.callCount(), 1);
  assert.equal(save.mock.callCount(), 1);
  assert.ok(screen.getByRole('heading', { name: '关于 Cockpit' }));
  await act(async () => finish({ modelId: 'second' }));
  await screen.findByText('已保存默认模型。');
  assert.equal(save.mock.callCount(), 1);
});

test('closing the settings view does not abort an accepted save or publish a late result', async t => {
  const f = fixture(t);
  let finish!: (result: { modelId: string }) => void;
  const write = t.mock.method(cockpitApi, 'setSessionDefaults',
    () => new Promise<{ modelId: string }>(resolve => { finish = resolve; }));
  const view = render(createElement(SettingsDialog, { onClose: f.close }));
  const user = userEvent.setup();
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  await user.selectOptions(screen.getByRole('combobox'), 'second');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await user.click(screen.getByRole('button', { name: '关闭设置' }));
  assert.equal(f.close.mock.callCount(), 1);
  view.unmount();
  await act(async () => finish({ modelId: 'second' }));
  assert.equal(write.mock.callCount(), 1);
  assert.equal(f.reads.mock.callCount(), 1);
  assert.equal(screen.queryByText('已保存默认模型。'), null);
});
