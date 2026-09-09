import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { beforeEach, test, type TestContext } from 'node:test';
import { inspect } from 'node:util';
import { NotificationPayload } from '@cockpit/protocol';
import { dismissUxError, getUxErrors } from './errorReporter';
import { indexedDbNotificationOrdering, showPushNotification, type NotificationOrder } from './notificationTransport';
import type { NotifyOptions } from './notify';

const ORIGIN = 'https://cockpit.example';
const PRIVATE_ENDPOINT = 'https://push.example.invalid/private-endpoint?auth=endpoint-auth-secret';
const privateError = () => new Error(PRIVATE_ENDPOINT);
const drain = async () => { await setImmediate(); await setImmediate(); };
const clearErrors = () => { for (const error of getUxErrors()) dismissUxError(error.id); };

let api: typeof import('./notify');
let now = 1_000_000;
let browser: ReturnType<typeof mockBrowser>;

function replaceProperty(t: TestContext, target: object, key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  get state() { return 'suspended'; }
  constructor() { browser.audioCreations++; }
  async resume() {
    browser.resumeCalls++;
    if (browser.resumeError) throw browser.resumeError;
  }
  createOscillator() {
    browser.oscillatorCreations++;
    return {
      type: 'sine',
      frequency: {
        value: 0,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
        exponentialRampToValueAtTime: () => undefined,
      },
      connect: (destination: unknown) => destination,
      disconnect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
    };
  }
  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
        exponentialRampToValueAtTime: () => undefined,
      },
      connect: (destination: unknown) => destination,
      disconnect: () => undefined,
    };
  }
  async close() { return undefined; }
}

function mockBrowser(t: TestContext) {
  const state = {
    permission: 'default' as NotificationPermission,
    requestedPermission: 'granted' as NotificationPermission,
    lookupError: null as Error | null,
    showError: null as Error | null,
    pageError: null as Error | null,
    resumeError: null as Error | null,
    closeError: null as Error | null,
    orderingError: null as Error | null,
    instances: [] as { onclick: (() => void) | null; close: () => void }[],
    audioCreations: 0,
    oscillatorCreations: 0,
    resumeCalls: 0,
    logs: [] as unknown[][],
  };
  const requestPermission = t.mock.fn(async () => state.requestedPermission);
  const page = t.mock.fn((_title: string, _options?: NotificationOptions) => {
    if (state.pageError) throw state.pageError;
  });
  class PageNotification {
    static get permission() { return state.permission; }
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) { page(title, options); state.instances.push(this); }
    close() { if (state.closeError) throw state.closeError; }
  }
  const subscribe = t.mock.fn(() => { throw new Error('Must not subscribe'); });
  const banners = new Map<string, Notification>();
  const showNotification = t.mock.fn(async (_title: string, _options?: NotificationOptions) => {
    if (state.showError) throw state.showError;
    banners.set(_options?.tag ?? '', {
      title: _title, body: _options?.body ?? '', tag: _options?.tag ?? '', data: _options?.data,
    } as Notification);
  });
  const getNotifications = t.mock.fn(async (options?: GetNotificationOptions) =>
    [...banners.values()].filter((banner) => options?.tag === undefined || banner.tag === options.tag));
  const registration = {
    active: { state: 'activated' },
    showNotification,
    getNotifications,
    pushManager: { subscribe },
  };
  const lookup = { registration: registration as typeof registration | undefined };
  const getRegistration = t.mock.fn(async (_scope?: string) => {
    if (state.lookupError) throw state.lookupError;
    return lookup.registration;
  });
  const register = t.mock.fn(() => { throw new Error('Must not register'); });
  const ready = t.mock.fn(() => { throw new Error('Must not wait for serviceWorker.ready'); });
  const serviceWorker = { getRegistration, register, get ready() { return ready(); } };
  const navigator = {
    serviceWorker,
    userActivation: { isActive: false },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36',
    standalone: false,
  };
  let inboxRevision: number | undefined;
  const attention = new Map<string, NotificationOrder['attention']>();
  let tail = Promise.resolve();
  const runOrdering = t.mock.method(indexedDbNotificationOrdering, 'run', (tag, prepare) => {
    const result = tail.then(async () => {
      if (state.orderingError) throw state.orderingError;
      const work = prepare({ inboxRevision, attention: tag === undefined ? undefined : attention.get(tag) });
      inboxRevision = work.next.inboxRevision;
      if (tag !== undefined) attention.set(tag, work.next.attention);
      await work.apply();
    });
    tail = result.catch(() => {});
    return result;
  });
  const location = new URL('/session/active', ORIGIN);
  const window = {
    isSecureContext: true,
    location,
    Notification: PageNotification,
    PushManager: class {},
    AudioContext: FakeAudioContext,
    matchMedia: () => ({ matches: false }),
    focus: () => undefined,
  };
  const document = {
    visibilityState: 'hidden',
    get hidden() { return this.visibilityState === 'hidden'; },
    hasFocus: () => true,
  };
  for (const [key, value] of Object.entries({
    window, navigator, document, location,
    Notification: PageNotification, PushManager: window.PushManager, AudioContext: FakeAudioContext,
  })) replaceProperty(t, globalThis, key, value);
  for (const level of ['error', 'warn', 'log'] as const) {
    t.mock.method(console, level, (...args: unknown[]) => { state.logs.push(args); });
  }
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Notification tests must not make network requests');
  });
  t.after(async () => {
    await drain();
    clearErrors();
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(register.mock.callCount(), 0);
    assert.equal(ready.mock.callCount(), 0);
    assert.equal(subscribe.mock.callCount(), 0);
  });
  return Object.assign(state, {
    window, navigator, document, lookup, registration, requestPermission, page, getRegistration,
    showNotification, runOrdering,
  });
}

