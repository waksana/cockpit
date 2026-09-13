import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { PushDelivery, PushStatus } from '@cockpit/protocol';
import {
  createNotificationSettings, type Api, type NotificationSettingsDependencies,
  type NotificationSettingsState,
} from './notificationSettings';

function fakeKey(fill: number) {
  const bytes = new Uint8Array(65).fill(fill);
  bytes[0] = 4;
  return bytes;
}

const KEY = fakeKey(11);
const OLD_KEY = fakeKey(22);
const P256DH = fakeKey(33);
const AUTH = new Uint8Array(16).fill(44);
const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const ENDPOINT = 'https://push.example.invalid/private-device';
const NEXT_ENDPOINT = 'https://push.example.invalid/private-replacement';
const PRIVATE = `${ENDPOINT} ${NEXT_ENDPOINT} ${encoded(KEY)} ${encoded(AUTH)} ${encoded(P256DH)}`;
const OPTIONS = { timeout: 2_000 };

function gate<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let entered!: () => void;
  const result = new Promise<T>((done) => { resolve = done; });
  const started = new Promise<void>((done) => { entered = done; });
  return {
    entered: started,
    resolve,
    wait: () => { entered(); return result; },
  };
}

function storageDependencies(t: TestContext, h: ReturnType<typeof setup>, storage: Partial<Storage>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const deps: Partial<NotificationSettingsDependencies> = { ...h.deps };
  delete deps.loadDisabled;
  delete deps.saveDisabled;
  return () => {
    const controller = createNotificationSettings((state) => h.snapshots.push(state), deps);
    t.after(() => controller.disconnect());
    return controller;
  };
}

function setup(t: TestContext) {
  const browser = {
    permission: 'granted' as NotificationPermission,
    local: null as PushSubscription | null,
    unsubscribeOk: true,
    disabled: false,
  };
  const server = {
    configured: true,
    publicKey: encoded(KEY),
    records: new Set<string>(),
    unsubscribeOk: true,
    lastDelivery: undefined as PushDelivery | undefined,
    delivery: { status: 'accepted', at: 1 } as PushDelivery,
  };
  const events: string[] = [];
  const snapshots: NotificationSettingsState[] = [];
  const listeners = new Set<() => void>();
  const removeForeground = t.mock.fn((refresh: () => void) => { listeners.delete(refresh); });

  function subscription(endpoint = ENDPOINT, key = KEY) {
    const sub = {
      endpoint,
      expirationTime: null,
      options: { applicationServerKey: key.slice().buffer, userVisibleOnly: true },
      getKey: (name: PushEncryptionKeyName) => (name === 'auth' ? AUTH : P256DH).slice().buffer,
      toJSON: () => ({
        endpoint, expirationTime: null, keys: { auth: encoded(AUTH), p256dh: encoded(P256DH) },
      }),
      unsubscribe: t.mock.fn(async () => {
        events.push('browser:unsubscribe');
        if (browser.unsubscribeOk && browser.local === sub) browser.local = null;
        return browser.unsubscribeOk;
      }),
    } satisfies PushSubscription;
    return sub;
  }

  function status(endpoint?: string): PushStatus {
    return {
      configured: server.configured,
      publicKey: server.publicKey,
      subscriptionCount: server.records.size,
      registered: !!endpoint && server.records.has(endpoint),
      ...(server.lastDelivery ? { lastDelivery: server.lastDelivery } : {}),
    };
  }

  const api = {
    pushStatus: t.mock.fn(async (endpoint?: string) => {
      events.push('server:status');
      return status(endpoint);
    }),
    subscribePush: t.mock.fn(async (json: PushSubscriptionJSON): Promise<{ ok: boolean }> => {
      events.push('server:subscribe');
      assert.ok(json.endpoint);
      server.records.add(json.endpoint);
      return { ok: true };
    }),
    unsubscribePush: t.mock.fn(async (endpoint: string) => {
      events.push('server:unsubscribe');
      if (server.unsubscribeOk) server.records.delete(endpoint);
      return { ok: server.unsubscribeOk };
    }),
    testPush: t.mock.fn(async (_endpoint: string) => server.delivery),
  } satisfies Api;
  const deps = {
    environment: t.mock.fn(() => ({ supported: true, installed: false, reason: null })),
    permission: () => browser.permission,
    requestPermission: t.mock.fn(() => {
      events.push('permission');
      return Promise.resolve(browser.permission === 'granted');
    }),
    getSubscription: t.mock.fn(async () => {
      events.push('browser:get');
      return browser.local;
    }),
    subscribe: t.mock.fn(async (key: string) => {
      events.push('browser:subscribe');
      if (browser.local && !await browser.local.unsubscribe()) throw new Error(PRIVATE);
      browser.local = subscription(NEXT_ENDPOINT, new Uint8Array(Buffer.from(key, 'base64url')));
      return browser.local.toJSON();
    }),
    disable: t.mock.fn(async () => {
      events.push('browser:disable');
      if (browser.local && !await browser.local.unsubscribe()) throw new Error(PRIVATE);
    }),
    loadDisabled: t.mock.fn(() => browser.disabled),
    saveDisabled: t.mock.fn((disabled: boolean) => { browser.disabled = disabled; }),
    listenForeground: t.mock.fn((refresh: () => void) => {
      listeners.add(refresh);
      return () => removeForeground(refresh);
    }),
  } satisfies NotificationSettingsDependencies;
  const controller = createNotificationSettings((state) => snapshots.push(state), deps);
  t.after(() => {
    controller.disconnect();
    for (const snapshot of snapshots) {
      if (snapshot.ready) {
        assert.equal(snapshot.supported, true);
        assert.equal(snapshot.permission, 'granted');
        assert.equal(snapshot.configured, true);
        assert.equal(snapshot.registered, true);
        assert.equal(snapshot.disabled, false);
        assert.equal(snapshot.deliveryOwned, true);
      }
    }
    const serialized = JSON.stringify([...snapshots, controller.state()]);
    assert.doesNotMatch(serialized, /push\.example\.invalid|endpoint|publicKey|applicationServerKey|p256dh|auth/);
    for (const secret of [KEY, OLD_KEY, P256DH, AUTH]) {
      assert.equal(serialized.includes(encoded(secret)), false, 'public snapshots must redact keys');
    }
  });
  return {
    browser, server, events, snapshots, listeners, removeForeground, subscription,
    status, api, deps, controller,
    connect: async () => { controller.connect(api); await controller.refresh(); },
    foreground: () => { for (const refresh of listeners) refresh(); },
  };
}

