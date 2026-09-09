import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { NotificationPayload } from '@cockpit/protocol';
import { setBadge } from './badge';
import {
  indexedDbNotificationOrdering, parseNotificationPayload, showPushNotification, updateNotificationBadge,
  type BadgeNavigator, type NotificationOrder, type NotificationOrderingStore,
} from './notificationTransport';

const base = {
  type: 'notification', kind: 'ready', title: '[就绪] Backend title', body: '',
  tag: 'backend-supplied-tag', url: '/session/private-session', sessionId: 'private-session',
} satisfies NotificationPayload;

function payload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return { ...base, attnId: 3, inboxRevision: 10, unreadCount: 6, ...overrides };
}

function parity(input: unknown, valid: boolean) {
  const shared = NotificationPayload.safeParse(input);
  const lightweight = parseNotificationPayload(input);
  assert.equal(shared.success, valid);
  assert.equal(lightweight !== null, shared.success);
  if (shared.success) assert.deepEqual(lightweight, shared.data);
}

class MemoryOrdering implements NotificationOrderingStore {
  inboxRevision?: number;
  pageRevision?: number;
  attention = new Map<string, NonNullable<NotificationOrder['attention']>>();
  calls: (string | undefined)[] = [];
  private tail = Promise.resolve();

  run(tag: string | undefined, prepare: Parameters<NotificationOrderingStore['run']>[1]) {
    this.calls.push(tag);
    const result = this.tail.then(async () => {
      const work = prepare({
        inboxRevision: this.inboxRevision,
        pageRevision: this.pageRevision,
        attention: tag === undefined ? undefined : structuredClone(this.attention.get(tag)),
      });
      this.inboxRevision = work.next.inboxRevision;
      this.pageRevision = work.next.pageRevision;
      if (tag !== undefined && work.next.attention !== undefined) {
        this.attention.set(tag, structuredClone(work.next.attention));
      }
      await work.apply();
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

type Display = { title: string; options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } };

function platform() {
  const banners: Display[] = [];
  const displayed = new Map<string, Display>();
  const lookups: (string | undefined)[] = [];
  const badges: (number | 'clear')[] = [];
  const registration: Pick<ServiceWorkerRegistration, 'showNotification' | 'getNotifications'> = {
    async showNotification(title: string, options: NotificationOptions = {}) {
      const banner = { title, options };
      banners.push(banner);
      displayed.set(options.tag ?? '', banner);
    },
    async getNotifications(options: { tag?: string } = {}) {
      lookups.push(options.tag);
      return [...displayed.values()]
        .filter(({ options: current }) => options.tag === undefined || current.tag === options.tag)
        .map(({ title, options: current }) => ({
          title, body: current.body ?? '', tag: current.tag ?? '', data: current.data,
        }) as Notification);
    },
  };
  const nav = {
    async setAppBadge(count) { badges.push(count ?? 0); },
    async clearAppBadge() { badges.push('clear'); },
  } satisfies BadgeNavigator;
  return { banners, displayed, lookups, badges, registration, nav };
}

function assertSilent(banner: Display) {
  assert.equal(banner.options.silent, true);
  assert.equal(banner.options.renotify, false);
  assert.equal(banner.options.requireInteraction, false);
  assert.equal(Object.hasOwn(banner.options, 'vibrate'), false);
}

function replaceGlobal(t: TestContext, key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  });
}

function failureLogs(t: TestContext) {
  const logs: unknown[][] = [];
  for (const level of ['warn', 'error', 'log'] as const) {
    t.mock.method(console, level, (...args: unknown[]) => { logs.push(args); });
  }
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  t.after(async () => {
    await turn();
    process.removeListener('unhandledRejection', onUnhandled);
    assert.deepEqual(unhandled, []);
  });
  return logs;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type RequestStub<T = unknown> = {
  result?: T;
  onsuccess?: () => void;
  onerror?: () => void;
  onblocked?: () => void;
  onupgradeneeded?: () => void;
};

// Separate connections share an IDB readwrite lock. The native-style lock
// remains held through the callback's promise, independently of transactions.
function orderingDatabase() {
  const rows = new Map<string, unknown>();
  const connections: { closed: boolean }[] = [];
  const transactionConnections: number[] = [];
  const committedConnections: number[] = [];
  const abortedConnections: number[] = [];
  const lockRequests: string[] = [];
  let lockTail = Promise.resolve();
  let abortAt: 'put' | 'commit' | undefined;
  const locks = {
    request<T>(name: string, callback: () => Promise<T>) {
      assert.equal(name, 'cockpit-notification-transport');
      lockRequests.push(name);
      const result = lockTail.then(callback);
      lockTail = result.then(() => {}, () => {});
      return result;
    },
  };
  const waiting: (() => void)[] = [];
  let locked = false;
  let created = false;

  function startNext() {
    if (locked || waiting.length === 0) return;
    locked = true;
    waiting.shift()!();
  }

  function transaction(connection: number, name: string, mode: IDBTransactionMode) {
    assert.equal(name, 'ordering');
    assert.equal(mode, 'readwrite');
    transactionConnections.push(connection);
    const jobs: (() => void)[] = [];
    let staged = new Map<string, unknown>();
    let active = false;
    let scheduled = false;
    let finished = false;
    const tx: {
      oncomplete?: () => void;
      onabort?: () => void;
      onerror?: () => void;
      objectStore: (name: string) => typeof store;
      abort: () => void;
    } = {
      objectStore(name) { assert.equal(name, 'ordering'); return store; },
      abort() {
        assert.equal(finished, false);
        finished = true;
        abortedConnections.push(connection);
        setImmediate(() => { tx.onabort?.(); release(); });
      },
    };
    function release() {
      locked = false;
      startNext();
    }
    function pump() {
      if (!active || scheduled || finished) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        if (finished) return;
        const job = jobs.shift();
        if (job) {
          job();
          pump();
        } else if (abortAt === 'commit') {
          abortAt = undefined;
          tx.abort();
        } else {
          finished = true;
          rows.clear();
          for (const [key, value] of staged) rows.set(key, value);
          committedConnections.push(connection);
          tx.oncomplete?.();
          release();
        }
      });
    }
    function request(operation: () => unknown) {
      assert.equal(finished, false, 'Requests cannot revive a committed transaction');
      const result: RequestStub = {};
      jobs.push(() => {
        result.result = operation();
        if (finished) {
          result.onerror?.();
          tx.onerror?.();
        } else {
          result.onsuccess?.();
        }
      });
      pump();
      return result;
    }
    const store = {
      get: (key: string) => request(() => structuredClone(staged.get(key))),
      put: (value: unknown, key: string) => {
        const copy = structuredClone(value);
        return request(() => {
          if (abortAt === 'put') {
            abortAt = undefined;
            tx.abort();
            return;
          }
          staged.set(key, copy);
          return key;
        });
      },
    };
    waiting.push(() => { active = true; staged = new Map(rows); pump(); });
    startNext();
    return tx;
  }

