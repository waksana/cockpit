import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import {
  clearOsNotifications, disableLocalPush, getLocalPushSubscription, getSwRegistration,
  isStandalone, notificationEnvironment, pushSupported, registerServiceWorker, subscribeToPush,
} from './push';
import { dismissUxError, getUxErrors } from './errorReporter';

const KEY = new Uint8Array(createECDH('prime256v1').generateKeys());
const OTHER_KEY = new Uint8Array(createECDH('prime256v1').generateKeys());
const encoded = (key: Uint8Array) => Buffer.from(key).toString('base64url');
const privateError = () => new Error('https://push.invalid/private-endpoint?auth=private-auth');
const sanitized = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.ok(error.message.length > 15);
  assert.doesNotMatch(error.stack!, /push\.invalid|private-endpoint|private-auth/);
  assert.equal(error.cause, undefined);
  return true;
};
const pendingMutation = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'A local push subscription change is still pending. Wait for it to finish, then retry.');
  return sanitized(error);
};

function setup(t: TestContext) {
  const state = {
    permission: 'granted' as NotificationPermission,
    registerError: false, lookupError: false, readError: false, subscribeError: false,
    unsubscribeError: false, unsubscribeResult: true, jsonError: false,
    registered: true,
    notes: [] as { data: unknown; tag: string; close: () => void }[],
  };
  const json = { endpoint: 'https://push.invalid/private-endpoint', keys: { auth: 'private-auth', p256dh: 'public' } };
  const current = { subscription: null as PushSubscription | null };
  const unsubscribe = t.mock.fn(async () => {
    if (state.unsubscribeError) throw privateError();
    if (state.unsubscribeResult) current.subscription = null;
    return state.unsubscribeResult;
  });
  const sub = {
    options: { applicationServerKey: KEY.slice().buffer },
    unsubscribe,
    toJSON: () => { if (state.jsonError) throw privateError(); return json; },
  } as unknown as PushSubscription;
  current.subscription = sub;
  const getSubscription = t.mock.fn(async () => {
    if (state.readError) throw privateError();
    return current.subscription;
  });
  const subscribe = t.mock.fn(async (_options: PushSubscriptionOptionsInit) => {
    if (state.subscribeError) throw privateError();
    current.subscription = sub;
    return sub;
  });
  const getNotifications = t.mock.fn(async () => state.notes);
  const reg = {
    active: { state: 'activated' as ServiceWorkerState },
    installing: null as { state: ServiceWorkerState } | null,
    waiting: null,
    pushManager: { getSubscription, subscribe },
    getNotifications,
  };
  const register = t.mock.fn(async (_url: string, _options?: RegistrationOptions) => {
    if (state.registerError) throw privateError();
    return reg;
  });
  const getRegistration = t.mock.fn(async (_scope?: string) => {
    if (state.lookupError) throw privateError();
    return state.registered ? reg : undefined;
  });
  const ready = t.mock.fn(() => { throw new Error('Must not read serviceWorker.ready'); });
  const requestPermission = t.mock.fn(() => { throw new Error('Must not prompt for permission'); });
  const navigator = {
    platform: 'Linux x86_64', maxTouchPoints: 0, userAgent: 'Desktop browser', standalone: false,
    userActivation: { isActive: true },
    serviceWorker: { register, getRegistration, get ready() { return ready(); } },
  };
  class Notification {
    static get permission() { return state.permission; }
    static requestPermission = requestPermission;
  }
  const display = { installed: false };
  const window = {
    navigator, isSecureContext: true, location: new URL('https://cockpit.invalid/'),
    Notification, PushManager: class {},
    matchMedia: () => ({ matches: display.installed }),
  };
  for (const [name, value] of Object.entries({ navigator, window, Notification })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No business requests'); });
  t.mock.method(console, 'error', () => {});
  for (const error of getUxErrors()) dismissUxError(error.id);
  t.after(() => {
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(ready.mock.callCount(), 0);
    assert.equal(requestPermission.mock.callCount(), 0);
  });
  return { state, current, sub, json, reg, window, navigator, display,
    register, getRegistration, getSubscription, subscribe, unsubscribe, getNotifications };
}

test('environment requires HTTPS and APIs, but not desktop installation', (t) => {
  const b = setup(t);
  assert.deepEqual(notificationEnvironment(), { supported: true, installed: false, reason: null });
  assert.equal(pushSupported(), true);
  for (const property of ['Notification', 'PushManager'] as const) {
    const api = b.window[property];
    Reflect.deleteProperty(b.window, property);
    assert.equal(pushSupported(), false);
    Object.assign(b.window, { [property]: api });
  }
  b.window.isSecureContext = false;
  assert.match(notificationEnvironment().reason!, /HTTPS/);
  b.window.isSecureContext = true;
  b.window.location.protocol = 'http:';
  assert.equal(pushSupported(), false);
  b.window.location.protocol = 'https:';
  Reflect.deleteProperty(b.navigator, 'serviceWorker');
  assert.equal(pushSupported(), false);
});

test('iPhone, iPad and desktop-mode iPad require Home Screen installation', (t) => {
  const b = setup(t);
  for (const [userAgent, platform, maxTouchPoints] of [
    ['iPhone', 'iPhone', 5], ['iPad', 'iPad', 5], ['Macintosh', 'MacIntel', 5],
  ] as const) {
    Object.assign(b.navigator, { userAgent, platform, maxTouchPoints, standalone: false });
    b.display.installed = false;
    assert.equal(pushSupported(), false);
    assert.match(notificationEnvironment().reason!, /Home Screen/);
    b.navigator.standalone = true;
    assert.equal(isStandalone(), true);
    assert.equal(pushSupported(), true);
    b.navigator.standalone = false;
    b.display.installed = true;
    assert.equal(pushSupported(), true);
  }
});

test('matching key bytes reuse the subscription and return only JSON', async (t) => {
  const b = setup(t);
  assert.deepEqual(await subscribeToPush(encoded(KEY)), b.json);
  assert.deepEqual(await subscribeToPush(Buffer.from(KEY).toString('base64')), b.json);
  assert.equal(b.unsubscribe.mock.callCount(), 0);
  assert.equal(b.subscribe.mock.callCount(), 0);
  assert.deepEqual(b.register.mock.calls[0].arguments, ['/sw.js', { scope: '/' }]);
});

test('changed key requires successful removal, then subscribes with the requested bytes', async (t) => {
  const b = setup(t);
  assert.deepEqual(await subscribeToPush(encoded(OTHER_KEY)), b.json);
  assert.equal(b.unsubscribe.mock.callCount(), 1);
  assert.equal(b.subscribe.mock.callCount(), 1);
  const options = b.subscribe.mock.calls[0].arguments[0];
  assert.equal(options.userVisibleOnly, true);
  assert.deepEqual(options.applicationServerKey, OTHER_KEY);
});

for (const failure of ['false', 'rejection'] as const) {
  test(`changed key and disabling surface unsubscribe ${failure} without subscribing`, async (t) => {
    const b = setup(t);
    b.state.unsubscribeResult = failure !== 'false';
    b.state.unsubscribeError = failure === 'rejection';
    await assert.rejects(subscribeToPush(encoded(OTHER_KEY)), sanitized);
    assert.equal(b.current.subscription, b.sub);
    assert.equal(b.subscribe.mock.callCount(), 0);
    await assert.rejects(disableLocalPush(), sanitized);
    assert.equal(b.current.subscription, b.sub);
  });
}

test('transient lookup or JSON failures preserve the subscription and allow retry', async (t) => {
  const b = setup(t);
  b.state.readError = true;
  await assert.rejects(subscribeToPush(encoded(KEY)), sanitized);
  b.state.readError = false;
  b.state.jsonError = true;
  await assert.rejects(subscribeToPush(encoded(KEY)), sanitized);
  b.state.jsonError = false;
  assert.deepEqual(await subscribeToPush(encoded(KEY)), b.json);
  assert.equal(b.unsubscribe.mock.callCount(), 0);
  assert.equal(b.subscribe.mock.callCount(), 0);
});

test('subscription creation failure is sanitized and retry subscribes only when absent', async (t) => {
  const b = setup(t);
  b.state.subscribeError = true;
  await assert.rejects(subscribeToPush(encoded(OTHER_KEY)), sanitized);
  assert.equal(b.current.subscription, null);
  b.state.subscribeError = false;
  assert.deepEqual(await subscribeToPush(encoded(OTHER_KEY)), b.json);
  assert.equal(b.unsubscribe.mock.callCount(), 1);
  assert.equal(b.subscribe.mock.callCount(), 2);
});

test('permission is required before registration or mutation and never requested eagerly', async (t) => {
  const b = setup(t);
  for (const permission of ['default', 'denied'] as const) {
    b.state.permission = permission;
    await assert.rejects(subscribeToPush(encoded(KEY)), /permission/i);
  }
  assert.equal(b.register.mock.callCount(), 0);
  b.state.permission = 'granted';
  await assert.rejects(subscribeToPush('not a key?auth=private-auth'), sanitized);
  assert.equal(b.register.mock.callCount(), 0);
  t.mock.method(b.reg.pushManager, 'getSubscription', async () => {
    b.state.permission = 'denied';
    return b.sub;
  });
  await assert.rejects(subscribeToPush(encoded(OTHER_KEY)), /permission/i);
  assert.equal(b.unsubscribe.mock.callCount(), 0);
  assert.equal(b.subscribe.mock.callCount(), 0);
});

test('invalid replacement keys cannot remove a working subscription', async (t) => {
  const b = setup(t);
  for (const key of [new Uint8Array([4, 1, 2]), new Uint8Array(65).fill(4), new Uint8Array(65)]) {
    await assert.rejects(subscribeToPush(encoded(key)), sanitized);
  }
  assert.equal(b.register.mock.callCount(), 0);
  assert.equal(b.unsubscribe.mock.callCount(), 0);
  assert.equal(b.subscribe.mock.callCount(), 0);
  assert.equal(b.current.subscription, b.sub);
});

test('local lookup and disable do not register or require permission', async (t) => {
  const b = setup(t);
  b.state.permission = 'denied';
  assert.equal(await getLocalPushSubscription(), b.sub);
  await disableLocalPush();
  assert.equal(await getLocalPushSubscription(), null);
  await disableLocalPush();
  assert.equal(b.unsubscribe.mock.callCount(), 1);
  b.state.registered = false;
  assert.equal(await getSwRegistration(), null);
  assert.equal(b.register.mock.callCount(), 0);
});

test('timed-out unsubscribe blocks reenable and local reuse until native settlement, then allows retry', async (t) => {
  const b = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let finish!: () => void;
  let mutationStarted!: () => void;
  const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
  const native = new Promise<boolean>((resolve) => {
    finish = () => { b.current.subscription = null; resolve(true); };
  });
  b.unsubscribe.mock.mockImplementation(() => { mutationStarted(); return native; });

  let releaseReads!: () => void;
  let readsStarted!: () => void;
  const reading = new Promise<void>((resolve) => { readsStarted = resolve; });
  const reads = new Promise<void>((resolve) => { releaseReads = resolve; });
  let readCount = 0;
  b.getSubscription.mock.mockImplementation(async () => {
    if (++readCount <= 2) {
      if (readCount === 2) readsStarted();
      await reads;
    }
    return b.current.subscription;
  });
  t.after(() => { releaseReads(); finish(); });

  const reuse = assert.rejects(subscribeToPush(encoded(KEY)), pendingMutation);
  const localRead = assert.rejects(getLocalPushSubscription(), pendingMutation);
  await reading;
  const disabled = assert.rejects(disableLocalPush(), sanitized);
  await started;
  releaseReads();
  await Promise.all([reuse, localRead]);
  t.mock.timers.tick(10_001);
  await disabled;

  assert.equal(b.current.subscription, b.sub);
  await assert.rejects(subscribeToPush(encoded(KEY)), pendingMutation);
  await assert.rejects(subscribeToPush(encoded(OTHER_KEY)), pendingMutation);
  await assert.rejects(disableLocalPush(), pendingMutation);
  await assert.rejects(getLocalPushSubscription(), pendingMutation);
  assert.equal(b.unsubscribe.mock.callCount(), 1);
  assert.equal(b.subscribe.mock.callCount(), 0);
  assert.equal(b.getSubscription.mock.callCount(), 3);

  finish();
  await setImmediate();
  assert.equal(await getLocalPushSubscription(), null);
  assert.deepEqual(await subscribeToPush(encoded(KEY)), b.json);
  assert.equal(await getLocalPushSubscription(), b.sub);
  assert.equal(b.subscribe.mock.callCount(), 1);
  assert.equal(b.unsubscribe.mock.callCount(), 1);
});

test('timed-out subscribe blocks conflicting disable and matching reuse until native resolve or reject', async (t) => {
  const b = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const outcome of ['resolve', 'reject'] as const) {
    b.current.subscription = null;
    let finish!: () => void;
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
    const native = new Promise<PushSubscription>((resolve, reject) => {
      finish = () => {
        if (outcome === 'resolve') resolve(b.sub);
        else { b.current.subscription = null; reject(privateError()); }
      };
    });
    b.subscribe.mock.mockImplementation(() => {
      b.current.subscription = b.sub;
      mutationStarted();
      return native;
    });
    t.after(() => finish());
    const subscribed = assert.rejects(subscribeToPush(encoded(KEY)), sanitized);
    await started;
    t.mock.timers.tick(10_001);
    await subscribed;

    const reads = b.getSubscription.mock.callCount();
    const subscriptions = b.subscribe.mock.callCount();
    await assert.rejects(disableLocalPush(), pendingMutation);
    await assert.rejects(getLocalPushSubscription(), pendingMutation);
    await assert.rejects(subscribeToPush(encoded(KEY)), pendingMutation);
    await assert.rejects(subscribeToPush(encoded(OTHER_KEY)), pendingMutation);
    assert.equal(b.current.subscription, b.sub);
    assert.equal(b.unsubscribe.mock.callCount(), 0);
    assert.equal(b.subscribe.mock.callCount(), subscriptions);
    assert.equal(b.getSubscription.mock.callCount(), reads);

    finish();
    await setImmediate();
    b.subscribe.mock.restore();
    assert.equal(await getLocalPushSubscription(), outcome === 'resolve' ? b.sub : null);
    assert.deepEqual(await subscribeToPush(encoded(KEY)), b.json);
    assert.equal(b.subscribe.mock.callCount(), subscriptions + Number(outcome === 'reject'));
  }
  await disableLocalPush();
  assert.equal(await getLocalPushSubscription(), null);
  assert.equal(b.unsubscribe.mock.callCount(), 1);
});

