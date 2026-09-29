import { act, render, screen, userEvent, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as React from 'react';
import { compile } from 'sass';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ActivateFrontend, ModuleFrontendContext } from '@cockpit/module-api/frontend';
import { ModuleRuntime, modulePagePath } from '../lib/moduleRuntime';
import { ModuleRuntimeProvider } from './ModuleComponents';
import { installWorkspaceFixture } from '../dev/workspace-fixtures';
import { useCockpit } from '../net/store';
import App from '../App';

const h = React.createElement;
function fixture(t: TestContext, activate: ActivateFrontend, version: 2 | 3 = 3) {
  const prior = useCockpit.getState();
  installWorkspaceFixture(useCockpit);
  const reports: unknown[] = [];
  const contexts: ModuleFrontendContext[] = [];
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid/',
    fetch: async () => Response.json({ errors: [], modules: [{
      id: 'example', name: 'Example', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/example/${digest}/api`, entry: `/_modules/assets/example/${digest}/entry.js`,
    }] }),
    load: async () => ({
      ...(version === 3 ? { frontendApiVersion: 3 } : {}),
      activate: (context: ModuleFrontendContext) => { contexts.push(context); return activate(context); },
    }),
    report: error => reports.push(error),
  });
  t.after(() => { runtime.stop(); useCockpit.setState(prior, true); });
  const mount = (path: string) => {
    const router = createMemoryRouter([{ path: '*', element:
      h(ModuleRuntimeProvider, { runtime, children: h(App) }),
    }], { initialEntries: [path] });
    t.after(() => router.dispose());
    return { router, view: render(h(RouterProvider, { router })) };
  };
  return { runtime, contexts, reports, mount };
}

test('page paths are owned by the host and cannot escape either namespace', () => {
  assert.equal(modulePagePath('example', 'main'), '/modules/example/main');
  for (const invalid of ['', '.', '..', '../session', '/mcp', 'main/extra', 'Main', 'a b', 'a?b', 'a#b',
    '%2f', 'a\\b', 'a'.repeat(65)]) {
    assert.throws(() => modulePagePath('example', invalid), /Invalid module page ID/);
    assert.throws(() => modulePagePath(invalid, 'main'), /Invalid module page ID/);
  }
});

test('the host bounds the page flex column so module timelines own scrolling instead of growing the root', () => {
  const css = compile(new URL('../styles/components/shell.scss', import.meta.url).pathname).css;
  assert.match(css, /\.module-page \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow: hidden;/);
});

test('module menu navigation uses real App history and releases Chat; globals keep their lifetime', async t => {
  let globalMounts = 0;
  function Global() {
    React.useEffect(() => { globalMounts++; }, []);
    return h('span', null, 'Global alive');
  }
  const f = fixture(t, context => ({
    apiVersion: 3,
    pages: [{ id: 'main', component: () => h('main', null,
      h('h1', null, 'Example page'), h('button', { onClick: context.navigation.home }, 'Module home')) }],
    globalComponents: [{ id: 'global', component: Global }],
    menus: [{ id: 'open-page', menu: 'global', getState: () => ({ label: 'Example page' }),
      onSelect: () => context.navigation.navigate('main') }],
  }));
  await f.runtime.start();
  const { router } = f.mount('/session/demo-chat');
  assert.equal(useCockpit.getState().activeId, 'demo-chat');
  assert.ok(document.querySelector('textarea'));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '全局导航' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Example page' }));
  assert.equal(router.state.location.pathname, '/modules/example/main');
  assert.ok(screen.getByRole('heading', { name: 'Example page' }));
  assert.equal(document.querySelectorAll('.module-page').length, 1);
  assert.equal(useCockpit.getState().activeId, null);
  assert.equal(f.runtime.getViewSnapshot().sessionId, null);
  assert.equal(document.querySelector('textarea'), null, 'the old Chat editor is unmounted, not hidden');
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(screen.queryByRole('menu'), null);
  await act(() => router.navigate(-1));
  assert.equal(document.querySelector('.module-page'), null, 'the page frame unmounts rather than hiding the old editor');
  assert.equal(useCockpit.getState().activeId, 'demo-chat');
  assert.ok(document.querySelector('textarea'));
  await act(() => router.navigate(1));
  assert.ok(screen.getByRole('heading', { name: 'Example page' }));
  await user.click(screen.getByRole('button', { name: 'Module home' }));
  assert.equal(router.state.location.pathname, '/');
  assert.equal(globalMounts, 1);
  assert.deepEqual(f.reports, []);
});

test('direct URL waits for late activation and remounting the App restores that same route', async t => {
  let finish!: () => void;
  let mounts = 0, cleanups = 0;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  function Page() {
    React.useEffect(() => { mounts++; return () => { cleanups++; }; }, []);
    return h('h1', null, 'Late page');
  }
  const f = fixture(t, async context => {
    assert.equal(context.pageVersion, 1);
    assert.equal(context.navigation.path('main'), '/modules/example/main');
    assert.throws(() => context.navigation.home(), /successful activation/);
    await pending;
    return { apiVersion: 3, pages: [{ id: 'main', component: Page }] };
  });
  const first = f.mount('/modules/example/main');
  assert.ok(screen.getByText('正在加载模块页面…'));
  let starting!: Promise<void>;
  act(() => { starting = f.runtime.start(); });
  assert.ok(screen.getByRole('link', { name: '返回主页' }));
  await act(async () => { finish(); await starting; });
  assert.ok(screen.getByRole('heading', { name: 'Late page' }));
  first.view.unmount();
  f.mount('/modules/example/main');
  assert.ok(screen.getByRole('heading', { name: 'Late page' }));
  assert.equal(mounts, 2);
  assert.equal(cleanups, 1);
});

test('the existing global menu opens a page from an empty homepage without inventing a session', async t => {
  const f = fixture(t, context => ({
    apiVersion: 3,
    pages: [{ id: 'main', component: () => h('h1', null, 'Empty-home page') }],
    menus: [{ id: 'menu', menu: 'global', getState: () => ({ label: 'Open page' }),
      onSelect: () => context.navigation.navigate('main') }],
  }));
  await f.runtime.start();
  useCockpit.setState({ sessions: [], activeId: null });
  const { router } = f.mount('/');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '全局导航' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Open page' }));
  assert.equal(router.state.location.pathname, '/modules/example/main');
  assert.ok(screen.getByRole('heading', { name: 'Empty-home page' }));
  assert.deepEqual(useCockpit.getState().sessions, []);
  assert.equal(useCockpit.getState().activeId, null);
});

test('unknown pages/modules and revocation offer an explicit homepage; captured navigation is revoked', async t => {
  const f = fixture(t, () => ({ apiVersion: 3, pages: [{ id: 'main', component: () => h('h1', null, 'Available') }] }));
  await f.runtime.start();
  const { router } = f.mount('/modules/missing/main');
  const context = f.contexts[0];
  assert.throws(() => context.navigation.navigate('missing'), /Unknown module page/);
  assert.ok(screen.getByText(/模块页面不存在或已不可用/));
  await act(() => router.navigate('/modules/example/missing'));
  assert.ok(screen.getByRole('link', { name: '返回主页' }));
  assert.ok(screen.getByRole('button', { name: '刷新页面' }));
  await act(() => context.navigation.navigate('main'));
  assert.ok(screen.getByRole('heading', { name: 'Available' }));
  act(() => f.runtime.unregister(f.runtime.getSnapshot()[0]));
  assert.equal(screen.queryByRole('heading', { name: 'Available' }), null);
  assert.ok(screen.getByText(/模块页面不存在或已不可用/));
  for (const action of [() => context.navigation.navigate('main'), context.navigation.home,
    () => context.navigation.path('main')]) assert.throws(action);
  await userEvent.setup().click(screen.getByRole('link', { name: '返回主页' }));
  assert.equal(router.state.location.pathname, '/');
  assert.deepEqual(f.reports, []);
});

for (const kind of ['render', 'effect', 'layout-cleanup', 'passive-cleanup'] as const) {
  test(`page ${kind} failure is owned by its activation, including navigation away`, async t => {
    t.mock.method(console, 'error', () => {});
    const error = new Error(`Page ${kind} failure`);
    let disposed = 0;
    function Page() {
      React.useLayoutEffect(() => kind === 'layout-cleanup' ? () => { throw error; } : undefined, []);
      React.useEffect(() => {
        if (kind === 'effect') throw error;
        return kind === 'passive-cleanup' ? () => { throw error; } : undefined;
      }, []);
      if (kind === 'render') throw error;
      return h('h1', null, 'Departing page');
    }
    const f = fixture(t, () => ({ apiVersion: 3, pages: [{ id: 'main', component: Page }],
      dispose: () => { disposed++; } }));
    await f.runtime.start();
    const { router } = f.mount('/modules/example/main');
    if (kind.endsWith('cleanup')) await act(() => router.navigate('/'));
    await waitFor(() => assert.equal(f.runtime.getSnapshot().length, 0));
    assert.equal(disposed, 1);
    assert.deepEqual(f.reports, [error]);
    if (kind.endsWith('cleanup')) assert.ok(screen.getByRole('button', { name: '全局导航' }));
    else assert.ok(screen.getByRole('link', { name: '返回主页' }));
  });
}

for (const declaration of [
  { pages: [{ id: '../session', component: () => null }] },
  { pages: [{ id: 'main', component: () => null }, { id: 'main', component: () => null }] },
  { pages: [{ id: 'main', component: () => null, path: '/session' }] },
  { pages: [{ id: 'main', component: 'main' }] },
  { pages: [{ id: 'main', component: () => null }], globalComponents: [{ id: 'main', component: () => null }] },
]) {
  test(`invalid page registration rolls back atomically: ${JSON.stringify(declaration)}`, async t => {
    let disposed = 0;
    const f = fixture(t, context => {
      context.state.register({ id: 'service', create: () => ({}), dispose: () => { disposed++; } });
      return { apiVersion: 3, ...declaration } as ReturnType<ActivateFrontend>;
    });
    await f.runtime.start();
    assert.equal(f.runtime.getSnapshot().length, 0);
    assert.equal(f.reports.length, 1);
    assert.equal(disposed, 1);
    assert.equal(f.contexts[0].signal.aborted, true);
  });
}

test('legacy v2 has neither page capability nor navigation and rejects pages', async t => {
  const f = fixture(t, context => {
    assert.equal('pageVersion' in context, false);
    assert.equal('navigation' in context, false);
    return { apiVersion: 2, pages: [{ id: 'main', component: () => null }] } as unknown as ReturnType<ActivateFrontend>;
  }, 2);
  await f.runtime.start();
  assert.match(String(f.reports[0]), /Unsupported module frontend field: pages/);
  assert.equal(f.runtime.getSnapshot().length, 0);
});

test('navigation bridge disconnect does not expose a stale router or override its replacement', async t => {
  const f = fixture(t, () => ({ apiVersion: 3, pages: [{ id: 'main', component: () => null }] }));
  await f.runtime.start();
  const paths: string[] = [];
  const navigation = f.contexts[0].navigation;
  assert.throws(() => navigation.navigate('main'), /router is unavailable/);
  const first = f.runtime.connectNavigation(() => assert.fail('stale router'));
  const second = f.runtime.connectNavigation(path => { paths.push(path); });
  first();
  navigation.navigate('main');
  navigation.home();
  assert.deepEqual(paths, ['/modules/example/main', '/']);
  second();
  assert.throws(() => navigation.home(), /router is unavailable/);
});

test('stop/restart uses a new page lifetime and old cleanup cannot revoke its replacement', async t => {
  t.mock.method(console, 'error', () => {});
  let first = true, cleanups = 0;
  const error = new Error('Old page cleanup');
  function OldPage() {
    React.useEffect(() => () => { cleanups++; throw error; }, []);
    return h('h1', null, 'Old activation');
  }
  const f = fixture(t, () => {
    const component = first ? OldPage : () => h('h1', null, 'New activation');
    first = false;
    return { apiVersion: 3, pages: [{ id: 'main', component }] };
  });
  await f.runtime.start();
  f.mount('/modules/example/main');
  const old = f.runtime.getSnapshot()[0];
  await act(async () => { f.runtime.stop(); await f.runtime.start(); });
  assert.ok(screen.getByRole('heading', { name: 'New activation' }));
  assert.equal(cleanups, 1);
  assert.notEqual(f.runtime.getSnapshot()[0].instanceId, old.instanceId);
  assert.deepEqual(f.reports, [error]);
  act(() => f.runtime.stop());
  assert.ok(screen.getByText(/模块页面不存在或已不可用/));
});

for (const result of ['resolve', 'reject'] as const) {
  test(`lazy page ${result} has a local loading state, home escape and module error ownership`, async t => {
    t.mock.method(console, 'error', () => {});
    let resolve!: (value: { default: React.ComponentType }) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<{ default: React.ComponentType }>((yes, no) => { resolve = yes; reject = no; });
    const Page = React.lazy(() => pending);
    const f = fixture(t, () => ({ apiVersion: 3, pages: [{ id: 'main', component: Page }] }));
    await f.runtime.start();
    f.mount('/modules/example/main');
    assert.ok(screen.getByText('正在加载模块页面…'));
    assert.ok(screen.getByRole('link', { name: '返回主页' }));
    await act(async () => {
      if (result === 'resolve') resolve({ default: () => h('h1', null, 'Lazy page') });
      else reject(new Error('Page load failed'));
      await pending.catch(() => {});
    });
    if (result === 'resolve') {
      assert.ok(screen.getByRole('heading', { name: 'Lazy page' }));
      assert.deepEqual(f.reports, []);
    } else {
      assert.ok(screen.getByText(/模块页面不存在或已不可用/));
      assert.equal(f.runtime.getSnapshot().length, 0);
      assert.equal(f.reports.length, 1);
    }
  });
}