  const factory = {
    open(name: string, version: number) {
      assert.equal(name, 'cockpit-notification-transport');
      assert.equal(version, 1);
      const connection = { closed: false };
      const id = connections.push(connection);
      const db = {
        objectStoreNames: { contains: (name: string) => created && name === 'ordering' },
        createObjectStore(name: string) { assert.equal(name, 'ordering'); created = true; },
        transaction: (name: string, mode: IDBTransactionMode) => transaction(id, name, mode),
        close() { assert.equal(connection.closed, false); connection.closed = true; },
      };
      const request: RequestStub<typeof db> = {};
      setImmediate(() => {
        request.result = db;
        if (!created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return {
    factory, locks, rows, connections, transactionConnections, committedConnections, abortedConnections, lockRequests,
    abortNext(phase: 'put' | 'commit') { abortAt = phase; },
  };
}

test('lightweight parsing matches the runtime schema output, stripping extras and preserving explicit undefined', () => {
  const { sessionId: _sessionId, ...testPayload } = { ...base, kind: 'test' };
  const largest = {
    ...base, title: '💬'.repeat(128), body: '界'.repeat(2048),
    tag: 't'.repeat(256), url: 'u'.repeat(4096), sessionId: 's'.repeat(256),
  };
  for (const input of [
    base, { ...base, kind: 'choice' }, testPayload, { ...base, kind: 'test' }, largest,
    { ...testPayload, sessionId: undefined },
    { ...payload(), extra: { secret: 'must be stripped' }, renotify: false },
  ]) parity(input, true);
  const stripped = parseNotificationPayload({ ...base, extra: 'private' });
  assert.deepEqual(stripped, base);
  assert.equal(Object.hasOwn(stripped!, 'badge'), false);
  for (const key of ['attnId', 'inboxRevision', 'unreadCount', 'badge'] as const) {
    for (const value of [undefined, 0, Number.MAX_SAFE_INTEGER]) {
      const input = { ...base, [key]: value };
      parity(input, true);
      assert.equal(Object.hasOwn(parseNotificationPayload(input)!, key), true);
    }
  }
});

test('lightweight parsing matches required fields, string bounds and ready/choice session refinement', () => {
  for (const input of [
    null, undefined, [], 1, 'notification', {}, new Date(), new Map(), new Set(), Promise.resolve(base),
    { ...base, type: 'session/notify' }, { ...base, kind: 'unknown' },
  ]) parity(input, false);
  for (const key of ['type', 'kind', 'title', 'body', 'tag', 'url']) {
    const missing: Record<string, unknown> = { ...base };
    delete missing[key];
    parity(missing, false);
    parity({ ...base, [key]: undefined }, false);
    parity({ ...base, [key]: null }, false);
  }
  for (const [key, maximum] of Object.entries({ title: 256, body: 2048, tag: 256, url: 4096, sessionId: 256 })) {
    parity({ ...base, [key]: 'x'.repeat(maximum + 1) }, false);
    parity({ ...base, [key]: 1 }, false);
    parity({ ...base, [key]: '' }, key === 'body');
  }
  for (const kind of ['ready', 'choice'] as const) {
    const missing: Record<string, unknown> = { ...base, kind };
    delete missing.sessionId;
    parity(missing, false);
    parity({ ...base, kind, sessionId: undefined }, false);
  }
  for (const sessionId of ['', null, 1]) parity({ ...base, kind: 'test', sessionId }, false);
});

test('all optional counters match runtime integer, safe-bound and nonnegative validation', () => {
  for (const key of ['attnId', 'inboxRevision', 'unreadCount', 'badge']) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, null, '1', true]) {
      parity({ ...base, [key]: value }, false);
    }
  }
});

test('every valid push displays the backend title, empty body, supplied tag and parsed metadata', async () => {
  const inputs: NotificationPayload[] = [base, payload(), payload({ kind: 'choice', title: '[选择] Backend title', badge: 99 })];
  for (const input of inputs) {
    const browser = platform();
    const ordering = new MemoryOrdering();
    await showPushNotification({ ...input, privateExtra: 'strip this' }, browser.registration, browser.nav, ordering);
    assert.equal(browser.banners.length, 1);
    assert.deepEqual(browser.banners[0], {
      title: input.title,
      options: {
        body: '', tag: input.tag, icon: '/icon-refined-r4-192.png', badge: '/badge-refined-r4-96.png',
        requireInteraction: input.kind === 'choice', renotify: true, silent: false,
        vibrate: input.kind === 'choice' ? [60, 40, 60, 40, 60] : [80],
        data: input,
      },
    });
    assert.deepEqual(ordering.calls, [input.tag]);
    assert.deepEqual(browser.badges, input.unreadCount === undefined ? [] : [input.unreadCount]);
  }
});

test('duplicates and older pushes remain visible, silent without vibration, retaining the newer displayed payload', async () => {
  const browser = platform();
  const ordering = new MemoryOrdering();
  const newest = payload({ kind: 'choice', attnId: 10, inboxRevision: 20, body: 'Newest body' });
  await showPushNotification(newest, browser.registration, browser.nav, ordering);
  const stale = [
    newest,
    payload({ attnId: 9, inboxRevision: 19, title: 'Old title', body: 'Old body' }),
    payload({ attnId: 11, inboxRevision: 19 }),
    payload({ attnId: 9, inboxRevision: 21 }),
    base,
  ];
  for (const [index, input] of stale.entries()) {
    await showPushNotification(input, browser.registration, browser.nav, ordering);
    assert.equal(browser.banners.length, index + 2);
    const banner = browser.banners.at(-1)!;
    assertSilent(banner);
    assert.equal(banner.title, newest.title);
    assert.equal(banner.options.body, newest.body);
    assert.equal(banner.options.tag, newest.tag);
    assert.deepEqual(banner.options.data, newest);
  }
  assert.deepEqual(browser.lookups, stale.map(() => newest.tag));
});

test('silent replacements normalize legacy page metadata from the native banner without losing its useful body', async (t) => {
  const logs = failureLogs(t);
  const newest = payload({ kind: 'choice', title: 'Choose a deployment', body: 'Deploy to staging or production?',
    attnId: 10, inboxRevision: 20, unreadCount: undefined });
  const { title, body, tag, ...legacyData } = newest;
  for (const unavailable of [false, true]) {
    const browser = platform();
    browser.displayed.set(tag, { title, options: { body, tag, data: legacyData } });
    const ordering = new MemoryOrdering();
    ordering.inboxRevision = newest.inboxRevision;
    ordering.attention.set(tag, { attnId: newest.attnId, inboxRevision: newest.inboxRevision });
    if (unavailable) t.mock.method(ordering, 'run', async () => { throw new Error('private storage failure'); });
    for (const incoming of [
      payload({ attnId: 10, inboxRevision: 20 }),
      payload({ attnId: 9, inboxRevision: 19, title: 'Older title', body: 'Older body' }),
    ]) {
      await showPushNotification(incoming, browser.registration, browser.nav, ordering);
      const banner = browser.banners.at(-1)!;
      assertSilent(banner);
      assert.equal(banner.title, title);
      assert.equal(banner.options.body, body);
      assert.equal(banner.options.tag, tag);
      assert.deepEqual(banner.options.data, newest);
      assert.equal(NotificationPayload.safeParse(banner.options.data).success, true);
    }
  }
  assert.deepEqual(logs, Array.from({ length: 2 }, () => ['[cockpit:notifications] Push transport failed']));
});

test('explicit test payloads with all counters are display-only, making zero ordering or badge calls', async () => {
  const browser = platform();
  const ordering = new MemoryOrdering();
  ordering.inboxRevision = 10;
  ordering.attention.set(base.tag, { attnId: 3, inboxRevision: 10 });
  const input = payload({
    kind: 'test', sessionId: undefined, badge: 99, unreadCount: 0, attnId: 999, inboxRevision: 999,
  });
  for (let delivery = 0; delivery < 2; delivery++) {
    await showPushNotification(input, browser.registration, browser.nav, ordering);
  }
  assert.equal(browser.banners.length, 2);
  for (const banner of browser.banners) {
    assert.equal(banner.title, input.title);
    assert.equal(banner.options.body, '');
    assert.equal(banner.options.tag, input.tag);
    assert.deepEqual(banner.options.data, input);
  }
  assert.deepEqual(browser.badges, []);
  assert.deepEqual(ordering.calls, []);
  assert.equal(ordering.inboxRevision, 10);
  assert.deepEqual([...ordering.attention], [[base.tag, { attnId: 3, inboxRevision: 10 }]]);
});

test('invalid JSON-shaped payloads display a safe root fallback without ordering or badge mutations', async (t) => {
  const logs = failureLogs(t);
  const browser = platform();
  const ordering = new MemoryOrdering();
  const invalid = [null, [], {}, 'private raw content', { ...payload(), title: '' },
    { ...payload(), sessionId: null }, { ...payload(), unreadCount: -1 }];
  for (const input of invalid) {
    await assert.doesNotReject(showPushNotification(input, browser.registration, browser.nav, ordering));
    const banner = browser.banners.at(-1)!;
    assertSilent(banner);
    assert.equal(banner.title, 'cockpit');
    assert.ok(banner.options.body);
    assert.deepEqual(banner.options.data, {
      type: 'notification', kind: 'test', title: 'cockpit',
      body: banner.options.body, tag: 'cockpit-invalid-push', url: '/',
    });
  }
  assert.equal(browser.banners.length, invalid.length);
  assert.deepEqual(browser.badges, []);
  assert.deepEqual(ordering.calls, []);
  assert.equal(ordering.inboxRevision, undefined);
  assert.equal(ordering.attention.size, 0);
  assert.deepEqual(logs, invalid.map(() => ['[cockpit:notifications] Invalid push payload']));
});

test('push and foreground share badge revisions: decreases, repairs, legacy fencing, aliases and zero', async () => {
  const browser = platform();
  const ordering = new MemoryOrdering();
  const push = (input: NotificationPayload) => showPushNotification(input, browser.registration, browser.nav, ordering);
  const foreground = (count: number, revision?: number) => updateNotificationBadge(count, revision, browser.nav, ordering);
  await foreground(7);
  await push(payload({ badge: 99 }));
  await foreground(2, 11);
  assert.deepEqual(browser.badges, [7, 6, 2]);
  await push(payload());
  assertSilent(browser.banners.at(-1)!);
  await foreground(8, 10);
  await foreground(8);
  await push(payload({ attnId: 4, inboxRevision: undefined, unreadCount: 8 }));
  assertSilent(browser.banners.at(-1)!);
  assert.deepEqual(browser.badges, [7, 6, 2]);
  await foreground(2, 11);
  assert.deepEqual(browser.badges, [7, 6, 2, 2], 'Same-revision projections must repair the badge');
  await push(payload({ attnId: 5, inboxRevision: 12, unreadCount: 0, badge: 99 }));
  assert.deepEqual(browser.badges, [7, 6, 2, 2, 'clear']);
  await push(payload({ attnId: 6, inboxRevision: 13, unreadCount: undefined, badge: undefined }));
  assert.equal(ordering.inboxRevision, 13, 'A revision without a count must still fence old counts');
  await foreground(9, 12);
  await push(payload({ attnId: 5, inboxRevision: 12, unreadCount: 9 }));
  assert.deepEqual(browser.badges, [7, 6, 2, 2, 'clear']);
  await foreground(1, 13);
  await push(payload({ attnId: 7, inboxRevision: 14, unreadCount: undefined, badge: 4 }));
  await foreground(0, 15);
  assert.deepEqual(browser.badges, [7, 6, 2, 2, 'clear', 1, 4, 'clear']);
  assert.equal(browser.banners.length, 7, 'Badge filtering must never suppress valid pushes');
});

test('unsupported APIs are harmless, zero falls back to setAppBadge, invalid metadata never enters ordering', async (t) => {
  const logs = failureLogs(t);
  const ordering = new MemoryOrdering();
  const calls: (number | undefined)[] = [];
  await updateNotificationBadge(0, 1, { async setAppBadge(count) { calls.push(count); } }, ordering);
  await updateNotificationBadge(2, 2, {}, ordering);
  assert.deepEqual(calls, [0]);
  assert.equal(ordering.inboxRevision, 2);
  const before = ordering.calls.length;
  for (const [count, revision] of [[-1, 3], [0.5, 3], [NaN, 3], [1, -1], [1, Number.MAX_SAFE_INTEGER + 1]]) {
    await updateNotificationBadge(count, revision, {}, ordering);
  }
  assert.equal(ordering.calls.length, before);
  assert.deepEqual(logs, Array.from({ length: 5 }, () => ['[cockpit:notifications] Invalid badge metadata']));
});

test('badge API throws/rejections do not block banners, and failed storage still displays without badge rollback', async (t) => {
  const logs = failureLogs(t);
  const privateError = () => new Error('private raw body /session/private-session?token=secret');
  for (const fail of [() => { throw privateError(); }, () => Promise.reject(privateError())]) {
    const browser = platform();
    const nav: BadgeNavigator = { setAppBadge: fail, clearAppBadge: fail };
    for (const unreadCount of [2, 0]) {
      await assert.doesNotReject(showPushNotification(payload({ unreadCount }), browser.registration, nav, new MemoryOrdering()));
    }
    assert.equal(browser.banners.length, 2);
    assert.deepEqual(logs.splice(0), [
      ['[cockpit:notifications] Badge update failed'], ['[cockpit:notifications] Badge update failed'],
    ]);
    const fallback = platform();
    const unavailable: NotificationOrderingStore = { run: fail };
    await assert.doesNotReject(showPushNotification(payload(), fallback.registration, fallback.nav, unavailable));
    assert.equal(fallback.banners.length, 1);
    assertSilent(fallback.banners[0]);
    assert.deepEqual(fallback.banners[0].options.data, payload());
    await assert.doesNotReject(updateNotificationBadge(99, 99, fallback.nav, unavailable));
    assert.deepEqual(fallback.badges, []);
    assert.deepEqual(logs.splice(0), [
      ['[cockpit:notifications] Push transport failed'], ['[cockpit:notifications] Badge ordering unavailable'],
    ]);
  }
});

test('lookup and display failures settle with sanitized logs, including absent getNotifications', async (t) => {
  const logs = failureLogs(t);
  const privateError = () => new Error('private title/body/tag/sessionId/url');
  for (const lookup of [undefined, () => { throw privateError(); }, () => Promise.reject(privateError())]) {
    const browser = platform();
    const ordering = new MemoryOrdering();
    await showPushNotification(payload(), browser.registration, browser.nav, ordering);
    const registration = { ...browser.registration, getNotifications: lookup } as typeof browser.registration;
    await assert.doesNotReject(showPushNotification(payload(), registration, browser.nav, ordering));
    assert.equal(browser.banners.length, 2);
    assertSilent(browser.banners[1]);
    assert.deepEqual(logs.splice(0), [['[cockpit:notifications] Notification replacement lookup failed']]);
  }
  for (const fail of [() => { throw privateError(); }, () => Promise.reject(privateError())]) {
    const browser = platform();
    const registration = { ...browser.registration, showNotification: t.mock.fn(fail) };
    await assert.doesNotReject(showPushNotification(payload(), registration, browser.nav, new MemoryOrdering()));
    assert.equal(registration.showNotification.mock.callCount(), 2, 'Failed display attempts a silent fallback');
    assert.deepEqual(logs.splice(0), [
      ['[cockpit:notifications] Push transport failed'], ['[cockpit:notifications] Notification display failed'],
    ]);
  }
});

test('actual IndexedDB commits before effects and the native lock gates independent connections until effects finish', { timeout: 3000 }, async (t) => {
  const db = orderingDatabase();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { locks: db.locks });
  const entered = deferred();
  const release = deferred();
  const events: string[] = [];
  let firstSettled = false;
  const first = indexedDbNotificationOrdering.run(base.tag, (previous) => {
    assert.deepEqual(previous, { inboxRevision: undefined, pageRevision: undefined, attention: undefined });
    events.push('prepare first');
    return {
      next: { inboxRevision: 7, attention: { attnId: 2, inboxRevision: 7 } },
      apply: async () => {
        assert.deepEqual(db.committedConnections, [1]);
        assert.deepEqual(db.connections, [{ closed: true }]);
        assert.deepEqual([...db.rows], [
          ['inboxRevision', 7], [`tag:${base.tag}`, { attnId: 2, inboxRevision: 7 }],
        ]);
        events.push('apply first');
        entered.resolve();
        await release.promise;
        events.push('finish first');
      },
    };
  }).then(() => { firstSettled = true; });
  await Promise.race([entered.promise, first.then(() => assert.fail('First effect must await release'))]);
  const second = indexedDbNotificationOrdering.run(base.tag, (previous) => {
    events.push('prepare second');
    assert.deepEqual(previous, { inboxRevision: 7, pageRevision: undefined, attention: { attnId: 2, inboxRevision: 7 } });
    return {
      next: { inboxRevision: 8, attention: { attnId: 3, inboxRevision: 8 } },
      apply: async () => {
        assert.deepEqual(db.committedConnections, [1, 2]);
        assert.ok(db.connections.every((connection) => connection.closed));
        events.push('apply second');
      },
    };
  });
  try {
    await turn();
    await turn();
    assert.deepEqual(db.lockRequests, Array(2).fill('cockpit-notification-transport'));
    assert.deepEqual(db.connections, [{ closed: true }]);
    assert.deepEqual(db.transactionConnections, [1]);
    assert.deepEqual(db.committedConnections, [1]);
    assert.deepEqual([...db.rows], [
      ['inboxRevision', 7], [`tag:${base.tag}`, { attnId: 2, inboxRevision: 7 }],
    ]);
    assert.equal(firstSettled, false);
    assert.deepEqual(events, ['prepare first', 'apply first']);
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  assert.deepEqual(events, ['prepare first', 'apply first', 'finish first', 'prepare second', 'apply second']);
  assert.deepEqual(db.transactionConnections, [1, 2]);
  assert.deepEqual([...db.rows], [
    ['inboxRevision', 8], [`tag:${base.tag}`, { attnId: 3, inboxRevision: 8 }],
  ]);
  assert.ok(db.connections.every((connection) => connection.closed));
});

test('setBadge returns an awaited Promise and shares persisted minimal ordering metadata with worker pushes', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await showPushNotification(payload(), browser.registration, browser.nav);
  const update: Promise<void> = setBadge(2, 11);
  assert.ok(update instanceof Promise);
  await update;
  assert.deepEqual(browser.badges, [6, 2]);
  await showPushNotification(payload(), browser.registration, browser.nav);
  await setBadge(99, 10);
  await setBadge(99);
  assert.deepEqual(browser.badges, [6, 2]);
  await setBadge(2, 11);
  await setBadge(0, 12);
  await showPushNotification(payload({ attnId: 4, inboxRevision: 13, unreadCount: undefined }), browser.registration, browser.nav);
  await setBadge(99, 12);
  await setBadge(1, 13);
  assert.deepEqual(browser.badges, [6, 2, 2, 'clear', 1]);
  assert.equal(browser.banners.length, 3);
  assertSilent(browser.banners[1]);
  assert.deepEqual([...db.rows], [
    ['inboxRevision', 13], [`tag:${base.tag}`, { attnId: 4, inboxRevision: 13 }],
    ['pageRevision', 13],
  ], 'Persist only revision/attention high-water marks, never counts or notification content');
  assert.equal(db.connections.length, 10);
  assert.equal(new Set(db.transactionConnections).size, 10);
  assert.ok(db.connections.every((connection) => connection.closed));
});

test('queued put/commit aborts cannot race a pending native effect or double-display a push', { timeout: 3000 }, async (t) => {
  for (const phase of ['put', 'commit'] as const) {
    await t.test(phase, async (t) => {
      const logs = failureLogs(t);
      const db = orderingDatabase();
      const browser = platform();
      replaceGlobal(t, 'indexedDB', db.factory);
      replaceGlobal(t, 'navigator', { locks: db.locks });
      const entered = deferred();
      const release = deferred();
      const badge = t.mock.method(browser.nav, 'setAppBadge', async (count?: number) => {
        assert.equal(db.rows.get('inboxRevision'), count === 6 ? 10 : 12);
        assert.equal(db.committedConnections.at(-1), db.connections.length);
        assert.ok(db.connections.every((connection) => connection.closed));
        if (count === 6) {
          entered.resolve();
          await release.promise;
        }
        browser.badges.push(count ?? 0);
      });
      const display = t.mock.method(browser.registration, 'showNotification');
      const old = showPushNotification(payload(), browser.registration, browser.nav);
      await Promise.race([entered.promise, old.then(() => assert.fail('Old badge effect must await release'))]);
      db.abortNext(phase);
      const failedPayload = payload({ attnId: 4, inboxRevision: 11, unreadCount: 5 });
      const failed = showPushNotification(failedPayload, browser.registration, browser.nav);
      try {
        await turn();
        await turn();
        assert.equal(db.lockRequests.length, 2);
        assert.deepEqual(db.connections, [{ closed: true }], 'No next connection while the old effect is pending');
        assert.deepEqual(db.committedConnections, [1]);
        assert.deepEqual(db.abortedConnections, []);
        assert.equal(badge.mock.callCount(), 1);
        assert.equal(display.mock.callCount(), 0);
      } finally {
        release.resolve();
        await Promise.all([old, failed]);
      }
      assert.deepEqual(db.abortedConnections, [2]);
      assert.deepEqual(db.committedConnections, [1]);
      assert.deepEqual([...db.rows], [
        ['inboxRevision', 10], [`tag:${base.tag}`, { attnId: 3, inboxRevision: 10 }],
      ], 'Neither a failed write nor a failed commit can persist partial ordering');
      assert.deepEqual(browser.badges, [6]);
      assert.equal(badge.mock.callCount(), 1, 'An aborted push must never start its badge effect');
      assert.equal(display.mock.callCount(), 2, 'The aborted push displays only its silent fallback');
      assert.equal(browser.banners[0].options.silent, false);
      assertSilent(browser.banners[1]);
      assert.deepEqual(browser.banners[1].options.data, failedPayload);
      assert.deepEqual(logs, [['[cockpit:notifications] Push transport failed']]);

      const newer = payload({ attnId: 5, inboxRevision: 12, unreadCount: 2 });
      await showPushNotification(newer, browser.registration, browser.nav);
      assert.deepEqual(browser.badges, [6, 2]);
      assert.equal(badge.mock.callCount(), 2);
      assert.equal(display.mock.callCount(), 3);
      assert.equal(browser.banners[2].options.silent, false);
      assert.deepEqual(browser.banners[2].options.data, newer);
      assert.deepEqual(db.committedConnections, [1, 3]);
      assert.deepEqual([...db.rows], [
        ['inboxRevision', 12], [`tag:${base.tag}`, { attnId: 5, inboxRevision: 12 }],
      ]);
      assert.ok(db.connections.every((connection) => connection.closed));
    });
  }
});

test('missing native locks fail closed for badges but preserve a visible silent push with sanitized logs', async (t) => {
  for (const [name, nav] of [
    ['navigator unavailable', undefined], ['locks unavailable', {}], ['request unavailable', { locks: {} }],
  ] as const) {
    await t.test(name, async (t) => {
      const logs = failureLogs(t);
      const db = orderingDatabase();
      const browser = platform();
      replaceGlobal(t, 'indexedDB', db.factory);
      replaceGlobal(t, 'navigator', nav);
      await assert.doesNotReject(updateNotificationBadge(99, 99, browser.nav));
      await assert.doesNotReject(showPushNotification(payload(), browser.registration, browser.nav));
      assert.deepEqual(browser.badges, []);
      assert.equal(browser.banners.length, 1);
      assertSilent(browser.banners[0]);
      assert.deepEqual(browser.banners[0].options.data, payload());
      assert.deepEqual(db.connections, []);
      assert.equal(db.rows.size, 0);
      assert.deepEqual(logs, [
        ['[cockpit:notifications] Badge ordering unavailable'], ['[cockpit:notifications] Push transport failed'],
      ]);
    });
  }
});

test('an aborted push serializes fallback lookup/display with a concurrent newer push', { timeout: 3000 }, async (t) => {
  failureLogs(t);
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { locks: db.locks });
  const entered = deferred();
  const release = deferred();
  const lookup = browser.registration.getNotifications;
  t.mock.method(browser.registration, 'getNotifications', async (options) => {
    const snapshot = await lookup(options);
    entered.resolve();
    await release.promise;
    return snapshot;
  });
  db.abortNext('commit');
  const older = showPushNotification(payload(), browser.registration, browser.nav);
  await entered.promise;
  const newest = payload({ attnId: 4, inboxRevision: 11, unreadCount: 2, title: 'Newest title' });
  const newer = showPushNotification(newest, browser.registration, browser.nav);
  try {
    await turn();
    await turn();
    assert.equal(db.connections.length, 1, 'Newer delivery must await the fallback display lock');
    assert.equal(browser.banners.length, 0);
  } finally {
    release.resolve();
    await Promise.all([older, newer]);
  }
  assert.equal(browser.banners.length, 2, 'Every push still displays exactly once');
  assertSilent(browser.banners[0]);
  assert.deepEqual(browser.banners.at(-1)?.options.data, newest);
  assert.deepEqual(browser.badges, [2]);
  assert.equal(db.rows.get('inboxRevision'), 11);
});

