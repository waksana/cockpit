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
  detailsNavigation, focusedSessionId, notificationStatus, SESSION_PANELS,
  sessionNavigation, sessionPath, sessionRoute, subscribeSessionNotifications,
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

test('trailing slash and legacy automation preserve the same parent while malformed routes own no chat', () => {
  assert.deepEqual(sessionRoute('/session/a/'), { sessionId: 'a', panel: null });
  assert.deepEqual(sessionRoute('/session/a/info/'), { sessionId: 'a', panel: 'info' });
  const legacy = '/session/a%2Fb/automation';
  assert.deepEqual(sessionRoute(legacy), { sessionId: 'a/b', panel: 'schedules' });
  assert.equal(focusedSessionId(legacy, true), null);
  assert.equal(parentOf(legacy), parentOf(sessionPath('a/b', 'schedules')));
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

function browserEvent(detail: unknown) {
  return Object.assign(new Event('cockpit:open-session'), { detail });
}
function workerEvent(data: unknown, ports: Pick<MessagePort, 'postMessage'>[] = []) {
  return Object.assign(new Event('message'), { data, ports });
}

test('root browser and worker notification listeners work across global sections and clean up', () => {
  const browser = new EventTarget();
  const worker = new EventTarget();
  let pathname = '/mcp';
  const opened: { to: string; replace: boolean }[] = [];
  const stop = subscribeSessionNotifications(browser, worker, (id) => {
    opened.push(sessionNavigation(pathname, id));
  });
  for (const from of ['/mcp', '/mcp/server', '/skills', '/skills/tool', '/trash', '/trash/deleted']) {
    pathname = from;
    browser.dispatchEvent(browserEvent({ sessionId: 'a/b?#%' }));
    worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId: 'a/b?#%' }));
  }
  assert.equal(opened.length, 12);
  assert.ok(opened.every((item) => item.to === '/session/a%2Fb%3F%23%25' && !item.replace));
  pathname = '/session/old/runtime';
  browser.dispatchEvent(browserEvent({ sessionId: 'lateral' }));
  worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId: 'lateral' }));
  assert.deepEqual(opened.slice(-2), [
    { to: '/session/lateral', replace: true }, { to: '/session/lateral', replace: true },
  ]);
  stop();
  browser.dispatchEvent(browserEvent({ sessionId: 'ignored' }));
  worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId: 'ignored' }));
  assert.equal(opened.length, 14);
});

test('notification listeners reject unrelated and malformed payloads without navigating', () => {
  const browser = new EventTarget();
  const worker = new EventTarget();
  const ids: string[] = [];
  const stop = subscribeSessionNotifications(browser, worker, (id) => ids.push(id));
  for (const payload of [undefined, null, '', 1, {}, { sessionId: '' }, { sessionId: 12 }, { sessionId: null }]) {
    browser.dispatchEvent(browserEvent(payload));
    worker.dispatchEvent(workerEvent(payload));
    worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId: payload }));
  }
  worker.dispatchEvent(workerEvent({ type: 'other', sessionId: 'a' }));
  worker.dispatchEvent(workerEvent({ sessionId: 'a' }));
  assert.deepEqual(ids, []);
  stop();
});

test('browser notifications still navigate when there is no service worker', () => {
  const browser = new EventTarget();
  const ids: string[] = [];
  const stop = subscribeSessionNotifications(browser, undefined, (id) => ids.push(id));
  browser.dispatchEvent(browserEvent({ sessionId: 'a' }));
  assert.deepEqual(ids, ['a']);
  stop();
});

test('root ACK follows synchronous navigation acceptance and uses only the requested canonical target', () => {
  const browser = new EventTarget();
  const worker = new EventTarget();
  const calls: unknown[] = [];
  const stop = subscribeSessionNotifications(browser, worker, (id) => { calls.push(id); });
  const port = { postMessage: (message: unknown) => { calls.push(message); } };
  try {
    worker.dispatchEvent(workerEvent({
      type: 'open-session', sessionId: 'a/b?#%', target: '/session/a%2Fb%3F%23%25',
      url: 'https://foreign.example/evil',
    }, [port]));
    assert.deepEqual(calls, ['a/b?#%', {
      type: 'open-session-ack', target: '/session/a%2Fb%3F%23%25',
    }]);
    worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId: 'legacy' }, [port]));
    assert.equal(calls.at(-1), 'legacy');
    assert.equal(calls.length, 3);
  } finally {
    stop();
  }
});

test('root ignores unsafe IDs and malformed ACK requests, with no successful ACK', () => {
  const browser = new EventTarget();
  const worker = new EventTarget();
  const calls: unknown[] = [];
  const stop = subscribeSessionNotifications(browser, worker, (id) => calls.push(id));
  const port = { postMessage: (message: unknown) => { calls.push(message); } };
  try {
    for (const sessionId of ['', '.', '..', 'a\nb', '\u0000', '\u007f', '\u0085', '\ud800', '\udfff']) {
      browser.dispatchEvent(browserEvent({ sessionId }));
      worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId, target: '/' }, [port]));
    }
    for (const target of [null, 12, '/', '/session/a/info', '/session/%61', 'https://foreign.example/session/a']) {
      worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId: 'a', target }, [port]));
    }
    for (const data of [null, [], {}, { type: 'open-session', target: '/' }, { type: 'other', sessionId: 'a' }]) {
      worker.dispatchEvent(workerEvent(data, [port]));
    }
    assert.deepEqual(calls, []);
  } finally {
    stop();
  }
});

