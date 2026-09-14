import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, MemoryRouter } from 'react-router-dom';
import App from '../App';
import { parentOf } from './nav';
import {
  detailsNavigation, focusedSessionId, SESSION_PANELS,
  sessionNavigation, sessionPath, sessionRoute,
} from './routeOwnership';

test('list and every global route release chat attention ownership', () => {
  for (const pathname of ['/', '/mcp', '/mcp/server', '/skills', '/skills/tool', '/trash', '/trash/id', '/flows/old', '/workers/old']) {
    assert.deepEqual(sessionRoute(pathname), { sessionId: null, panel: null });
    assert.equal(focusedSessionId(pathname, false), null);
    assert.equal(focusedSessionId(pathname, true), null);
  }
});

test('only full-page phone details release the session; desktop details retain visible chat focus', () => {
  assert.equal(focusedSessionId('/session/a', true), 'a');
  for (const panel of SESSION_PANELS) {
    assert.deepEqual(sessionRoute(`/session/a/${panel}`), { sessionId: 'a', panel });
    assert.equal(focusedSessionId(`/session/a/${panel}`, true), null);
    assert.equal(focusedSessionId(`/session/a/${panel}`, false), 'a');
  }
  assert.equal(focusedSessionId('/session/a/unknown', true), null);
});

test('encoded session IDs round-trip exactly once for all links and ownership', () => {
  for (const id of ['plain', 'with spaces', '目录/会话', 'a/b?c#d', 'literal%2F', '%', '💬']) {
    const path = sessionPath(id);
    assert.equal(path, `/session/${encodeURIComponent(id)}`);
    assert.deepEqual(sessionRoute(path), { sessionId: id, panel: null });
    assert.equal(focusedSessionId(path, false), id);
    for (const panel of SESSION_PANELS) {
      assert.deepEqual(sessionRoute(sessionPath(id, panel)), { sessionId: id, panel });
      assert.equal(parentOf(sessionPath(id, panel)), path);
    }
  }
});

test('only existing panels own chat while unknown and removed routes keep no reader', () => {
  assert.deepEqual(SESSION_PANELS, ['info', 'mcp', 'skills']);
  assert.deepEqual(sessionRoute('/session/a/'), { sessionId: 'a', panel: null });
  assert.deepEqual(sessionRoute('/session/a/info/'), { sessionId: 'a', panel: 'info' });
  assert.deepEqual(sessionRoute('/SESSION/a/MCP'), { sessionId: 'a', panel: 'mcp' });
  const unknown = '/session/a%2Fb/unknown';
  assert.deepEqual(sessionRoute(unknown), { sessionId: null, panel: null });
  assert.equal(focusedSessionId(unknown, true), null);
  assert.equal(parentOf(unknown), sessionPath('a/b'));
  for (const panel of ['plan', 'context', 'schedules', 'runtime']) {
    assert.deepEqual(sessionRoute(`/session/a/${panel}`), { sessionId: null, panel: null });
    assert.equal(focusedSessionId(`/session/a/${panel}`, false), null);
    const html = renderToStaticMarkup(createElement(MemoryRouter, {
      initialEntries: [`/session/a/${panel}`], children: createElement(App),
    }));
    assert.match(html, /页面不存在/);
    assert.doesNotMatch(html, /chat-messages|info-panel-body/);
  }
  for (const path of ['/session/', '/session//info', '/session/a/info/extra', '/session/%E0%A4%A']) {
    assert.equal(focusedSessionId(path, false), null);
  }
});

test('session selection and new-session destinations push from lists, replace lateral session routes', () => {
  for (const from of ['/', '/mcp', '/skills/a', '/trash/a', '/session/a/runtime', '/session/a/unknown']) {
    assert.deepEqual(sessionNavigation(from, 'new/id'), { to: '/session/new%2Fid', replace: false });
  }
  for (const from of ['/session/a', '/session/a/info']) {
    assert.deepEqual(sessionNavigation(from, 'new/id'), { to: '/session/new%2Fid', replace: true });
  }
  assert.equal(detailsNavigation('/session/a', 'a', 'info').replace, false);
  for (const panel of SESSION_PANELS) {
    assert.equal(detailsNavigation(`/session/a/${panel}`, 'a', 'info').replace, true);
  }
});

test('real router history keeps details switches lateral so Back returns to chat then list', async () => {
  const router = createMemoryRouter([{ path: '*', element: null }], { initialEntries: ['/'] });
  const go = async (destination: { to: string; replace: boolean }) => {
    await router.navigate(destination.to, { replace: destination.replace });
  };
  try {
    await go(sessionNavigation(router.state.location.pathname, 'first'));
    assert.equal(router.state.historyAction, 'PUSH');
    await go(sessionNavigation(router.state.location.pathname, 'second/id'));
    assert.equal(router.state.historyAction, 'REPLACE');
    await go(detailsNavigation(router.state.location.pathname, 'second/id', 'info'));
    assert.equal(router.state.historyAction, 'PUSH');
    for (const panel of SESSION_PANELS) {
      await go(detailsNavigation(router.state.location.pathname, 'second/id', panel));
      assert.equal(router.state.historyAction, 'REPLACE');
    }
    await router.navigate(-1);
    assert.equal(router.state.location.pathname, '/session/second%2Fid');
    await router.navigate(-1);
    assert.equal(router.state.location.pathname, '/');
    await router.navigate(1);
    assert.equal(focusedSessionId(router.state.location.pathname, false), 'second/id');
  } finally {
    router.dispose();
  }
});