test('actual IndexedDB abort/apply/open failures reject safely, close connections and preserve visible fallback', async (t) => {
  const logs = failureLogs(t);
  const db = orderingDatabase();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { locks: db.locks });
  const privateError = () => new Error('private storage error: title/body/sessionId/url');
  await assert.rejects(indexedDbNotificationOrdering.run(base.tag, () => { throw privateError(); }),
    /^Error: Notification ordering transaction aborted$/);
  assert.equal(db.rows.size, 0);
  await assert.rejects(indexedDbNotificationOrdering.run(undefined, () => ({
    next: { inboxRevision: 5 }, apply: () => Promise.reject(privateError()),
  })), /^Error: Notification transport failed$/);
  assert.deepEqual([...db.rows], [['inboxRevision', 5]], 'A native failure must not roll back committed ordering');
  await indexedDbNotificationOrdering.run(undefined, (previous) => {
    assert.deepEqual(previous, { inboxRevision: 5, pageRevision: undefined, attention: undefined });
    return { next: previous, apply: async () => {} };
  });

  assert.deepEqual(db.abortedConnections, [1]);
  assert.deepEqual(db.committedConnections, [2, 3]);
  assert.ok(db.connections.every((connection) => connection.closed), 'Failure must release the connection and native lock');
  let failureEvent: 'onerror' | 'onblocked' = 'onerror';
  t.mock.method(db.factory, 'open', () => {
    const request: ReturnType<typeof db.factory.open> = {};
    setImmediate(() => request[failureEvent]?.());
    return request;
  });
  for (const event of ['onerror', 'onblocked'] as const) {
    failureEvent = event;
    const browser = platform();
    replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
    await assert.doesNotReject(showPushNotification(payload(), browser.registration, browser.nav));
    await assert.doesNotReject(setBadge(99, 99));
    assert.equal(browser.banners.length, 1);
    assertSilent(browser.banners[0]);
    assert.deepEqual(browser.badges, []);
    assert.deepEqual(logs.splice(0), [
      ['[cockpit:notifications] Push transport failed'], ['[cockpit:notifications] Badge ordering unavailable'],
    ]);
  }
});