test('granted permission alone is not ready; connect and passive refresh never create or prompt', OPTIONS, async (t) => {
  const h = setup(t);
  assert.equal(h.controller.state().permission, 'granted');
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().disabled, false);
  assert.equal(h.controller.state().deliveryOwned, false);
  await h.connect();
  await h.controller.refresh();
  h.foreground();
  await h.controller.refresh();
  assert.deepEqual(h.api.pushStatus.mock.calls.map((call) => call.arguments), [[undefined], [undefined], [undefined]]);
  assert.equal(h.controller.state().registered, false);
  assert.ok(h.snapshots.every((state) => !state.ready));
  for (const fn of [h.deps.requestPermission, h.deps.subscribe, h.deps.disable,
    h.api.subscribePush, h.api.unsubscribePush, h.api.testPush]) {
    assert.equal(fn.mock.callCount(), 0);
  }
});

test('enable requests permission synchronously in the click stack before any awaited lookup', OPTIONS, async (t) => {
  const h = setup(t);
  h.browser.permission = 'default';
  await h.connect();
  h.events.length = 0;
  const permission = gate<boolean>();
  h.deps.requestPermission.mock.mockImplementation(() => {
    h.events.push('permission');
    return permission.wait();
  });
  const enabling = h.controller.enable();
  assert.deepEqual(h.events, ['permission']);
  assert.equal(h.deps.requestPermission.mock.callCount(), 1);
  await setImmediate();
  assert.deepEqual(h.events, ['permission']);
  assert.equal(h.controller.state().ready, false);
  h.browser.permission = 'granted';
  permission.resolve(true);
  await enabling;
  assert.equal(h.controller.state().ready, true);
  assert.equal(h.controller.state().deliveryOwned, true);
  assert.deepEqual(h.deps.subscribe.mock.calls.map((call) => call.arguments), [[encoded(KEY)]]);
  assert.deepEqual(h.api.pushStatus.mock.calls.map((call) => call.arguments),
    [[undefined], [undefined], [NEXT_ENDPOINT]]);
  assert.equal(h.api.subscribePush.mock.callCount(), 1);
  assert.equal(h.api.testPush.mock.callCount(), 0);
});

test('registration needs a true subscribe ACK and registered followup status, never just either one', OPTIONS, async (t) => {
  const h = setup(t);
  h.browser.local = h.subscription();
  const ack = gate<{ ok: boolean }>();
  const followup = gate<PushStatus>();
  h.api.subscribePush.mock.mockImplementation(() => ack.wait());
  h.api.pushStatus.mock.mockImplementation(() => followup.wait());
  h.api.pushStatus.mock.mockImplementationOnce(async (endpoint) => h.status(endpoint));
  h.controller.connect(h.api);
  const connecting = h.controller.refresh();
  await ack.entered;
  assert.ok(h.snapshots.every((state) => !state.ready));
  ack.resolve({ ok: true });
  await followup.entered;
  assert.ok(h.snapshots.every((state) => !state.ready));
  followup.resolve({ ...h.status(ENDPOINT), registered: true });
  await connecting;
  assert.equal(h.controller.state().ready, true);

  for (const [ok, registered] of [[false, true], [true, false], [true, undefined]] as const) {
    const failed = setup(t);
    failed.browser.local = failed.subscription();
    failed.api.subscribePush.mock.mockImplementation(async () => ({ ok }));
    failed.api.pushStatus.mock.mockImplementation(async (endpoint) => ({
      ...failed.status(endpoint), registered,
    }));
    failed.api.pushStatus.mock.mockImplementationOnce(async (endpoint) => failed.status(endpoint));
    await failed.connect();
    assert.ok(failed.snapshots.every((state) => !state.ready), `ACK=${ok}, registered=${registered}`);
    assert.match(failed.controller.state().error!, /服务端未确认订阅注册/);
    assert.equal(failed.api.pushStatus.mock.callCount(), ok ? 2 : 1);
    assert.equal(failed.deps.subscribe.mock.callCount(), 0);
  }
});

