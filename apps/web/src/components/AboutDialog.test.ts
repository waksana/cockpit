import { act, render, screen, userEvent, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { AboutDialog } from './AboutDialog';
import { cockpitApi } from '../net/api';
import { useCockpit } from '../net/store';
import { NetClient } from '../net/client';

function fixture(t: TestContext) {
  const previous = useCockpit.getState();
  useCockpit.setState({ connState: 'open' });
  t.after(() => useCockpit.setState(previous, true));
  return { instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSha: 'a'.repeat(40) };
}

for (const version of ['dev+aaaaaaaaaaaa', '0.0.0-rolling.42']) {
  test(`About displays authoritative backend identity ${version} without changing it`, async t => {
    const identity = { ...fixture(t), version };
    t.mock.method(cockpitApi, 'identity', async () => identity);
    const close = t.mock.fn();
    render(createElement(AboutDialog, { onClose: close }));
    await screen.findByText(version);
    assert.ok(screen.getByText(identity.sourceSha));
    await userEvent.setup().click(screen.getByRole('button', { name: '关闭' }));
    assert.equal(close.mock.callCount(), 1);
  });
}

test('About exposes missing source, read errors and explicit refresh without retaining stale identity', async t => {
  const identity = { ...fixture(t), version: 'dev+unknown', sourceSha: null };
  t.mock.method(cockpitApi, 'identity', async () => identity);
  render(createElement(AboutDialog, { onClose() {} }));
  await screen.findByText('dev+unknown');
  assert.ok(screen.getByText('不可用'));
  t.mock.method(cockpitApi, 'identity', async () => { throw new Error('identity unavailable'); });
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }));
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
  const view = render(createElement(AboutDialog, { onClose() {} }));
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