test('a delayed same-revision push cannot undo a foreground seen patch, even after OS badge reset', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await setBadge(0, 10, [{ sessionId: base.sessionId, attnId: 3, seenId: 3 }]);
  await showPushNotification(payload({ inboxRevision: 10, unreadCount: 6 }), browser.registration, browser.nav);
  await setBadge(0, 10, [{ sessionId: base.sessionId, attnId: 3, seenId: 3 }]);
  assert.deepEqual(browser.badges, ['clear', 'clear']);
  assert.equal(browser.banners.length, 1, 'Every actual push remains visible');
  assertSilent(browser.banners[0]);
  await showPushNotification(payload({ inboxRevision: 11, attnId: 4, unreadCount: 1 }), browser.registration, browser.nav);
  assert.deepEqual(browser.badges, ['clear', 'clear', 1]);
});

test('unread page projections never silence the first ready or choice alert', async (t) => {
  for (const kind of ['ready', 'choice'] as const) {
    await t.test(kind, async (t) => {
      const db = orderingDatabase();
      const browser = platform();
      replaceGlobal(t, 'indexedDB', db.factory);
      replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
      await setBadge(6, 10, [{ sessionId: base.sessionId, attnId: 3, seenId: 2 }]);
      await showPushNotification(payload({ kind }), browser.registration, browser.nav);
      assert.equal(browser.banners[0].options.silent, false);
      assert.equal(browser.banners[0].options.renotify, true);
      assert.equal(browser.banners[0].options.requireInteraction, kind === 'choice');
      assert.deepEqual(browser.badges, [6], 'Page owns the same-revision badge, not alert suppression');
      await showPushNotification(payload({ kind }), browser.registration, browser.nav);
      assertSilent(browser.banners[1]);
      await setBadge(6, 11, [{ sessionId: base.sessionId, attnId: 4, seenId: 2 }]);
      await showPushNotification(payload({ kind, attnId: 4, inboxRevision: 11 }), browser.registration, browser.nav);
      assert.equal(browser.banners[2].options.silent, false, 'A new attention can alert again');
    });
  }
});