test('a registered matching subscription is reused without browser or server resubscription', OPTIONS, async (t) => {
  const h = setup(t);
  const local = h.subscription();
  h.browser.local = local;
  h.server.records.add(local.endpoint);
  await h.connect();
  await h.controller.refresh();
  await h.controller.enable();
  assert.equal(h.controller.state().ready, true);
  assert.equal(h.browser.local, local);
  assert.ok(h.api.pushStatus.mock.calls.every((call) => call.arguments[0] === local.endpoint));
  for (const fn of [h.deps.subscribe, local.unsubscribe, h.api.subscribePush, h.api.testPush]) {
    assert.equal(fn.mock.callCount(), 0);
  }
  h.server.configured = false;
  await h.controller.refresh();
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().deliveryOwned, false);
  h.server.configured = true;
  h.browser.permission = 'denied';
  await h.controller.refresh();
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().deliveryOwned, false);
  assert.equal(h.browser.local, local);
});

test('a missing server record is healed on connect and refresh without creating a browser subscription', OPTIONS, async (t) => {
  const h = setup(t);
  const local = h.subscription();
  h.browser.local = local;
  await h.connect();
  assert.equal(h.controller.state().ready, true);
  h.server.records.delete(local.endpoint);
  await h.controller.refresh();
  assert.equal(h.controller.state().ready, true);
  assert.deepEqual(h.api.subscribePush.mock.calls.map((call) => call.arguments),
    [[local.toJSON()], [local.toJSON()]]);
  assert.equal(h.browser.local, local);
  for (const fn of [h.deps.subscribe, local.unsubscribe, h.deps.requestPermission, h.api.testPush]) {
    assert.equal(fn.mock.callCount(), 0);
  }
});

test('status follows the current endpoint, retrying an external change during an outstanding query', OPTIONS, async (t) => {
  const h = setup(t);
  const first = h.subscription();
  const second = h.subscription(NEXT_ENDPOINT);
  const third = h.subscription(`${ENDPOINT}-third`);
  h.browser.local = first;
  for (const sub of [first, second, third]) h.server.records.add(sub.endpoint);
  const pending = gate<PushStatus>();
  h.api.pushStatus.mock.mockImplementationOnce(() => pending.wait());
  h.controller.connect(h.api);
  const connecting = h.controller.refresh();
  await pending.entered;
  h.browser.local = second;
  pending.resolve({
    ...h.status(first.endpoint),
    lastDelivery: { status: 'expired', at: 1, error: PRIVATE },
  });
  await connecting;
  assert.equal(h.controller.state().ready, true);
  assert.ok(h.snapshots.every((state) => state.lastDelivery === undefined));
  h.browser.local = third;
  await h.controller.refresh();
  h.browser.local = null;
  await h.controller.refresh();
  assert.equal(h.controller.state().deliveryOwned, false);
  assert.deepEqual(h.api.pushStatus.mock.calls.map((call) => call.arguments[0]),
    [first.endpoint, second.endpoint, third.endpoint, undefined]);
  assert.equal(h.controller.state().ready, false);
  for (const fn of [h.deps.subscribe, h.api.subscribePush, first.unsubscribe, second.unsubscribe, third.unsubscribe]) {
    assert.equal(fn.mock.callCount(), 0);
  }
});

test('confirmed expired endpoints stay unready until explicit enable replaces the browser subscription', OPTIONS, async (t) => {
  const h = setup(t);
  h.browser.local = h.subscription();
  h.server.lastDelivery = { status: 'expired', at: 1 };
  await h.connect();
  assert.equal(h.controller.state().ready, false);
  assert.match(h.controller.state().error ?? '', /过期/);
  assert.equal(h.api.subscribePush.mock.callCount(), 0);
  assert.equal(h.deps.subscribe.mock.callCount(), 0);
  h.api.subscribePush.mock.mockImplementation(async (sub) => {
    assert.equal(sub.endpoint, NEXT_ENDPOINT);
    h.server.records.add(NEXT_ENDPOINT);
    h.server.lastDelivery = undefined;
    return { ok: true };
  });
  await h.controller.enable();
  assert.equal(h.deps.disable.mock.callCount(), 1);
  assert.equal(h.deps.subscribe.mock.callCount(), 1);
  assert.equal(h.controller.state().ready, true);
});