test('root waits for fulfilled navigation before ACK and suppresses ACK after cleanup', async () => {
  for (const cleanUpWhilePending of [false, true]) {
    const worker = new EventTarget();
    const acks: unknown[] = [];
    let accept!: () => void;
    const navigation = new Promise<void>((resolve) => { accept = resolve; });
    const stop = subscribeSessionNotifications(new EventTarget(), worker, () => navigation);
    try {
      worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId: 'a', target: '/session/a' }, [
        { postMessage: (message: unknown) => { acks.push(message); } },
      ]));
      await Promise.resolve();
      assert.deepEqual(acks, []);
      if (cleanUpWhilePending) stop();
      accept();
      await navigation;
      assert.deepEqual(acks, cleanUpWhilePending ? [] : [{ type: 'open-session-ack', target: '/session/a' }]);
    } finally {
      stop();
    }
  }
});

test('root refuses false, catches thrown/rejected navigation and ACK failures with sanitized warnings', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  for (const callback of [
    () => false,
    () => Promise.resolve(false),
    () => { throw new Error('private sync error'); },
    () => Promise.reject(new Error('private async error')),
  ]) {
    const browser = new EventTarget();
    const worker = new EventTarget();
    const acks: unknown[] = [];
    const stop = subscribeSessionNotifications(browser, worker, callback);
    try {
      browser.dispatchEvent(browserEvent({ sessionId: 'private-id' }));
      worker.dispatchEvent(workerEvent({
        type: 'open-session', sessionId: 'private-id', target: '/session/private-id',
      }, [{ postMessage: (message: unknown) => { acks.push(message); } }]));
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(acks, []);
    } finally {
      stop();
    }
  }
  const worker = new EventTarget();
  const stop = subscribeSessionNotifications(new EventTarget(), worker, () => Promise.resolve(true));
  try {
    worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId: 'a', target: '/session/a' }, [
      { postMessage: () => { throw new Error('private port failure'); } },
    ]));
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    stop();
  }
  assert.equal(warnings.length, 5);
  assert.ok(warnings.every((args) => args.length === 1 && args[0]
    === '[notifications] Session notification navigation was not accepted.'));
});

test('cleanup during synchronous navigation prevents ACK and dismissal events never navigate', () => {
  const browser = new EventTarget();
  const worker = new EventTarget();
  const ids: string[] = [];
  const acks: unknown[] = [];
  const stop = subscribeSessionNotifications(browser, worker, (id) => {
    ids.push(id);
    stop();
  });
  worker.dispatchEvent(Object.assign(new Event('notificationclose'), { data: { sessionId: 'dismissed' } }));
  browser.dispatchEvent(Object.assign(new Event('notificationclose'), { detail: { sessionId: 'dismissed' } }));
  assert.deepEqual(ids, []);
  worker.dispatchEvent(workerEvent({ type: 'open-session', sessionId: 'a', target: '/session/a' }, [
    { postMessage: (message: unknown) => { acks.push(message); } },
  ]));
  assert.deepEqual(ids, ['a']);
  assert.deepEqual(acks, []);
});

test('malformed payload accessors cannot escape the root listener or produce an ACK', (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const worker = new EventTarget();
  const stop = subscribeSessionNotifications(new EventTarget(), worker, () => assert.fail('Malformed request'));
  try {
    for (const data of [
      { get type() { throw new Error('private payload'); } },
      { type: 'open-session', sessionId: 'a', get target() { throw new Error('private target'); } },
    ]) {
      worker.dispatchEvent(workerEvent(data, [{ postMessage: () => assert.fail('Malformed request ACK') }]));
    }
    assert.deepEqual(warnings, Array.from({ length: 2 }, () => [
      '[notifications] Session notification navigation was not accepted.',
    ]));
  } finally {
    stop();
  }
});

test('notification permission is not subscription readiness and authorized subscriptions can retry', () => {
  const base = { notifSupported: true, notifPermission: 'granted' as const, notifReady: false };
  assert.deepEqual(notificationStatus(base), { label: '通知：已授权，订阅未就绪（重试）', enabled: true });
  assert.deepEqual(notificationStatus({ ...base, notifReady: true }), { label: '通知：已就绪', enabled: false });
  assert.equal(notificationStatus({ ...base, notifPermission: 'default' }).enabled, true);
  assert.equal(notificationStatus({ ...base, notifPermission: 'denied' }).enabled, false);
  assert.match(notificationStatus({ ...base, notifPermission: 'denied', notifReady: true }).label, /拒绝/);
  assert.equal(notificationStatus({ ...base, notifSupported: false }).enabled, false);
  assert.match(notificationStatus({ ...base, notifPermission: 'unsupported' }).label, /不支持/);
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