test('session waterlines fence seen and superseded pushes independently of tags and global page revisions', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await setBadge(1, 20, [
    { sessionId: 'other', attnId: 9, seenId: 9 },
    { sessionId: base.sessionId, attnId: 3, seenId: 1 },
  ]);
  await showPushNotification(payload(), browser.registration, browser.nav);
  assert.equal(browser.banners[0].options.silent, false, 'Another session/global revision cannot mark this one seen');
  await showPushNotification(payload({ attnId: 2, tag: 'different-tag', inboxRevision: 21 }), browser.registration, browser.nav);
  assertSilent(browser.banners[1]);
  await setBadge(0, 22, [{ sessionId: base.sessionId, attnId: 3, seenId: 3 }]);
  await setBadge(9, 19, [{ sessionId: base.sessionId, attnId: 2, seenId: 1 }]);
  assert.deepEqual(db.rows.get(`session:${base.sessionId}`), { attnId: 3, seenId: 3, presentRevision: 22 });
  await showPushNotification(payload({ tag: 'another-tag', inboxRevision: 23 }), browser.registration, browser.nav);
  assertSilent(browser.banners[2]);
  assert.deepEqual(browser.badges, [1, 'clear'], 'Neither stale pages nor already-seen pushes resurrect the badge');
});

test('legacy mixed pageRevision never migrates to a session seen fact; existing delivery dedupe is retained', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  db.rows.set('inboxRevision', 100);
  db.rows.set('pageRevision', 100);
  db.rows.set('tag:old-delivered', { attnId: 3, inboxRevision: 100 });
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await showPushNotification(payload({ inboxRevision: 100 }), browser.registration, browser.nav);
  assert.equal(browser.banners[0].options.silent, false);
  assert.deepEqual(browser.badges, [], 'Old page metadata still protects the badge');
  await showPushNotification(payload({ tag: 'old-delivered', inboxRevision: 100 }), browser.registration, browser.nav);
  assertSilent(browser.banners[1]);
  assert.equal(db.rows.has(`session:${base.sessionId}`), false);
});