test('failed rotation retains the old cleanup endpoint for retry across reconnect, without passive creation', OPTIONS, async (t) => {
  const h = setup(t);
  const old = h.subscription(ENDPOINT, OLD_KEY);
  h.browser.local = old;
  h.server.records.add(old.endpoint);
  h.deps.subscribe.mock.mockImplementation(async () => {
    await old.unsubscribe();
    throw new Error(PRIVATE);
  });
  await h.connect();
  assert.equal(h.browser.local, null);
  assert.match(h.controller.state().error!, /无法创建或更新本地推送订阅/);
  assert.equal(h.api.unsubscribePush.mock.callCount(), 0);
  h.server.unsubscribeOk = false;
  await h.controller.refresh();
  assert.match(h.controller.state().error!, /旧订阅的服务端清理失败/);
  assert.equal(h.server.records.has(old.endpoint), true);
  h.controller.disconnect();
  h.server.unsubscribeOk = true;
  await h.connect();
  await h.controller.refresh();
  assert.deepEqual(h.api.unsubscribePush.mock.calls.map((call) => call.arguments), [[old.endpoint], [old.endpoint]]);
  assert.equal(h.server.records.size, 0);
  assert.equal(h.browser.local, null);
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.deps.subscribe.mock.callCount(), 1);
  assert.equal(h.deps.requestPermission.mock.callCount(), 0);
  h.deps.subscribe.mock.restore();
  await h.controller.enable();
  assert.equal(h.controller.state().ready, true);
  assert.equal((await h.deps.getSubscription())?.endpoint, NEXT_ENDPOINT);
  assert.equal(h.api.unsubscribePush.mock.callCount(), 2);
});

test('transient status and registration failures never destroy a matching local subscription', OPTIONS, async (t) => {
  const h = setup(t);
  const local = h.subscription();
  h.browser.local = local;
  h.server.records.add(local.endpoint);
  h.api.pushStatus.mock.mockImplementation(async () => { throw new Error(PRIVATE); });
  await h.connect();
  assert.match(h.controller.state().error!, /无法确认服务端推送状态/);
  assert.equal(h.browser.local, local);
  h.api.pushStatus.mock.restore();
  h.server.records.clear();
  h.api.subscribePush.mock.mockImplementation(async () => { throw new Error(PRIVATE); });
  await h.controller.refresh();
  assert.match(h.controller.state().error!, /服务端未确认订阅注册/);
  assert.equal(h.browser.local, local);
  h.api.subscribePush.mock.restore();
  await h.controller.refresh();
  assert.equal(h.controller.state().ready, true);
  for (const fn of [local.unsubscribe, h.deps.subscribe, h.deps.disable, h.api.unsubscribePush]) {
    assert.equal(fn.mock.callCount(), 0);
  }
});

test('reconnect and disconnect suppress stale status work and remove obsolete foreground listeners', OPTIONS, async (t) => {
  const h = setup(t);
  h.browser.local = h.subscription();
  h.server.records.add(ENDPOINT);
  const oldStatus = gate<PushStatus>();
  h.api.pushStatus.mock.mockImplementation(() => oldStatus.wait());
  h.controller.connect(h.api);
  const oldWork = h.controller.refresh();
  await oldStatus.entered;
  const nextApi = {
    ...h.api,
    pushStatus: t.mock.fn(async (endpoint?: string) => h.status(endpoint)),
  } satisfies Api;
  h.controller.connect(nextApi);
  const nextWork = h.controller.refresh();
  assert.equal(h.listeners.size, 1);
  assert.equal(h.removeForeground.mock.callCount(), 1);
  await setImmediate();
  assert.equal(nextApi.pushStatus.mock.callCount(), 0);
  oldStatus.resolve({ ...h.status(ENDPOINT), publicKey: encoded(OLD_KEY), registered: false, error: PRIVATE });
  await Promise.all([oldWork, nextWork]);
  assert.equal(h.controller.state().ready, true);
  assert.ok(h.snapshots.every((state) => state.error === null));
  assert.equal(nextApi.pushStatus.mock.callCount(), 1);

  const disconnectedStatus = gate<PushStatus>();
  nextApi.pushStatus.mock.mockImplementation(() => disconnectedStatus.wait());
  const refreshing = h.controller.refresh();
  await disconnectedStatus.entered;
  h.controller.disconnect();
  const disconnected = h.controller.state();
  const publications = h.snapshots.length;
  disconnectedStatus.resolve(h.status(ENDPOINT));
  await refreshing;
  assert.deepEqual(h.controller.state(), disconnected);
  assert.equal(h.snapshots.length, publications);
  assert.equal(h.listeners.size, 0);
  for (const fn of [h.deps.subscribe, h.api.subscribePush, h.api.unsubscribePush]) {
    assert.equal(fn.mock.callCount(), 0);
  }

  h.api.pushStatus.mock.restore();
  await h.connect();
  assert.equal(h.controller.state().deliveryOwned, true);
  const removal = gate<{ ok: boolean }>();
  h.api.unsubscribePush.mock.mockImplementationOnce(() => removal.wait());
  const disabling = h.controller.disable();
  await removal.entered;
  h.controller.disconnect();
  assert.equal(h.controller.state().deliveryOwned, true);
  removal.resolve({ ok: true });
  await disabling;
  assert.equal(h.controller.state().deliveryOwned, false, 'a completed server removal survives a superseding disconnect');
  assert.equal(h.controller.state().message, null);
});