test('registration and lookup errors are redacted, not swallowed or cached', async (t) => {
  const b = setup(t);
  b.state.registerError = true;
  await assert.rejects(registerServiceWorker(), sanitized);
  b.state.registerError = false;
  assert.equal(await registerServiceWorker(), b.reg);
  b.state.lookupError = true;
  await assert.rejects(getSwRegistration(), sanitized);
  b.state.lookupError = false;
  assert.equal(await getSwRegistration(), b.reg);
});

for (const operation of ['register', 'lookup', 'activation'] as const) {
  test(`${operation} waits are bounded and a subsequent attempt succeeds`, async (t) => {
    const b = setup(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    if (operation === 'activation') b.reg.active.state = 'activating';
    else t.mock.method(b.navigator.serviceWorker, operation === 'register' ? 'register' : 'getRegistration',
      () => new Promise<never>(() => {}));
    const run = operation === 'lookup' ? getSwRegistration : registerServiceWorker;
    const rejected = assert.rejects(run(), sanitized);
    await setImmediate();
    t.mock.timers.tick(10_001);
    await rejected;
    b.reg.active.state = 'activated';
    b.navigator.serviceWorker.register = b.register;
    b.navigator.serviceWorker.getRegistration = b.getRegistration;
    assert.equal(await run(), b.reg);
  });
}

test('activation waits on the returned registration, not an unrelated ready worker', async (t) => {
  const b = setup(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  b.reg.active.state = 'activating';
  let settled = false;
  const pending = registerServiceWorker().then((reg) => { settled = true; return reg; });
  await setImmediate();
  assert.equal(settled, false);
  b.reg.active.state = 'activated';
  t.mock.timers.tick(50);
  assert.equal(await pending, b.reg);
  b.reg.active.state = 'redundant';
  await assert.rejects(registerServiceWorker(), sanitized);
});

test('selective clearing protects unread, newer, unrelated, test and unconfirmed removed notes', async (t) => {
  const b = setup(t);
  const cases = [
    [{ sessionId: 'read', attnId: 2 }, true],
    [{ sessionId: 'read', attnId: 3 }, true],
    [{ sessionId: 'read', attnId: 4 }, false],
    [{ sessionId: 'unread', attnId: 1 }, true],
    [{ sessionId: 'unread', attnId: 5 }, false],
    [{ sessionId: 'resolved', attnId: 5 }, true],
    [{ sessionId: 'resolved', attnId: 6 }, false],
    [{ sessionId: 'legacy' }, true],
    [{ sessionId: 'legacy', attnId: 1 }, false],
    [{ sessionId: 'removed', attnId: 99 }, true],
    [{ sessionId: 'missing', attnId: 0 }, false],
    [{ sessionId: 'read', attnId: -1 }, false],
    [{ sessionId: 'read', attnId: null }, false],
    [{ sessionId: 'read', attnId: '1' }, false],
    [{ sessionId: 'read', attnId: 1, kind: 'test' }, false],
    [{ sessionId: 'read', attnId: 1, kind: 'other' }, false],
    [{ sessionId: 'read', attnId: 1, type: 'other' }, false],
    [{ attnId: 0 }, false],
  ] as const;
  const notes = cases.map(([data]) => ({ data, tag: 'session', close: t.mock.fn() }));
  const testNote = { data: { sessionId: 'read', attnId: 1 }, tag: 'push:test', close: t.mock.fn() };
  b.state.notes = [...notes, testNote];
  const sessions = Object.freeze([
    { sessionId: 'read', attention: 'choice', attnId: 3, seenId: 3 },
    { sessionId: 'unread', attention: 'ready', attnId: 5, seenId: 1 },
    { sessionId: 'resolved', attention: null, attnId: 5, seenId: 1 },
    { sessionId: 'legacy', attention: 'choice' },
  ] as const);
  await clearOsNotifications(sessions, ['removed', 'unread']);
  cases.forEach(([, close], index) => assert.equal(notes[index].close.mock.callCount(), Number(close), `note ${index}`));
  assert.equal(testNote.close.mock.callCount(), 0);
  await clearOsNotifications([]);
  await clearOsNotifications();
  assert.equal(b.getNotifications.mock.callCount(), 1);
});

test('clear failures are sanitized, handled, and do not stop other matching notes', async (t) => {
  const b = setup(t);
  const data = { kind: 'ready', sessionId: 'read', attnId: 2 };
  const close = t.mock.fn();
  b.state.notes = [
    { data, tag: 'read', close: () => { throw privateError(); } },
    { data, tag: 'read', close },
  ];
  await clearOsNotifications([{ sessionId: 'read', seenId: 2 }]);
  assert.equal(close.mock.callCount(), 1);
  b.state.lookupError = true;
  await clearOsNotifications([{ sessionId: 'read', seenId: 2 }]);
  assert.ok(getUxErrors().length);
  assert.doesNotMatch(JSON.stringify(getUxErrors()), /push\.invalid|private-auth/);
});
