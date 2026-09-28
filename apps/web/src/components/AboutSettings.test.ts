import { act, render, screen, userEvent, waitFor, within } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { AboutSettings } from './AboutSettings';
import { cockpitApi } from '../net/api';
import { useCockpit } from '../net/store';
import { NetClient } from '../net/client';

function fixture(t: TestContext) {
  const previous = useCockpit.getState();
  useCockpit.setState({ connState: 'open' });
  t.mock.method(cockpitApi, 'moduleInventory', async () => ({ active: [], errors: [] }));
  t.after(() => useCockpit.setState(previous, true));
  return { instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSha: 'a'.repeat(40) };
}

for (const version of ['dev+aaaaaaaaaaaa', '0.0.0-rolling.42']) {
  test(`About displays authoritative backend identity ${version} without changing it`, async t => {
    const identity = { ...fixture(t), version };
    t.mock.method(cockpitApi, 'identity', async () => identity);
    render(createElement(AboutSettings));
    await screen.findByText(version);
    assert.ok(screen.getByText(identity.sourceSha));
    assert.equal(screen.queryByRole('dialog'), null);
  });
}

test('About exposes missing source, read errors and explicit refresh without retaining stale identity', async t => {
  const identity = { ...fixture(t), version: 'dev+unknown', sourceSha: null };
  t.mock.method(cockpitApi, 'identity', async () => identity);
  render(createElement(AboutSettings));
  await screen.findByText('dev+unknown');
  assert.ok(screen.getByText('不可用'));
  t.mock.method(cockpitApi, 'identity', async () => { throw new Error('identity unavailable'); });
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新关于信息' }));
  await screen.findByText(/identity unavailable/);
  assert.equal(screen.queryByText('dev+unknown'), null);
});

test('About releases obsolete reads on disconnect and unmount', async t => {
  const identity = { ...fixture(t), version: '0.0.0-rolling.2' };
  let signal: AbortSignal | undefined;
  let finish!: (value: typeof identity) => void;
  t.mock.method(cockpitApi, 'identity', (input?: AbortSignal) => {
    signal = input;
    return new Promise<typeof identity>(resolve => { finish = resolve; });
  });
  const view = render(createElement(AboutSettings));
  await waitFor(() => assert.ok(signal));
  act(() => useCockpit.setState({ connState: 'connecting', connectionGeneration: 1 }));
  assert.equal(signal!.aborted, true);
  await act(async () => finish(identity));
  assert.equal(screen.queryByText(identity.version), null);
  view.unmount();
});

test('identity client reads the uncached backend endpoint and rejects malformed provenance', async t => {
  const identity = { ...fixture(t), version: '0.0.0-rolling.42' };
  const client = new NetClient({ onEvent() {}, onStateChange() {} });
  t.after(() => client.disconnect());
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.ok(url.endsWith('/version'));
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-store');
    return Response.json(identity);
  });
  assert.deepEqual(await client.identity(controller.signal), identity);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...identity, sourceSha: 'made-up' }));
  await assert.rejects(client.identity());
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(client.identity(), /503/);
});

test('About lists loaded module identities, unknown versions and failures independently of host identity', async t => {
  const identity = { ...fixture(t), version: 'dev+fixture' };
  t.mock.method(cockpitApi, 'identity', async () => identity);
  t.mock.method(cockpitApi, 'moduleInventory', async () => ({
    active: [
      { id: 'backend-only', name: 'Backend only', version: '1.2.3' },
      { id: 'unknown', name: 'Unknown version', version: null },
    ],
    errors: [
      { id: 'broken', stage: 'activation', error: 'Synthetic activation failure' },
      { id: 'backend-only', stage: 'runtime', error: 'Synthetic runtime failure' },
    ],
  }));
  render(createElement(AboutSettings));
  const modules = screen.getByRole('region', { name: '已加载模块' });
  await within(modules).findByText('Backend only');
  assert.ok(within(modules).getByText('backend-only', { exact: true }));
  assert.ok(within(modules).getByText('1.2.3'));
  assert.ok(within(modules).getByText('版本未知'));
  assert.ok(within(modules).getByText(/broken · 加载失败/));
  assert.ok(within(modules).getByText(/backend-only · 运行错误/));
  t.mock.method(cockpitApi, 'moduleInventory', async () => { throw new Error('Inventory unavailable'); });
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新关于信息' }));
  await within(modules).findByText(/Inventory unavailable/);
  assert.equal(within(modules).queryByText('1.2.3'), null);
  assert.ok(screen.getByText(identity.version));
  t.mock.method(cockpitApi, 'moduleInventory', async () => ({ active: [], errors: [] }));
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新关于信息' }));
  await within(modules).findByText('当前宿主未加载模块。');
});

test('module inventory is invalidated on reconnect and ignores late reads after unmount', async t => {
  const identity = { ...fixture(t), version: 'dev+fixture' };
  t.mock.method(cockpitApi, 'identity', async () => identity);
  const inventory = { active: [{ id: 'fixture', version: '1.0.0' }], errors: [] };
  let signal: AbortSignal | undefined;
  let finish!: (value: typeof inventory) => void;
  const reads = t.mock.method(cockpitApi, 'moduleInventory', (input?: AbortSignal) => {
    signal = input;
    return new Promise<typeof inventory>(resolve => { finish = resolve; });
  });
  const view = render(createElement(AboutSettings));
  await waitFor(() => assert.ok(signal));
  act(() => useCockpit.setState({ connState: 'connecting', connectionGeneration: 1 }));
  assert.ok(signal!.aborted);
  await act(async () => finish(inventory));
  assert.equal(screen.queryByText('1.0.0'), null);
  act(() => useCockpit.setState({ connState: 'open' }));
  await waitFor(() => assert.equal(reads.mock.callCount(), 2));
  view.unmount();
  assert.ok(signal!.aborted);
  await act(async () => finish(inventory));
  assert.equal(screen.queryByText('1.0.0'), null);
});

test('module inventory client reads existing bootstrap without loading code and rejects unavailable data', async t => {
  fixture(t);
  const client = new NetClient({ onEvent() {}, onStateChange() {} });
  t.after(() => client.disconnect());
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.ok(url.endsWith('/_modules'));
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-store');
    return Response.json({
      active: [{ id: 'backend-only', name: 'Backend only', version: '1.2.3', digest: 'a'.repeat(64) }],
      modules: [], errors: [],
    });
  });
  assert.deepEqual(await client.moduleInventory(controller.signal), {
    active: [{ id: 'backend-only', name: 'Backend only', version: '1.2.3' }], errors: [],
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ modules: [], errors: [] }));
  await assert.rejects(client.moduleInventory());
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(client.moduleInventory(), /503/);
});
