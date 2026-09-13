import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  notificationDestination, routeNotificationClick,
  type NotificationClients, type NotificationWindowClient,
} from './notificationRouting';
import { subscribeSessionNotifications } from './routeOwnership';

const ORIGIN = 'https://cockpit.example';
const shortTimeout = { ackTimeoutMs: 5 };

class TestWindow implements NotificationWindowClient {
  focused = false;
  visibilityState = 'hidden';
  focusCalls = 0;
  targets: string[] = [];
  messages: unknown[] = [];
  receive?: (message: unknown, ports: Transferable[]) => void;
  onFocus?: () => Promise<NotificationWindowClient | null>;
  onNavigate?: (target: string) => Promise<NotificationWindowClient | null>;
  url: string;
  id: string;

  constructor(url = `${ORIGIN}/`) {
    this.url = url;
    this.id = url;
  }
  async focus() {
    this.focusCalls++;
    if (this.onFocus) return this.onFocus();
    this.focused = true;
    return this;
  }
  async navigate(target: string) {
    this.targets.push(target);
    if (this.onNavigate) return this.onNavigate(target);
    this.url = new URL(target, ORIGIN).href;
    return this;
  }
  postMessage(message: unknown, ports: Transferable[]) {
    this.messages.push(message);
    this.receive?.(message, ports);
  }
}

function environment(windows: NotificationWindowClient[], controlled = windows) {
  const opened: string[] = [];
  const clients: NotificationClients = {
    matchAll: async ({ type, includeUncontrolled }) => {
      assert.equal(type, 'window');
      return includeUncontrolled ? windows : controlled;
    },
    openWindow: async (target) => {
      opened.push(target);
      return new TestWindow(new URL(target, ORIGIN).href);
    },
  };
  return { clients, opened };
}

test('notification targets encode once, ignore supplied URLs and round-trip safe Unicode IDs', () => {
  for (const sessionId of ['a/b?#%', 'literal%2F', 'with spaces', ' ', '中文', '💬', '%2e', 'a\\b', '../x']) {
    const expected = `/session/${encodeURIComponent(sessionId)}`;
    const destination = notificationDestination({
      sessionId,
      get url() { throw new Error('The supplied URL must not be read'); },
    });
    assert.deepEqual(destination, { sessionId, target: expected });
    const url = new URL(destination.target, ORIGIN);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.pathname, expected);
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(decodeURIComponent(url.pathname.slice('/session/'.length)), sessionId);
  }
});

test('missing, malformed, dot-segment, control and invalid-Unicode IDs always route to root', () => {
  for (const info of [
    undefined, null, 'a', 12, [], {}, { sessionId: 12 },
    ...['', '.', '..', '\u0000', 'a\nb', '\r', '\t', '\u007f', '\u0085', '\ud800', '\udfff']
      .map((sessionId) => ({ sessionId, url: 'https://foreign.example/session/evil' })),
    { url: '//foreign.example/evil' },
  ]) {
    assert.deepEqual(notificationDestination(info), { sessionId: null, target: '/' });
  }
});

test('accepted root MessageChannel routing focuses and posts only open-session, never read/dismiss commands', async () => {
  const browser = new EventTarget();
  const worker = new EventTarget();
  const ids: string[] = [];
  const stop = subscribeSessionNotifications(browser, worker, (id) => { ids.push(id); });
  const client = new TestWindow(`${ORIGIN}/skills`);
  client.receive = (data, ports) => worker.dispatchEvent(Object.assign(new Event('message'), { data, ports }));
  const { clients, opened } = environment([client]);
  try {
    await routeNotificationClick(clients, ORIGIN, {
      sessionId: 'a/b?#%', url: 'javascript:alert(1)', unreadCount: 3,
      get markRead() { throw new Error('No read mutation on click'); },
      get dismiss() { throw new Error('No dismissal mutation on click'); },
    });
    assert.equal(client.focusCalls, 1);
    assert.deepEqual(ids, ['a/b?#%']);
    assert.deepEqual(client.messages, [{
      type: 'open-session', sessionId: 'a/b?#%', target: '/session/a%2Fb%3F%23%25',
    }]);
    assert.deepEqual(client.targets, []);
    assert.deepEqual(opened, []);
  } finally {
    stop();
  }
});