beforeEach(async (t: TestContext) => {
  now += 60_000;
  t.mock.method(Date, 'now', () => now);
  clearErrors();
  browser = mockBrowser(t);
  api = await import('./notify');
  await drain();
  assert.equal(browser.requestPermission.mock.callCount(), 0, 'Import must not prompt');
  assert.equal(browser.getRegistration.mock.callCount(), 0, 'Import must not look up registrations');
  assert.equal(browser.audioCreations, 0, 'Import must not play audio');
  assert.equal(browser.page.mock.callCount(), 0, 'Import must not display notifications');
});

function attention(overrides: Partial<NotifyOptions> = {}): NotifyOptions {
  return {
    title: 'Session needs attention',
    body: 'Choose an option',
    kind: 'choice',
    sessionId: 'session/?&#',
    attnId: 17,
    inboxRevision: 29,
    ...overrides,
  };
}

async function deliver(options = attention()) {
  assert.equal(api.notify(options), undefined);
  await drain();
}

function assertSilent() {
  assert.equal(browser.audioCreations, 0);
  assert.equal(browser.oscillatorCreations, 0);
  assert.equal(browser.resumeCalls, 0);
  assert.equal(browser.getRegistration.mock.callCount(), 0);
  assert.equal(browser.showNotification.mock.callCount(), 0);
  assert.equal(browser.page.mock.callCount(), 0);
  assert.equal(browser.requestPermission.mock.callCount(), 0);
}

function assertMetadata(args: [string, NotificationOptions?], expected: NotifyOptions) {
  const [title, options] = args;
  assert.equal(title, expected.title);
  assert.equal(options?.body, expected.body);
  assert.equal(options?.icon, '/icon-refined-r4-192.png');
  assert.equal(options?.badge, '/badge-refined-r4-96.png');
  const data = options?.data as Record<string, unknown> | undefined;
  assert.ok(data);
  assert.equal(data.title, expected.title);
  assert.equal(data.body, expected.body ?? '');
  assert.equal(data.tag, expected.tag ?? expected.sessionId);
  assert.equal(options?.tag, data.tag);
  if (expected.title) assert.equal(NotificationPayload.safeParse(data).success, true);
  for (const key of ['kind', 'sessionId', 'attnId', 'inboxRevision'] as const) {
    assert.equal(data[key], expected[key]);
  }
  assert.equal(typeof data.url, 'string');
  const url = new URL(data.url as string, ORIGIN);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, `/session/${encodeURIComponent(expected.sessionId!)}`);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
}