test('page and worker races preserve first-alert intent and final authoritative badge', async (t) => {
  for (const pageFirst of [true, false]) {
    for (const seen of [false, true]) {
      await t.test(`pageFirst=${pageFirst}, seen=${seen}`, async (t) => {
        const db = orderingDatabase();
        const browser = platform();
        replaceGlobal(t, 'indexedDB', db.factory);
        replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
        const page = () => setBadge(seen ? 0 : 6, 10, [
          { sessionId: base.sessionId, attnId: 3, seenId: seen ? 3 : 2 },
        ]);
        const push = () => showPushNotification(payload(), browser.registration, browser.nav);
        await Promise.all(pageFirst ? [page(), push()] : [push(), page()]);
        assert.equal(browser.banners.length, 1);
        assert.equal(browser.banners[0].options.silent, pageFirst && seen);
        assert.equal(browser.badges.at(-1), seen ? 'clear' : 6);
        await showPushNotification(payload(), browser.registration, browser.nav);
        assertSilent(browser.banners[1]);
        assert.equal(browser.badges.at(-1), seen ? 'clear' : 6);
      });
    }
  }
});

test('authoritative observations remain usable when browser has no Badging API', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { locks: db.locks });
  await setBadge(0, 10, [{ sessionId: base.sessionId, attnId: 3, seenId: 3 }]);
  await showPushNotification(payload(), browser.registration, browser.nav);
  assertSilent(browser.banners[0]);
  assert.deepEqual(browser.badges, []);
});