test('disable supersedes a pending permission action and a competing queued enable without stale publication', OPTIONS, async (t) => {
  const h = setup(t);
  const local = h.subscription();
  h.browser.local = local;
  h.server.records.add(local.endpoint);
  await h.connect();
  const permission = gate<boolean>();
  h.deps.requestPermission.mock.mockImplementation(() => permission.wait());
  const enabling = h.controller.enable();
  await permission.entered;
  const disabling = h.controller.disable();
  const publications = h.snapshots.length;
  await disabling;
  assert.equal(h.browser.local, null, 'disable must not wait for an unanswered native permission prompt');
  permission.resolve(true);
  await Promise.all([enabling, disabling]);
  assert.equal(h.browser.local, null);
  assert.equal(h.controller.state().message, '已停用当前设备的推送通知。');
  assert.ok(h.snapshots.slice(publications).every((state) => !state.ready && state.error === null));
  const queuedEnable = h.controller.enable();
  const winningDisable = h.controller.disable();
  await Promise.all([queuedEnable, winningDisable]);
  assert.equal(h.controller.state().ready, false);
  assert.equal(local.unsubscribe.mock.callCount(), 1);
  assert.equal(h.deps.subscribe.mock.callCount(), 0);
  assert.equal(h.api.subscribePush.mock.callCount(), 0);
});

test('permission lost during old-endpoint cleanup cannot leave the device ready', OPTIONS, async (t) => {
  const h = setup(t);
  h.browser.local = h.subscription(ENDPOINT, OLD_KEY);
  h.server.records.add(ENDPOINT);
  const cleanup = gate<{ ok: boolean }>();
  h.api.unsubscribePush.mock.mockImplementation(() => cleanup.wait());
  h.controller.connect(h.api);
  const connecting = h.controller.refresh();
  await cleanup.entered;
  assert.equal(h.controller.state().ready, true);
  h.browser.permission = 'denied';
  cleanup.resolve({ ok: true });
  await connecting;
  assert.equal(h.controller.state().permission, 'denied');
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().deliveryOwned, false);
  assert.equal(h.controller.state().message, null);
  assert.match(h.controller.state().error!, /尚未获得通知权限/);
});

test('a subscription removed during rotation cleanup invalidates readiness without passive recreation', OPTIONS, async (t) => {
  for (const ok of [true, false]) {
    const h = setup(t);
    h.browser.local = h.subscription(ENDPOINT, OLD_KEY);
    h.server.records.add(ENDPOINT);
    const cleanup = gate<{ ok: boolean }>();
    h.api.unsubscribePush.mock.mockImplementation(() => cleanup.wait());
    h.controller.connect(h.api);
    const connecting = h.controller.refresh();
    await cleanup.entered;
    assert.equal(h.controller.state().ready, true);
    h.browser.local = null;
    h.server.records.delete(NEXT_ENDPOINT);
    cleanup.resolve({ ok });
    await connecting;
    assert.equal(h.controller.state().ready, false);
    assert.equal(h.controller.state().registered, null);
    assert.equal(h.controller.state().message, null);
    assert.match(h.controller.state().error!, /本地推送订阅已变化/);
    await h.controller.refresh();
    assert.equal(h.controller.state().registered, false);
    assert.equal(h.deps.subscribe.mock.callCount(), 1);
    assert.equal(h.deps.requestPermission.mock.callCount(), 0);
  }
});

test('a test result for a replaced local endpoint cannot become the current device diagnostic', OPTIONS, async (t) => {
  const h = setup(t);
  h.browser.local = h.subscription();
  h.server.records.add(ENDPOINT);
  await h.connect();
  const delivery = gate<PushDelivery>();
  h.api.testPush.mock.mockImplementation(() => delivery.wait());
  const testing = h.controller.sendTest(true);
  await delivery.entered;
  h.browser.local = h.subscription(NEXT_ENDPOINT);
  delivery.resolve({ status: 'accepted', at: 1 });
  await testing;
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().lastDelivery, undefined);
  assert.equal(h.controller.state().message, null);
  assert.match(h.controller.state().error!, /本地推送订阅已变化/);
  assert.equal(h.api.testPush.mock.callCount(), 1);
  assert.equal(h.deps.subscribe.mock.callCount(), 0);
});