function assertSanitizedFailure() {
  assert.ok(getUxErrors().length > 0, 'Failure must be visible in local diagnostics');
  assert.ok(browser.logs.length > 0, 'Failure must be logged');
  const diagnostics = inspect([browser.logs, getUxErrors()], { depth: null });
  for (const secret of ['push.example.invalid', 'private-endpoint', 'endpoint-auth-secret']) {
    assert.ok(!diagnostics.includes(secret), 'Diagnostics must not expose endpoint or auth details');
  }
}

test('desktop support and permission inspection do not prompt, even during a gesture', async () => {
  browser.navigator.userActivation.isActive = true;
  assert.equal(api.notificationsSupported(), true);
  for (const permission of ['default', 'denied', 'granted'] as const) {
    browser.permission = permission;
    assert.equal(api.notificationPermission(), permission);
  }
  await drain();
  assertSilent();
});

test('only explicit ensure during an active gesture requests default permission synchronously', async () => {
  assert.equal(await api.ensureNotificationPermission(), false);
  await deliver();
  assertSilent();
  browser.navigator.userActivation.isActive = true;
  const pending = api.ensureNotificationPermission();
  assert.equal(browser.requestPermission.mock.callCount(), 1);
  browser.navigator.userActivation.isActive = false;
  assert.equal(await pending, true);
  assert.equal(browser.getRegistration.mock.callCount(), 0);
});

for (const permission of ['granted', 'denied'] as const) {
  test(`ensure returns ${permission === 'granted'} for ${permission} without requesting permission`, async () => {
    browser.permission = permission;
    browser.navigator.userActivation.isActive = true;
    assert.equal(await api.ensureNotificationPermission(), permission === 'granted');
    assertSilent();
  });
}

test('declining an explicit permission request returns false', async () => {
  browser.requestedPermission = 'denied';
  browser.navigator.userActivation.isActive = true;
  assert.equal(await api.ensureNotificationPermission(), false);
  assert.equal(browser.requestPermission.mock.callCount(), 1);
});

test('a rejected user-gesture permission request is handled and redacted', async () => {
  browser.navigator.userActivation.isActive = true;
  browser.requestPermission.mock.mockImplementation(async () => { throw privateError(); });
  assert.equal(await api.ensureNotificationPermission(), false);
  assertSanitizedFailure();
});

const unsupportedCases: Record<string, () => void> = {
  'no window': () => { Reflect.deleteProperty(globalThis, 'window'); },
  'no navigator': () => { Reflect.deleteProperty(globalThis, 'navigator'); },
  'insecure context': () => { browser.window.isSecureContext = false; },
  'non-HTTPS origin': () => { browser.window.location.protocol = 'http:'; },
  'no Notification': () => {
    Reflect.deleteProperty(browser.window, 'Notification');
    Reflect.deleteProperty(globalThis, 'Notification');
  },
  'no PushManager': () => {
    Reflect.deleteProperty(browser.window, 'PushManager');
    Reflect.deleteProperty(globalThis, 'PushManager');
  },
  'no service worker': () => { Reflect.deleteProperty(browser.navigator, 'serviceWorker'); },
};

for (const [name, makeUnsupported] of Object.entries(unsupportedCases)) {
  test(`${name} blocks permission requests, display and audio before construction`, async () => {
    browser.permission = 'granted';
    browser.navigator.userActivation.isActive = true;
    makeUnsupported();
    assert.equal(api.notificationsSupported(), false);
    assert.equal(await api.ensureNotificationPermission(), false);
    await deliver(attention({ onlyWhenHidden: false }));
    assertSilent();
  });
}

for (const permission of ['default', 'denied'] as const) {
  test(`${permission} permission blocks audio and display even during a gesture`, async () => {
    browser.permission = permission;
    browser.navigator.userActivation.isActive = true;
    await deliver(attention({ onlyWhenHidden: false }));
    assertSilent();
  });
}

test('visible tabs stay silent by default with granted permission', async () => {
  browser.permission = 'granted';
  browser.document.visibilityState = 'visible';
  await deliver();
  assertSilent();
});

test('a rejected chime resume does not prevent display or escape as an unhandled rejection', async () => {
  browser.permission = 'granted';
  browser.resumeError = privateError();
  await deliver();
  assert.ok(browser.resumeCalls > 0);
  assert.equal(browser.showNotification.mock.callCount(), 1);
  const diagnostics = inspect([browser.logs, getUxErrors()], { depth: null });
  assert.ok(!diagnostics.includes('endpoint-auth-secret'));
  assert.ok(!diagnostics.includes('push.example.invalid'));
});

