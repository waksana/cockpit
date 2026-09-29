import { act, render, screen, userEvent, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { Link, MemoryRouter } from 'react-router-dom';
import type { ActivateLegacyFrontend as ActivateFrontend, LegacyModuleFrontendContext as ModuleFrontendContext } from '@cockpit/module-api/frontend';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { ModuleGlobalComponents, ModuleRuntimeProvider } from './ModuleComponents';
import { installWorkspaceFixture } from '../dev/workspace-fixtures';
import { activate as example } from '../dev/module-global-example';
import { useCockpit } from '../net/store';
import App from '../App';

function fixture(activators: Record<string, ActivateFrontend>) {
  const reports: unknown[] = [];
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ errors: [], modules: Object.keys(activators).map(id => ({
      id, name: id, version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/${id}/${digest}/api`, entry: `/_modules/assets/${id}/${digest}/entry.js`,
    })) }),
    load: async url => ({ activate: activators[new URL(url).pathname.split('/')[3]] }),
    report: error => reports.push(error),
  });
  return { runtime, reports };
}

test('global components use host React and survive empty home, menus and session changes in the real App', async t => {
  const prior = useCockpit.getState();
  t.after(() => useCockpit.setState(prior, true));
  installWorkspaceFixture(useCockpit);
  const sessions = useCockpit.getState().sessions;
  useCockpit.setState({ sessions: [], activeId: null });
  let mounts = 0, cleanups = 0;
  const f = fixture({
    example: context => {
      assert.equal(context.react, React);
      assert.equal(context.createPortal, createPortal);
      assert.equal(context.globalComponentVersion, 1);
      const frontend = example(context);
      assert.ok(!('then' in frontend));
      return frontend;
    },
    probe: context => {
      function Probe() {
        const [count, setCount] = context.react.useState(0);
        context.react.useEffect(() => { mounts++; return () => { cleanups++; }; }, []);
        return context.react.createElement('button', { onClick: () => setCount(n => n + 1) }, `Global count ${count}`);
      }
      return { apiVersion: 2, globalComponents: [{ id: 'probe', component: Probe }] };
    },
    legacy: () => ({ apiVersion: 2 }),
  });
  t.after(() => f.runtime.stop());
  await f.runtime.start();
  const h = React.createElement;
  const view = render(h(ModuleRuntimeProvider, { runtime: f.runtime, children:
    h(MemoryRouter, null, h(App),
      h(Link, { to: '/session/demo-chat' }, 'Session A'),
      h(Link, { to: '/session/demo-api' }, 'Session B'),
      h(Link, { to: '/' }, 'Home')) }));
  const user = userEvent.setup();
  const probe = screen.getByRole('button', { name: 'Global count 0' });
  await user.click(probe);
  const trigger = screen.getByRole('button', { name: '全局导航' });
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: 'Global module example' }));
  await screen.findByRole('dialog', { name: 'Global module example' });
  assert.equal(screen.queryByRole('menu'), null);
  assert.equal(mounts, 1);
  // Native focus/trap/close behavior is covered by the browser fixture.
  const dialog = screen.getByRole('dialog', { name: 'Global module example' });
  act(() => { (dialog as HTMLDialogElement).close(); dialog.dispatchEvent(new Event('close')); });
  act(() => useCockpit.setState({ sessions }));
  await user.click(screen.getByRole('link', { name: 'Session A' }));
  await user.click(screen.getByRole('link', { name: 'Session B' }));
  await user.click(screen.getByRole('link', { name: 'Home' }));
  assert.equal(screen.getByRole('button', { name: 'Global count 1' }), probe);
  assert.equal(mounts, 1);
  assert.equal(cleanups, 0);
  act(() => f.runtime.unregister(f.runtime.getSnapshot().find(module => module.asset.id === 'probe')!));
  assert.equal(cleanups, 1);
  assert.equal(screen.queryByRole('button', { name: 'Global count 1' }), null);
  assert.ok(f.runtime.getSnapshot().some(module => module.asset.id === 'example'));
  view.unmount();
  assert.equal(document.querySelector('dialog'), null, 'portals unmount with their host tree');
  assert.deepEqual(f.reports, []);
});

test('same-digest stop/restart starts a new global component lifetime, even in one React batch', async t => {
  let mounts = 0, cleanups = 0, disposed = 0;
  function Counter() {
    const [count, setCount] = React.useState(0);
    React.useEffect(() => { mounts++; return () => { cleanups++; }; }, []);
    return React.createElement('button', { onClick: () => setCount(n => n + 1) }, `Count ${count}`);
  }
  const f = fixture({ example: () => ({
    apiVersion: 2, globalComponents: [{ id: 'same', component: Counter }], dispose() { disposed++; },
  }) });
  t.after(() => f.runtime.stop());
  await f.runtime.start();
  render(React.createElement(ModuleRuntimeProvider, { runtime: f.runtime, children: React.createElement(ModuleGlobalComponents) }));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Count 0' }));
  const previous = f.runtime.getSnapshot()[0];
  await act(async () => { f.runtime.stop(); await f.runtime.start(); });
  assert.notEqual(f.runtime.getSnapshot()[0].instanceId, previous.instanceId);
  assert.equal(previous.signal.aborted, true);
  assert.ok(screen.getByRole('button', { name: 'Count 0' }));
  assert.equal(mounts, 2);
  assert.equal(cleanups, 1);
  assert.equal(disposed, 1);
});

for (const kind of ['render', 'effect'] as const) {
  test(`global ${kind} failure revokes only its module and releases portals/services once`, async t => {
    t.mock.method(console, 'error', () => {});
    let dispose = 0, cleanup = 0;
    let context: ModuleFrontendContext | undefined;
    const f = fixture({
      bad: ctx => {
        context = ctx;
        ctx.state.register({ id: 'state', create: () => ({}), dispose: () => { dispose++; } });
        function Fault() {
          const [failed, setFailed] = React.useState(false);
          React.useEffect(() => { if (failed && kind === 'effect') throw new Error('global fixture crash'); }, [failed]);
          if (failed && kind === 'render') throw new Error('global fixture crash');
          return React.createElement('button', { onClick: () => setFailed(true) }, 'Crash module');
        }
        function Portal() {
          React.useEffect(() => () => { cleanup++; }, []);
          return ctx.createPortal(React.createElement('span', null, 'Owned portal'), document.body);
        }
        return { apiVersion: 2, globalComponents: [{ id: 'fault', component: Fault }, { id: 'portal', component: Portal }] };
      },
      good: () => ({ apiVersion: 2, globalComponents: [{ id: 'healthy', component: () => React.createElement('p', null, 'Healthy peer') }] }),
    });
    t.after(() => f.runtime.stop());
    await f.runtime.start();
    render(React.createElement(ModuleRuntimeProvider, { runtime: f.runtime, children:
      React.createElement(React.Fragment, null, React.createElement('p', null, 'Host'), React.createElement(ModuleGlobalComponents)) }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Crash module' }));
    await waitFor(() => assert.equal(screen.queryByText('Owned portal'), null));
    assert.ok(screen.getByText('Healthy peer'));
    assert.ok(screen.getByText('Host'));
    assert.equal(context?.signal.aborted, true);
    assert.equal(dispose, 1);
    assert.equal(cleanup, 1);
    assert.equal(f.reports.length, 1);
    assert.deepEqual(f.runtime.getSnapshot().map(module => module.asset.id), ['good']);
  });
}

test('global example fails capability preflight before creating a service', () => {
  const context = { globalComponentVersion: undefined, state: { register: () => assert.fail('must not register') } };
  assert.throws(() => example(context as unknown as ModuleFrontendContext), /requires global components/);
});

for (const kind of ['layout', 'passive', 'class'] as const) {
  for (const action of ['revoke', 'replace', 'stop'] as const) {
    test(`${kind} cleanup error during ${action} stays inside the retiring module boundary`, async t => {
      t.mock.method(console, 'error', () => {});
      let cleanups = 0;
      const error = new Error('Retiring global component');
      const cleanup = () => { cleanups++; throw error; };
      function Fault() {
        React.useLayoutEffect(() => kind === 'layout' ? cleanup : undefined, []);
        React.useEffect(() => kind === 'passive' ? cleanup : undefined, []);
        return null;
      }
      class ClassFault extends React.Component {
        componentWillUnmount() { cleanup(); }
        render() { return null; }
      }
      let first = true;
      const f = fixture({
        bad: () => {
          const component = first ? kind === 'class' ? ClassFault : Fault : () => null;
          first = false;
          return { apiVersion: 2, globalComponents: [{ id: 'fault', component }] };
        },
        good: () => ({ apiVersion: 2, globalComponents: [{ id: 'peer', component: () => React.createElement('p', null, 'Healthy peer') }] }),
      });
      t.after(() => f.runtime.stop());
      await f.runtime.start();
      render(React.createElement(ModuleRuntimeProvider, { runtime: f.runtime, children:
        React.createElement(React.Fragment, null, React.createElement('p', null, 'Host'), React.createElement(ModuleGlobalComponents)) }));
      await act(async () => {
        if (action === 'revoke') f.runtime.unregister(f.runtime.getSnapshot().find(module => module.asset.id === 'bad')!);
        else {
          f.runtime.stop();
          if (action === 'replace') await f.runtime.start();
        }
      });
      assert.ok(screen.getByText('Host'));
      if (action !== 'stop') assert.ok(screen.getByText('Healthy peer'));
      assert.equal(cleanups, 1);
      assert.deepEqual(f.reports, [error]);
      if (action === 'replace') assert.ok(f.runtime.getSnapshot().some(module => module.asset.id === 'bad'),
        'cleanup of the old activation must not revoke its replacement');
    });
  }
}

for (const result of ['resolve', 'reject'] as const) {
  test(`pending lazy global component does not block host/peers and ${result}s locally`, async t => {
    t.mock.method(console, 'error', () => {});
    let resolve!: (value: { default: React.ComponentType }) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<{ default: React.ComponentType }>((done, fail) => { resolve = done; reject = fail; });
    const Lazy = React.lazy(() => pending);
    const f = fixture({
      lazy: () => ({ apiVersion: 2, globalComponents: [{ id: 'lazy', component: Lazy }] }),
      good: () => ({ apiVersion: 2, globalComponents: [{ id: 'peer', component: () => React.createElement('p', null, 'Healthy peer') }] }),
    });
    t.after(() => f.runtime.stop());
    await f.runtime.start();
    render(React.createElement(ModuleRuntimeProvider, { runtime: f.runtime, children:
      React.createElement(React.Fragment, null, React.createElement('p', null, 'Host'), React.createElement(ModuleGlobalComponents)) }));
    assert.ok(screen.getByText('Host'));
    assert.ok(screen.getByText('Healthy peer'));
    assert.equal(f.reports.length, 0);
    await act(async () => {
      if (result === 'resolve') resolve({ default: () => React.createElement('p', null, 'Lazy ready') });
      else reject(new Error('Lazy fixture failure'));
    });
    assert.ok(screen.getByText('Host'));
    assert.ok(screen.getByText('Healthy peer'));
    if (result === 'resolve') assert.ok(screen.getByText('Lazy ready'));
    else {
      assert.equal(f.reports.length, 1);
      assert.deepEqual(f.runtime.getSnapshot().map(module => module.asset.id), ['good']);
    }

  });
}

for (const kind of ['layout', 'passive'] as const) {
  test(`late activation with initial ${kind} failure retains boundaries for failing sibling cleanup`, async t => {
    t.mock.method(console, 'error', () => {});
    const effectError = new Error('First mount failure'), cleanupError = new Error('Sibling cleanup failure');
    function Cleanup() {
      React.useLayoutEffect(() => () => { throw cleanupError; }, []);
      return null;
    }
    function Fault() {
      React.useLayoutEffect(() => { if (kind === 'layout') throw effectError; }, []);
      React.useEffect(() => { if (kind === 'passive') throw effectError; }, []);
      return null;
    }
    const f = fixture({
      bad: () => ({ apiVersion: 2, globalComponents: [{ id: 'cleanup', component: Cleanup }, { id: 'fault', component: Fault }] }),
      good: () => ({ apiVersion: 2, globalComponents: [{ id: 'peer', component: () => React.createElement('p', null, 'Healthy peer') }] }),
    });
    t.after(() => f.runtime.stop());
    render(React.createElement(ModuleRuntimeProvider, { runtime: f.runtime, children:
      React.createElement(React.Fragment, null, React.createElement('p', null, 'Host'), React.createElement(ModuleGlobalComponents)) }));
    await act(() => f.runtime.start());
    assert.ok(screen.getByText('Host'));
    assert.ok(screen.getByText('Healthy peer'));
    assert.deepEqual(f.reports, [effectError, cleanupError]);
    assert.deepEqual(f.runtime.getSnapshot().map(module => module.asset.id), ['good']);
  });
}

test('transitioned runtime replacement keeps retiring errors attributed to the old owner', async t => {
  t.mock.method(console, 'error', () => {});
  const error = new Error('Old runtime cleanup');
  function Old() {
    React.useEffect(() => () => { throw error; }, []);
    return null;
  }
  const first = fixture({ module: () => ({ apiVersion: 2, globalComponents: [{ id: 'old', component: Old }] }) });
  const second = fixture({ module: () => ({ apiVersion: 2, globalComponents: [{ id: 'new', component: () => React.createElement('p', null, 'New runtime') }] }) });
  t.after(() => { first.runtime.stop(); second.runtime.stop(); });
  await first.runtime.start();
  await second.runtime.start();
  function Host() {
    const [runtime, setRuntime] = React.useState(first.runtime);
    return React.createElement(ModuleRuntimeProvider, { runtime, children:
      React.createElement(React.Fragment, null,
        React.createElement('button', { onClick: () => React.startTransition(() => setRuntime(second.runtime)) }, 'Switch runtime'),
        React.createElement(ModuleGlobalComponents)) });
  }
  render(React.createElement(Host));
  await userEvent.setup().click(screen.getByRole('button', { name: 'Switch runtime' }));
  assert.ok(screen.getByText('New runtime'));
  assert.deepEqual(first.reports, [error]);
  assert.deepEqual(second.reports, []);
});