test('authoritatively cleared attention is retired without inventing a seen receipt', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await setBadge(0, 11, [{ sessionId: base.sessionId, attnId: 3, seenId: 1, attention: null }]);
  await showPushNotification(payload({ inboxRevision: 11 }), browser.registration, browser.nav);
  assertSilent(browser.banners[0]);
  assert.deepEqual(db.rows.get(`session:${base.sessionId}`), { attnId: 3, seenId: 1, retiredAttnId: 3, presentRevision: 11 });
  await setBadge(1, 12, [{ sessionId: base.sessionId, attnId: 4, seenId: 1, attention: 'choice' }]);
  await showPushNotification(payload({ kind: 'choice', attnId: 4, inboxRevision: 12 }), browser.registration, browser.nav);
  assert.equal(browser.banners[1].options.silent, false);
  assert.equal(browser.banners[1].options.requireInteraction, true);
  assert.deepEqual(browser.badges, ['clear', 1]);
});

test('session removal fences delayed alerts without silencing other sessions or a restored new attention', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await setBadge(1, 10, [{ sessionId: base.sessionId, attnId: 3, seenId: 2, attention: 'ready' }]);
  await setBadge(0, 11, [], { removedSessions: [base.sessionId, 'not-previously-projected'] });
  await showPushNotification(payload(), browser.registration, browser.nav);
  assertSilent(browser.banners[0]);
  await showPushNotification(payload({ sessionId: 'not-previously-projected', tag: 'removed' }), browser.registration, browser.nav);
  assertSilent(browser.banners[1]);
  await showPushNotification(payload({ sessionId: 'other', tag: 'other' }), browser.registration, browser.nav);
  assert.equal(browser.banners[2].options.silent, false);
  await setBadge(1, 12, [{ sessionId: base.sessionId, attnId: 4, seenId: 2, attention: 'ready' }]);
  await showPushNotification(payload({ attnId: 4, inboxRevision: 12 }), browser.registration, browser.nav);
  assert.equal(browser.banners[3].options.silent, false);
  assert.deepEqual(browser.badges, [1, 'clear', 1]);
});