test('permission loss during audio resume prevents the chime from playing', async (t) => {
  browser.permission = 'granted';
  t.mock.method(FakeAudioContext.prototype, 'resume', async () => { browser.permission = 'denied'; });
  await deliver();
  assert.equal(browser.oscillatorCreations, 0);
});

for (const path of ['service worker', 'page'] as const) {
  for (const empty of [false, true]) {
    test(`${path} preserves metadata and ${empty ? 'empty' : 'nonempty'} title/body`, async () => {
      browser.permission = 'granted';
      if (path === 'page') browser.lookup.registration = undefined;
      const options = attention(empty ? { title: '', body: '', attnId: 0, inboxRevision: 0 } : {});
      await deliver(options);
      assert.deepEqual(browser.getRegistration.mock.calls.map((call) => call.arguments), [['/']]);
      const display = path === 'service worker' ? browser.showNotification : browser.page;
      assert.equal(display.mock.callCount(), 1);
      assertMetadata(display.mock.calls[0].arguments, options);
      const unused = path === 'service worker' ? browser.page : browser.showNotification;
      assert.equal(unused.mock.callCount(), 0);
      assert.equal(browser.requestPermission.mock.callCount(), 0);
    });
  }
}

test('an inactive registration falls back after a bounded activation wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  browser.permission = 'granted';
  browser.registration.active.state = 'activating';
  await deliver();
  assert.equal(browser.showNotification.mock.callCount(), 0);
  assert.equal(browser.page.mock.callCount(), 0);
  t.mock.timers.tick(10_001);
  await drain();
  assert.equal(browser.page.mock.callCount(), 1);
});

test('onlyWhenHidden false explicitly allows visible notification display', async () => {
  browser.permission = 'granted';
  browser.document.visibilityState = 'visible';
  await deliver(attention({ onlyWhenHidden: false }));
  assert.equal(browser.showNotification.mock.callCount(), 1);
});

test('a hidden tab still displays attention for its active session regardless of an active-session flag', async () => {
  browser.permission = 'granted';
  const options = { ...attention({ sessionId: 'active' }), isActiveSession: true };
  await deliver(options);
  assert.equal(browser.showNotification.mock.callCount(), 1);
  assertMetadata(browser.showNotification.mock.calls[0].arguments, options);
});

test('page and push share ordering and preserve useful content without chiming for duplicate, older or silent fallback displays', async () => {
  browser.permission = 'granted';
  const options = attention({ title: 'Select the deployment target', body: 'Staging or production?', tag: 'actual-session-tag' });
  await deliver(options);
  assertMetadata(browser.showNotification.mock.calls.at(-1)!.arguments, options);
  assert.equal(browser.oscillatorCreations, 2);
  const push = NotificationPayload.parse({
    type: 'notification', kind: options.kind, title: options.title, body: '',
    tag: options.tag, sessionId: options.sessionId, attnId: options.attnId, inboxRevision: options.inboxRevision,
    url: `/session/${encodeURIComponent(options.sessionId!)}`,
  });
  await showPushNotification(push, browser.registration, {});
  assertMetadata(browser.showNotification.mock.calls.at(-1)!.arguments, options);
  assert.equal(browser.showNotification.mock.calls.at(-1)!.arguments[1]?.silent, true);
  for (const incoming of [options, attention({ tag: options.tag, attnId: 16, inboxRevision: 28, body: 'Older body' })]) {
    await deliver(incoming);
    assertMetadata(browser.showNotification.mock.calls.at(-1)!.arguments, options);
    assert.equal(browser.showNotification.mock.calls.at(-1)!.arguments[1]?.silent, true);
    assert.equal(browser.oscillatorCreations, 2);
  }
  const newer = { ...push, kind: 'choice' as const, attnId: 18, inboxRevision: 30,
    title: 'Newer push title', body: '' };
  await showPushNotification(newer, browser.registration, {});
  await deliver(options);
  assertMetadata(browser.showNotification.mock.calls.at(-1)!.arguments, newer);
  assert.equal(browser.showNotification.mock.calls.at(-1)!.arguments[1]?.silent, true);
  assert.equal(browser.oscillatorCreations, 2);
  const richer = { ...newer, inboxRevision: 31, body: 'Keep the newest question' };
  await deliver(richer);
  assertMetadata(browser.showNotification.mock.calls.at(-1)!.arguments, richer);
  assert.equal(browser.showNotification.mock.calls.at(-1)!.arguments[1]?.silent, true);
  assert.equal(browser.oscillatorCreations, 2);
  browser.showError = privateError();
  await deliver(options);
  assertMetadata(browser.page.mock.calls.at(-1)!.arguments, richer);
  assert.equal(browser.page.mock.calls.at(-1)!.arguments[1]?.silent, true);
  assert.equal(browser.page.mock.calls.at(-1)!.arguments[1]?.requireInteraction, false);
  assert.equal(browser.oscillatorCreations, 2);
  assertSanitizedFailure();
  browser.showError = null;
  browser.orderingError = privateError();
  await deliver(attention({ tag: 'other-session-tag', sessionId: 'other-session', attnId: 19, inboxRevision: 31 }));
  assert.equal(browser.showNotification.mock.calls.at(-1)!.arguments[1]?.silent, true);
  assert.equal(browser.oscillatorCreations, 2);
  assert.equal(browser.runOrdering.mock.callCount(), 9, 'Page and push must enter the same ordering store');
  assert.ok(browser.runOrdering.mock.calls.slice(0, -1).every((call) => call.arguments[0] === options.tag));
});

