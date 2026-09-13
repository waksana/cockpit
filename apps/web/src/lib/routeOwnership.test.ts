import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter } from 'react-router-dom';
import { Dialog } from '../components/Dialog';
import { SessionRuntime } from '../components/SessionRuntime';
import type { ChatSession } from '../net/types';
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
  assert.equal(focusedSessionId('/session/a/unknown', true), 'a');
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

test('trailing slash and unknown panels preserve the same parent while malformed routes own no chat', () => {
  assert.deepEqual(sessionRoute('/session/a/'), { sessionId: 'a', panel: null });
  assert.deepEqual(sessionRoute('/session/a/info/'), { sessionId: 'a', panel: 'info' });
  const unknown = '/session/a%2Fb/unknown';
  assert.deepEqual(sessionRoute(unknown), { sessionId: 'a/b', panel: null });
  assert.equal(focusedSessionId(unknown, true), 'a/b');
  assert.equal(parentOf(unknown), sessionPath('a/b'));
  for (const path of ['/session/', '/session//info', '/session/a/info/extra', '/session/%E0%A4%A']) {
    assert.equal(focusedSessionId(path, false), null);
  }
});

test('session selection and new-session destinations push from lists, replace lateral session routes', () => {
  for (const from of ['/', '/mcp', '/skills/a', '/trash/a']) {
    assert.deepEqual(sessionNavigation(from, 'new/id'), { to: '/session/new%2Fid', replace: false });
  }
  for (const from of ['/session/a', '/session/a/info', '/session/a/runtime', '/session/a/unknown']) {
    assert.deepEqual(sessionNavigation(from, 'new/id'), { to: '/session/new%2Fid', replace: true });
  }
  assert.equal(detailsNavigation('/session/a', 'a', 'info').replace, false);
  for (const panel of SESSION_PANELS) {
    assert.equal(detailsNavigation(`/session/a/${panel}`, 'a', 'runtime').replace, true);
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

test('runtime detail identifies its owner without navigation and disables offline mutations', () => {
  const html = renderToStaticMarkup(createElement(SessionRuntime, {
    session: { sessionId: 'offline', title: 'Offline session' } as ChatSession,
    onClose: () => {},
  }));
  assert.match(html, /运行维护 · Offline session/);
  assert.doesNotMatch(html, /<nav|info-panel-more|role="tab"/);
  assert.match(html, /等待连接/);
  for (const label of ['压缩', '回退', '重载', '卸载']) {
    assert.ok(html.includes(`disabled="">${label}</button>`));
  }
});

test('rewind dialogs expose unsupported file rollback without promising success; notices dismiss offline', () => {
  const html = renderToStaticMarkup(createElement(Dialog, {
    title: '回退', rollbackFiles: false, onConfirm: () => {}, onCancel: () => {},
  }));
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /可能不受支持/);
  assert.match(html, /不勾选时仅回退对话/);
  assert.match(html, /class="dialog-btn primary rp" disabled=""/);
  const notice = renderToStaticMarkup(createElement(Dialog, {
    title: '无法回退', acknowledgementOnly: true, onConfirm: () => {}, onCancel: () => {},
  }));
  assert.doesNotMatch(notice, /class="dialog-btn primary rp" disabled/);
});