test('an in-flight browser creation is serialized across reconnect and disable wins its completed mutation', OPTIONS, async (t) => {
  const h = setup(t);
  await h.connect();
  h.events.length = 0;
  const creation = gate<void>();
  const created = h.subscription(NEXT_ENDPOINT);
  h.deps.subscribe.mock.mockImplementation(async () => {
    h.events.push('browser:create:start');
    await creation.wait();
    h.browser.local = created;
    h.events.push('browser:create:end');
    return created.toJSON();
  });
  const enabling = h.controller.enable();
  await creation.entered;
  h.controller.disconnect();
  h.controller.connect(h.api);
  const disabling = h.controller.disable();
  const publications = h.snapshots.length;
  await setImmediate();
  assert.equal(h.deps.disable.mock.callCount(), 0);
  assert.equal(h.api.unsubscribePush.mock.callCount(), 0);
  creation.resolve();
  await Promise.all([enabling, disabling]);
  assert.deepEqual(h.events.filter((event) => event.startsWith('browser:create')
    || event === 'server:unsubscribe' || event === 'browser:disable' || event === 'browser:unsubscribe'),
  ['browser:create:start', 'browser:create:end', 'server:unsubscribe', 'browser:disable', 'browser:unsubscribe']);
  assert.deepEqual(h.api.unsubscribePush.mock.calls.map((call) => call.arguments), [[created.endpoint]]);
  assert.equal(h.api.subscribePush.mock.callCount(), 0);
  assert.equal(h.browser.local, null);
  assert.equal(h.controller.state().message, '已停用当前设备的推送通知。');
  assert.equal(h.controller.state().disabled, true);
  assert.equal(h.controller.state().deliveryOwned, false);
  assert.ok(h.snapshots.slice(publications).every((state) => !state.ready && state.error === null));
});

test('disable requires backend ACK first, preserves local failure, and passive refresh cannot undo partial disable', OPTIONS, async (t) => {
  const h = setup(t);
  const local = h.subscription();
  h.browser.local = local;
  h.server.records.add(local.endpoint);
  await h.connect();
  const ack = gate<{ ok: boolean }>();
  h.api.unsubscribePush.mock.mockImplementation(() => ack.wait());
  const disabling = h.controller.disable();
  await ack.entered;
  assert.equal(h.deps.disable.mock.callCount(), 0);
  assert.equal(local.unsubscribe.mock.callCount(), 0);
  ack.resolve({ ok: false });
  await disabling;
  assert.match(h.controller.state().error!, /服务端未确认停用/);
  assert.equal(h.browser.local, local);
  assert.equal(h.deps.disable.mock.callCount(), 0);

  h.api.unsubscribePush.mock.restore();
  h.browser.unsubscribeOk = false;
  await h.controller.disable();
  assert.equal(h.server.records.has(local.endpoint), false);
  assert.equal(h.browser.local, local);
  assert.equal(h.controller.state().registered, false);
  assert.match(h.controller.state().error!, /服务端订阅已移除，但本地停用失败/);
  await h.controller.refresh();
  h.controller.disconnect();
  await h.connect();
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.browser.local, local);
  assert.equal(h.api.subscribePush.mock.callCount(), 0);
  assert.equal(h.deps.subscribe.mock.callCount(), 0);
  h.browser.unsubscribeOk = true;
  await h.controller.disable();
  assert.equal(h.browser.local, null);
  assert.equal(h.controller.state().error, null);
  assert.equal(h.controller.state().message, '已停用当前设备的推送通知。');
});

test('refresh coalesces foreground floods and bounds retries when endpoints keep changing', OPTIONS, async (t) => {
  const h = setup(t);
  const first = h.subscription();
  const second = h.subscription(NEXT_ENDPOINT);
  h.browser.local = first;
  h.server.records.add(first.endpoint);
  const pending = gate<PushStatus>();
  h.api.pushStatus.mock.mockImplementation(() => pending.wait());
  h.controller.connect(h.api);
  const active = h.controller.refresh();
  await pending.entered;
  for (let index = 0; index < 12; index++) {
    h.foreground();
    assert.equal(h.controller.refresh(), active);
  }
  pending.resolve(h.status(first.endpoint));
  await active;
  await setImmediate();
  assert.equal(h.api.pushStatus.mock.callCount(), 1);
  assert.equal(h.controller.state().busy, false);
  assert.equal(h.controller.state().ready, true);
  h.api.pushStatus.mock.restore();
  await h.controller.refresh();
  assert.equal(h.api.pushStatus.mock.callCount(), 2);

  let reads = 0;
  h.deps.getSubscription.mock.mockImplementation(async () => ++reads % 2 ? first : second);
  await h.controller.refresh();
  assert.equal(reads, 4);
  assert.equal(h.api.pushStatus.mock.callCount(), 4);
  assert.equal(h.controller.state().busy, false);
  assert.equal(h.controller.state().ready, false);
  assert.match(h.controller.state().error!, /本地推送订阅已变化/);
  assert.equal(h.deps.subscribe.mock.callCount(), 0);
  assert.equal(h.api.subscribePush.mock.callCount(), 0);
});