for (const failure of ['lookup', 'show'] as const) {
  for (const pageFails of [false, true]) {
    test(`rejected ${failure} is sanitized and page fallback ${pageFails ? 'failure is caught' : 'displays'}`, async () => {
      browser.permission = 'granted';
      if (failure === 'lookup') browser.lookupError = privateError();
      else browser.showError = privateError();
      if (pageFails) browser.pageError = privateError();
      const options = attention();
      await deliver(options);
      assert.equal(browser.getRegistration.mock.callCount(), 1);
      assert.equal(browser.showNotification.mock.callCount(), failure === 'show' ? 1 : 0);
      assert.equal(browser.page.mock.callCount(), 1);
      assertMetadata(browser.page.mock.calls[0].arguments, options);
      assert.equal(browser.oscillatorCreations, pageFails ? 0 : 2);
      assertSanitizedFailure();
    });
  }
}

test('page constructor failure without a registration is caught and sanitized locally', async () => {
  browser.permission = 'granted';
  browser.lookup.registration = undefined;
  browser.pageError = privateError();
  await deliver();
  assert.equal(browser.page.mock.callCount(), 1);
  assertSanitizedFailure();
});

test('asynchronous click and close failures never escape the page fallback', async () => {
  browser.permission = 'granted';
  browser.lookup.registration = undefined;
  browser.closeError = privateError();
  await deliver(attention({ onClick: async () => { throw privateError(); } }));
  assert.doesNotThrow(() => browser.instances[0].onclick?.());
  await drain();
  assertSanitizedFailure();
});

test('becoming visible or losing permission during lookup or ordering prevents delayed display and audio', async () => {
  browser.permission = 'granted';
  browser.getRegistration.mock.mockImplementation(async () => {
    browser.document.visibilityState = 'visible';
    return browser.registration;
  });
  await deliver();
  assert.equal(browser.showNotification.mock.callCount(), 0);
  browser.document.visibilityState = 'hidden';
  browser.getRegistration.mock.mockImplementation(async () => {
    browser.permission = 'denied';
    return browser.registration;
  });
  await deliver();
  assert.equal(browser.showNotification.mock.callCount(), 0);
  assert.equal(browser.page.mock.callCount(), 0);
  browser.getRegistration.mock.mockImplementation(async () => browser.registration);
  for (const block of [
    () => { browser.document.visibilityState = 'visible'; },
    () => { browser.permission = 'denied'; },
  ]) {
    browser.permission = 'granted';
    browser.document.visibilityState = 'hidden';
    browser.runOrdering.mock.mockImplementation(async (_tag, prepare) => {
      const work = prepare({});
      block();
      await work.apply();
    });
    await deliver();
    assert.equal(browser.showNotification.mock.callCount(), 0);
    assert.equal(browser.page.mock.callCount(), 0);
  }
  assert.equal(browser.oscillatorCreations, 0);
  assert.equal(browser.resumeCalls, 0);
});
