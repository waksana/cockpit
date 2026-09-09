import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexedDbNotificationOrdering, type NotificationOrder } from './notificationTransport';

test('worker push always displays with a visible app; waitUntil covers delivery and safe clicks, never read/dismiss', async (t) => {
  const handlers = new Map<string, (event: unknown) => void>();
  const banners: { title: string; options: NotificationOptions }[] = [];
  const badges: number[] = [];
  const navigated: string[] = [];
  let enumerated = 0;
  let closed = 0;
  let orderingCalls = 0;
  let metadata: NotificationOrder = {};
  const client = {
    id: 'app', url: 'https://cockpit.example/skills', focused: true, visibilityState: 'visible',
    async focus() { return this; },
    async navigate(target: string) {
      navigated.push(target);
      this.url = new URL(target, 'https://cockpit.example').href;
      return this;
    },
  };
  t.mock.method(indexedDbNotificationOrdering, 'run', async (_tag, prepare) => {
    orderingCalls++;
    const work = prepare(metadata);
    metadata = work.next;
    await work.apply();
  });
  t.mock.method(console, 'warn', () => {});
  const original = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: {
      __WB_MANIFEST: [],
      addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
      skipWaiting: async () => {},
      location: { origin: 'https://cockpit.example' },
      navigator: { setAppBadge: async (count: number) => { badges.push(count); } },
      registration: {
        showNotification: async (title: string, options: NotificationOptions) => { banners.push({ title, options }); },
        getNotifications: async () => [],
      },
      clients: {
        claim: async () => {},
        matchAll: async () => { enumerated++; return [client]; },
        openWindow: async () => { assert.fail('The existing client should navigate'); },
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'self', original);
    else Reflect.deleteProperty(globalThis, 'self');
  });
  await import('../sw');
  const dispatch = async (type: string, event: Record<string, unknown> = {}) => {
    let lifetime: Promise<unknown> | undefined;
    handlers.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => { lifetime = promise; } });
    assert.ok(lifetime instanceof Promise, `${type} must extend worker lifetime`);
    await lifetime;
  };
  await dispatch('install');
  await dispatch('activate');
  const payload = {
    type: 'notification', kind: 'ready', title: 'Backend title', body: '',
    tag: 'session-tag', url: 'https://untrusted.example/', sessionId: 'a/b',
    unreadCount: 3, attnId: 1, inboxRevision: 1,
  };
  await dispatch('push', { data: { json: () => payload } });
  await dispatch('push', { data: { json: () => payload } });
  assert.equal(enumerated, 0, 'Push must not even consult window visibility');
  assert.equal(banners.length, 2);
  assert.equal(banners[0].title, payload.title);
  assert.equal(banners[0].options.body, '');
  assert.equal(banners[1].options.silent, true);
  const badgeSnapshot = [...badges];
  const orderSnapshot = structuredClone(metadata);
  const callsSnapshot = orderingCalls;
  await dispatch('push', { data: { json: () => ({ ...payload, kind: 'test', inboxRevision: 999, unreadCount: 99 }) } });
  await dispatch('push', { data: { json: () => { throw new SyntaxError('private raw body'); } } });
  await dispatch('push');
  assert.equal(banners.length, 5, 'Tests, malformed and empty pushes must also be visible');
  await dispatch('notificationclick', { notification: {
    close: () => { closed++; }, data: { url: 'https://untrusted.example/' },
  } });
  assert.equal(closed, 1);
  assert.deepEqual(navigated, ['/'], 'No session clicks route to the exact same-origin root');
  assert.deepEqual(badges, badgeSnapshot);
  assert.deepEqual(metadata, orderSnapshot);
  assert.equal(orderingCalls, callsSnapshot);
  assert.equal(handlers.has('notificationclose'), false, 'Dismissal must not mutate read state');
});