test('only an explicit confirmed ready test sends, with exact acceptance wording and redacted delivery diagnostics', OPTIONS, async (t) => {
  const h = setup(t);
  await h.controller.sendTest(true);
  await h.connect();
  await h.controller.sendTest(true);
  assert.equal(h.api.testPush.mock.callCount(), 0);
  h.browser.local = h.subscription();
  h.server.records.add(ENDPOINT);
  await h.controller.refresh();
  assert.equal(h.controller.state().ready, true);
  for (const confirmation of [undefined, false, 1, 'true']) {
    await Reflect.apply(h.controller.sendTest, undefined, [confirmation]);
  }
  assert.equal(h.api.testPush.mock.callCount(), 0);
  h.browser.local = h.subscription(NEXT_ENDPOINT);
  await h.controller.sendTest(true);
  assert.equal(h.api.testPush.mock.callCount(), 0);
  assert.equal(h.api.subscribePush.mock.callCount(), 0);
  h.server.records.add(NEXT_ENDPOINT);
  await h.controller.refresh();
  const delivery = gate<PushDelivery>();
  h.api.testPush.mock.mockImplementation(() => delivery.wait());
  const sending = h.controller.sendTest(true);
  await delivery.entered;
  await h.controller.sendTest(true);
  assert.equal(h.api.testPush.mock.callCount(), 1);
  delivery.resolve({ status: 'accepted', at: 10 });
  await sending;
  assert.equal(h.controller.state().message, '推送服务已接受，仍需确认设备收到');
  assert.deepEqual(h.api.testPush.mock.calls[0].arguments, [NEXT_ENDPOINT]);

  const diagnostic = {
    status: 'failed' as const, at: 11, error: PRIVATE,
    endpoint: NEXT_ENDPOINT, keys: { auth: encoded(AUTH), p256dh: encoded(P256DH) },
  };
  h.api.testPush.mock.restore();
  h.server.delivery = diagnostic;
  await h.controller.sendTest(true);
  assert.deepEqual(h.controller.state().lastDelivery,
    { status: 'failed', at: 11, error: '推送测试失败，请稍后重试。' });
  assert.equal(h.controller.state().message, null);
  const detached = h.controller.state();
  detached.lastDelivery!.error = PRIVATE;
  assert.equal(h.controller.state().lastDelivery?.error, '推送测试失败，请稍后重试。');
  h.server.lastDelivery = diagnostic;
  await h.controller.refresh();
  assert.equal(h.controller.state().lastDelivery?.error, '推送测试失败，请稍后重试。');
  h.api.testPush.mock.mockImplementation(async () => { throw new Error(PRIVATE); });
  await h.controller.sendTest(true);
  assert.equal(h.controller.state().error, '推送测试失败，请稍后重试。');
  h.api.testPush.mock.restore();
  h.server.delivery = { status: 'expired', at: 12, error: PRIVATE };
  await h.controller.sendTest(true);
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().registered, false);
  assert.equal(h.controller.state().deliveryOwned, false);
  const sent = h.api.testPush.mock.callCount();
  await h.controller.sendTest(true);
  assert.equal(h.api.testPush.mock.callCount(), sent);
  await h.controller.refresh();
  assert.equal(h.controller.state().deliveryOwned, true);
  h.api.testPush.mock.mockImplementation(async () => {
    h.deps.getSubscription.mock.mockImplementationOnce(async () => { throw new Error(PRIVATE); });
    return h.server.delivery;
  });
  await h.controller.sendTest(true);
  assert.equal(h.controller.state().deliveryOwned, false, 'confirmed expiration wins over a failed follow-up local read');
  assert.match(h.controller.state().error!, /无法读取本地推送订阅/);
});

test('device opt-out survives failed local removal and reload, and only explicit enable clears its single flag', OPTIONS, async (t) => {
  const h = setup(t);
  const stored = new Map<string, string>();
  const create = storageDependencies(t, h, {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: (key) => { stored.delete(key); },
  });
  h.browser.local = h.subscription();
  h.server.records.add(ENDPOINT);
  const first = create();
  first.connect(h.api);
  await first.refresh();
  assert.equal(first.state().deliveryOwned, true);
  h.browser.unsubscribeOk = false;
  const disabling = first.disable();
  assert.equal(first.state().disabled, true, 'page fallback is suppressed synchronously');
  await disabling;
  assert.match(first.state().error!, /本地停用失败/);
  assert.deepEqual([...stored], [['cockpit.notifications.disabled', '1']]);
  first.disconnect();

  const reloaded = create();
  assert.equal(reloaded.state().disabled, true);
  reloaded.connect(h.api);
  await reloaded.refresh();
  await reloaded.refresh();
  assert.equal(reloaded.state().ready, false);
  assert.equal(reloaded.state().deliveryOwned, false);
  assert.equal(h.api.subscribePush.mock.callCount(), 0);
  assert.equal(h.deps.subscribe.mock.callCount(), 0);
  assert.equal(h.deps.requestPermission.mock.callCount(), 0);
  await reloaded.enable();
  assert.equal(stored.size, 0);
  assert.equal(reloaded.state().disabled, false);
  assert.equal(reloaded.state().ready, true);
  assert.equal(reloaded.state().deliveryOwned, true);
  reloaded.disconnect();
  await reloaded.disable();
  assert.equal(create().state().disabled, true, 'offline disable also persists the preference');
});