test('auth/uncontrolled pages without ACK navigate to the exact safe target even if already focused', async () => {
  for (const pathname of ['/auth/login?next=%2F', '/session/old', '/session/literal%252F']) {
    const client = new TestWindow(`${ORIGIN}${pathname}`);
    client.focused = true;
    const { clients, opened } = environment([client], []);
    await routeNotificationClick(clients, ORIGIN, {
      sessionId: 'literal%2F', url: '//foreign.example/evil',
    }, shortTimeout);
    assert.deepEqual(client.targets, ['/session/literal%252F']);
    assert.deepEqual(opened, []);
    assert.equal(client.focusCalls, 2);
  }
});

test('an uncontrolled page cannot ACK its way out of exact-target navigation', async () => {
  const client = new TestWindow(`${ORIGIN}/auth`);
  client.receive = (_message, ports) => {
    (ports[0] as MessagePort).postMessage({ type: 'open-session-ack', target: '/session/a' });
  };
  const { clients, opened } = environment([client], []);
  await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' }, shortTimeout);
  assert.deepEqual(client.messages, []);
  assert.deepEqual(client.targets, ['/session/a']);
  assert.deepEqual(opened, []);
});

test('wrong type, wrong target and malformed ACK cannot suppress exact-target navigation', async () => {
  for (const ack of [null, [], {}, { type: 'other', target: '/session/a' },
    { type: 'open-session-ack', target: '/session/b' },
    { type: 'open-session-ack', target: `${ORIGIN}/session/a` },
  ]) {
    const client = new TestWindow();
    client.focused = true;
    client.receive = (_data, ports) => (ports[0] as MessagePort).postMessage(ack);
    const { clients, opened } = environment([client]);
    await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' });
    assert.deepEqual(client.targets, ['/session/a']);
    assert.deepEqual(opened, []);
  }
});

test('no session or an unsafe session navigates root without an onOpen call', async () => {
  for (const info of [undefined, { url: '/session/supplied' }, { sessionId: '..' }, { sessionId: '\ud800' }]) {
    const client = new TestWindow(`${ORIGIN}/auth`);
    client.receive = () => assert.fail('Root routes must not send an open-session request');
    const { clients, opened } = environment([client]);
    await routeNotificationClick(clients, ORIGIN, info, shortTimeout);
    assert.deepEqual(client.messages, []);
    assert.deepEqual(client.targets, ['/']);
    assert.deepEqual(opened, []);
  }
  const { clients, opened } = environment([]);
  await routeNotificationClick(clients, ORIGIN, { url: 'https://foreign.example/' });
  assert.deepEqual(opened, ['/']);
});

test('foreign, deceptive and malformed client URLs are never focused, messaged or navigated', async () => {
  const foreign = [
    'https://foreign.example/', 'https://cockpit.example.evil/', 'https://cockpit.example@evil.example/',
    'http://cockpit.example/', 'https://cockpit.example:444/', '/relative', 'not a URL',
    'blob:https://cockpit.example/not-an-app-window',
  ].map((url) => new TestWindow(url));
  const { clients, opened } = environment(foreign);
  await routeNotificationClick(clients, ORIGIN, { sessionId: '中文', url: 'https://foreign.example/' });
  for (const client of foreign) {
    assert.equal(client.focusCalls, 0);
    assert.deepEqual(client.messages, []);
    assert.deepEqual(client.targets, []);
  }
  assert.deepEqual(opened, ['/session/%E4%B8%AD%E6%96%87']);
});

test('null, rejected, wrong-target and unavailable navigation fall back to openWindow exactly', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  for (const result of [null, 'reject', '/', '/auth', '/session/a?wrong=1', '/session/a#wrong',
    'https://foreign.example/session/a',
  ]) {
    const client = new TestWindow();
    client.onNavigate = async () => {
      if (result === 'reject') throw new Error('private navigation failure');
      return result === null ? null : new TestWindow(new URL(result, ORIGIN).href);
    };
    const { clients, opened } = environment([client]);
    await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' }, shortTimeout);
    assert.deepEqual(client.targets, ['/session/a']);
    assert.deepEqual(opened, ['/session/a']);
  }
  const { clients, opened } = environment([{ url: `${ORIGIN}/auth`, focused: true }]);
  await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' }, shortTimeout);
  assert.deepEqual(opened, ['/session/a']);
  assert.ok(warnings.every((args) => args.length === 1 && args[0]
    === '[notifications] Notification click routing could not complete an operation.'));
});