test('an empty legacy session observation is not proof a versionless first notification was seen', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await setBadge(0, undefined, [{ sessionId: base.sessionId, attnId: 0, seenId: 0, attention: null }]);
  await showPushNotification(base, browser.registration, browser.nav);
  assert.equal(browser.banners[0].options.silent, false);
});

test('older cross-page removal keeps its own revision, not the newer projected restoration revision', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await setBadge(1, 12, [{ sessionId: base.sessionId, attnId: 4, seenId: 2, attention: 'ready' }]);
  await setBadge(0, 12, [], { removedSessions: [base.sessionId], removalRevision: 11 });
  assert.equal((db.rows.get(`session:${base.sessionId}`) as NotificationOrder['session'])?.removedRevision, 11);
  await showPushNotification(payload({ attnId: 4, inboxRevision: 12 }), browser.registration, browser.nav);
  assert.equal(browser.banners[0].options.silent, false);
});

test('complete snapshots retire omitted persisted sessions even after a cold page, without conflating unrelated revisions', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await setBadge(1, 10, [{ sessionId: base.sessionId, attnId: 3, seenId: 2, attention: 'ready' }]);
  await setBadge(0, 11, [], { completeSnapshot: true, removalRevision: 11 });
  await showPushNotification(payload(), browser.registration, browser.nav);
  assertSilent(browser.banners[0]);
  assert.deepEqual(browser.badges, [1, 'clear']);
  await setBadge(1, 12, [{ sessionId: base.sessionId, attnId: 4, seenId: 2, attention: 'ready' }], { completeSnapshot: true });
  await setBadge(0, 9, [], { completeSnapshot: true });
  await showPushNotification(payload({ attnId: 4, inboxRevision: 12 }), browser.registration, browser.nav);
  assert.equal(browser.banners[1].options.silent, false);
});

test('cold complete snapshot fences unknown absent sessions but not its unseen present session', async (t) => {
  const db = orderingDatabase();
  const browser = platform();
  replaceGlobal(t, 'indexedDB', db.factory);
  replaceGlobal(t, 'navigator', { ...browser.nav, locks: db.locks });
  await setBadge(1, 11, [{ sessionId: base.sessionId, attnId: 3, seenId: 2, attention: 'ready' }],
    { completeSnapshot: true });
  await showPushNotification(payload({ sessionId: 'absent', tag: 'absent' }), browser.registration, browser.nav);
  assertSilent(browser.banners[0]);
  await showPushNotification(payload(), browser.registration, browser.nav);
  assert.equal(browser.banners[1].options.silent, false);
  assert.deepEqual(browser.badges, [1]);
});