test('unavailable or silently failing preference storage keeps page opt-out and reports sanitized retry guidance', OPTIONS, async (t) => {
  const h = setup(t);
  const storage = {
    getItem: (_key: string): string | null => null,
    setItem: (_key: string, _value: string): void => { throw new Error(PRIVATE); },
    removeItem: (_key: string): void => { throw new Error(PRIVATE); },
  };
  const create = storageDependencies(t, h, storage);
  const controller = create();
  controller.connect(h.api);
  await controller.refresh();
  await controller.disable();
  assert.equal(controller.state().disabled, true);
  assert.equal(controller.state().message, null);
  assert.match(controller.state().error!, /无法保存设备偏好，刷新后可能恢复通知/);
  await controller.refresh();
  assert.match(controller.state().error!, /刷新后可能恢复通知/);
  await controller.enable();
  assert.equal(controller.state().disabled, true);
  assert.match(controller.state().error!, /通知仍保持停用/);
  assert.equal(h.deps.requestPermission.mock.callCount(), 0);
  storage.setItem = () => {};
  await controller.disable();
  assert.match(controller.state().error!, /无法保存设备偏好/);
  storage.getItem = () => { throw new Error(PRIVATE); };
  const unreadable = create();
  assert.equal(unreadable.state().disabled, true);
  assert.match(unreadable.state().error!, /无法读取设备通知偏好/);
  h.browser.local = h.subscription();
  unreadable.connect(h.api);
  await unreadable.refresh();
  assert.equal(h.api.subscribePush.mock.callCount(), 0);
  assert.equal(unreadable.state().ready, false);
});

test('confirmed delivery ownership survives passive checks, reconnect and transient failures but not permission denial', OPTIONS, async (t) => {
  const h = setup(t);
  h.browser.local = h.subscription();
  h.server.records.add(ENDPOINT);
  await h.connect();
  const before = h.snapshots.length;
  const status = gate<PushStatus>();
  h.api.pushStatus.mock.mockImplementationOnce(() => status.wait());
  const refreshing = h.controller.refresh();
  await status.entered;
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().deliveryOwned, true);
  h.controller.disconnect();
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().deliveryOwned, true);
  h.api.pushStatus.mock.mockImplementation(async () => { throw new Error(PRIVATE); });
  const reconnecting = h.connect();
  assert.equal(h.controller.state().deliveryOwned, true);
  status.resolve(h.status(ENDPOINT));
  await Promise.all([refreshing, reconnecting]);
  assert.equal(h.controller.state().ready, false);
  assert.match(h.controller.state().error!, /无法确认服务端推送状态/);
  h.deps.getSubscription.mock.mockImplementation(async () => { throw new Error(PRIVATE); });
  await h.controller.refresh();
  assert.ok(h.snapshots.slice(before).every((state) => state.deliveryOwned));
  h.deps.getSubscription.mock.restore();
  h.api.pushStatus.mock.restore();
  await h.controller.refresh();
  assert.equal(h.controller.state().ready, true);

  const pending = gate<PushStatus>();
  h.api.pushStatus.mock.mockImplementationOnce(() => pending.wait());
  const checking = h.controller.refresh();
  await pending.entered;
  h.browser.permission = 'denied';
  assert.equal(h.controller.refresh(), checking);
  assert.equal(h.controller.state().deliveryOwned, false, 'revocation cannot wait for the status response');
  pending.resolve(h.status(ENDPOINT));
  await checking;
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().deliveryOwned, false);
});

test('ownership is bound to the confirmed local endpoint and key and is revoked by confirmed deregistration', OPTIONS, async (t) => {
  const h = setup(t);
  h.browser.local = h.subscription();
  h.server.records.add(ENDPOINT);
  await h.connect();
  assert.equal(h.controller.state().deliveryOwned, true);
  const pending = gate<PushStatus>();
  h.api.pushStatus.mock.mockImplementationOnce(() => pending.wait());
  h.browser.local = h.subscription(ENDPOINT, OLD_KEY);
  const checking = h.controller.refresh();
  await pending.entered;
  assert.equal(h.controller.state().deliveryOwned, false, 'a local key change invalidates before the network response');
  h.deps.subscribe.mock.mockImplementation(async () => { throw new Error(PRIVATE); });
  pending.resolve(h.status(ENDPOINT));
  await checking;
  assert.equal(h.controller.state().deliveryOwned, false);

  h.browser.local = h.subscription(NEXT_ENDPOINT);
  h.server.records.add(NEXT_ENDPOINT);
  await h.controller.refresh();
  assert.equal(h.controller.state().deliveryOwned, true);
  h.server.records.delete(NEXT_ENDPOINT);
  h.api.subscribePush.mock.mockImplementation(async () => { throw new Error(PRIVATE); });
  h.api.pushStatus.mock.mockImplementationOnce(async (endpoint) => {
    h.deps.getSubscription.mock.mockImplementationOnce(async () => { throw new Error(PRIVATE); });
    return h.status(endpoint);
  });
  await h.controller.refresh();
  assert.equal(h.controller.state().deliveryOwned, false);
  assert.equal(h.controller.state().ready, false);
  assert.match(h.controller.state().error!, /无法读取本地推送订阅/);
  h.server.records.add(NEXT_ENDPOINT);
  await h.controller.refresh();
  assert.equal(h.controller.state().deliveryOwned, true);
  h.api.pushStatus.mock.mockImplementation(async () => { throw new Error(PRIVATE); });
  h.browser.local = h.subscription();
  await h.controller.refresh();
  assert.equal(h.controller.state().deliveryOwned, false, 'a replaced endpoint cannot inherit ownership through a status failure');
});