test('focus failures still attempt navigation, another client, then openWindow if necessary', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const reject of [false, true]) {
    const failed = new TestWindow(`${ORIGIN}/auth`);
    failed.onFocus = async () => {
      if (reject) throw new Error('private focus failure');
      return null;
    };
    const good = new TestWindow(`${ORIGIN}/mcp`);
    const { clients, opened } = environment([failed, good]);
    await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' }, shortTimeout);
    assert.deepEqual(failed.targets, ['/session/a']);
    assert.deepEqual(good.targets, ['/session/a']);
    assert.deepEqual(opened, []);

    const fallback = environment([failed]);
    await routeNotificationClick(fallback.clients, ORIGIN, { sessionId: 'a' }, shortTimeout);
    assert.deepEqual(fallback.opened, ['/session/a']);
  }
  const transient = new TestWindow();
  transient.onFocus = async () => transient.focusCalls === 1 ? null : transient;
  const { clients, opened } = environment([transient]);
  await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' }, shortTimeout);
  assert.deepEqual(transient.targets, ['/session/a']);
  assert.deepEqual(opened, []);
});

test('navigation cannot count a redirect during focus as arrival at the requested target', async () => {
  const client = new TestWindow();
  client.onFocus = async () => {
    if (client.focusCalls > 1) client.url = `${ORIGIN}/auth`;
    return client;
  };
  const { clients, opened } = environment([client]);
  await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' }, shortTimeout);
  assert.deepEqual(client.targets, ['/session/a']);
  assert.deepEqual(opened, ['/session/a']);
});

test('bounded ACK timeout closes both channel ports before navigating', async (t) => {
  const channel = new MessageChannel();
  const close1 = t.mock.method(channel.port1, 'close');
  const close2 = t.mock.method(channel.port2, 'close');
  const client = new TestWindow();
  const { clients } = environment([client]);
  await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' }, {
    ackTimeoutMs: -1, createMessageChannel: () => channel,
  });
  assert.equal(close1.mock.callCount(), 1);
  assert.equal(close2.mock.callCount(), 1);
  assert.equal(channel.port1.onmessage, null);
  assert.equal(channel.port1.onmessageerror, null);
  assert.deepEqual(client.targets, ['/session/a']);
});

test('a focused visible controlled app window is preferred over auth and hidden app windows', async () => {
  const auth = new TestWindow(`${ORIGIN}/auth`);
  auth.focused = true;
  auth.visibilityState = 'visible';
  const hidden = new TestWindow(`${ORIGIN}/mcp`);
  const app = new TestWindow(`${ORIGIN}/skills`);
  app.focused = true;
  app.visibilityState = 'visible';
  app.receive = (_message, ports) =>
    (ports[0] as MessagePort).postMessage({ type: 'open-session-ack', target: '/session/a' });
  const { clients, opened } = environment([auth, hidden, app], [hidden, app]);
  await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' });
  assert.equal(auth.focusCalls, 0);
  assert.equal(hidden.focusCalls, 0);
  assert.equal(app.focusCalls, 1);
  assert.deepEqual(app.targets, []);
  assert.deepEqual(opened, []);
});

test('MessageChannel/postMessage failures and enumeration failures safely fall back', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const failChannel of [false, true]) {
    const client = new TestWindow();
    client.receive = () => { throw new Error('private transport failure'); };
    const { clients, opened } = environment([client]);
    await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' }, failChannel ? {
      createMessageChannel: () => { throw new Error('private channel failure'); },
    } : shortTimeout);
    assert.deepEqual(client.targets, ['/session/a']);
    assert.deepEqual(opened, []);
  }
  const { clients, opened } = environment([]);
  clients.matchAll = async () => { throw new Error('private enumeration failure'); };
  await routeNotificationClick(clients, ORIGIN, { sessionId: 'a' });
  assert.deepEqual(opened, ['/session/a']);
  for (const result of [null, 'reject']) {
    clients.openWindow = async () => {
      if (result === 'reject') throw new Error('private open failure');
      return null;
    };
    await assert.doesNotReject(routeNotificationClick(clients, ORIGIN, { sessionId: 'a' }));
  }
});
