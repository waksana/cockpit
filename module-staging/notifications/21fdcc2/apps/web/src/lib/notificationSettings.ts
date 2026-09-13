import type { PushDelivery, PushStatus } from '@cockpit/protocol';
import { ensureNotificationPermission } from './notify';
import {
  disableLocalPush, getLocalPushSubscription, notificationEnvironment, subscribeToPush,
} from './push';

export interface Api {
  pushStatus(endpoint?: string): Promise<PushStatus>;
  subscribePush(subscription: PushSubscriptionJSON): Promise<{ ok: boolean }>;
  unsubscribePush(endpoint: string): Promise<{ ok: boolean }>;
  testPush(endpoint: string): Promise<PushDelivery>;
}

export interface NotificationSettingsState {
  supported: boolean;
  installed: boolean;
  reason: string | null;
  permission: NotificationPermission;
  ready: boolean;
  disabled: boolean;
  deliveryOwned: boolean;
  busy: boolean;
  configured: boolean | null;
  registered: boolean | null;
  lastDelivery?: PushDelivery;
  error: string | null;
  message: string | null;
}

export interface NotificationSettingsDependencies {
  environment: typeof notificationEnvironment;
  permission: () => NotificationPermission;
  requestPermission: typeof ensureNotificationPermission;
  getSubscription: typeof getLocalPushSubscription;
  subscribe: typeof subscribeToPush;
  disable: typeof disableLocalPush;
  loadDisabled: () => boolean;
  saveDisabled: (disabled: boolean) => void;
  listenForeground: (refresh: () => void) => () => void;
}

const messages = {
  offline: '连接尚未就绪，请连接后重试。',
  local: '无法读取本地推送订阅，请稍后重试。',
  status: '无法确认服务端推送状态，现有本地订阅未被移除，请稍后重试。',
  configuration: '后端推送配置不可用，请联系管理员检查配置后重试。',
  permission: '尚未获得通知权限，请在浏览器设置中允许通知后重试。',
  subscribe: '无法创建或更新本地推送订阅，请重试启用通知。',
  registration: '服务端未确认订阅注册，请重试启用或刷新状态。',
  changed: '本地推送订阅已变化，请刷新状态后重试。',
  cleanup: '旧订阅的服务端清理失败，请刷新或重试停用通知。',
  backendDisable: '服务端未确认停用，本地订阅已保留，请重试停用通知。',
  localDisable: '服务端订阅已移除，但本地停用失败，请重试停用通知。',
  disabled: '已停用当前设备的推送通知。',
  enabled: '当前设备的推送订阅已就绪。',
  testUnavailable: '请先确认当前设备的推送订阅已就绪，再发送测试通知。',
  testFailed: '推送测试失败，请稍后重试。',
  testExpired: '推送订阅已过期，请重新启用通知。',
  accepted: '推送服务已接受，仍需确认设备收到',
  unknown: '通知设置操作失败，请稍后重试。',
  preferenceRead: '无法读取设备通知偏好，当前页面已暂停通知。请允许浏览器存储后重试启用或停用。',
  preferenceDisable: '当前页面已停用通知，但无法保存设备偏好，刷新后可能恢复通知。请允许浏览器存储后重试停用。',
  preferenceEnable: '无法保存设备通知偏好，通知仍保持停用。请允许浏览器存储后重试启用。',
} as const;

class SettingsFailure extends Error {}
const stale = Symbol('stale notification operation');
const DISABLED_KEY = 'cockpit.notifications.disabled';

function loadDisabled(): boolean {
  return typeof window !== 'undefined' && window.localStorage?.getItem(DISABLED_KEY) === '1';
}

function saveDisabled(disabled: boolean): void {
  if (disabled) window.localStorage.setItem(DISABLED_KEY, '1');
  else window.localStorage.removeItem(DISABLED_KEY);
}

function browserPermission(): NotificationPermission {
  if (typeof window === 'undefined' || !window.Notification) return 'default';
  return window.Notification.permission;
}

function listenForeground(refresh: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  const visible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('focus', visible);
  return () => {
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('focus', visible);
  };
}

function safeDelivery(delivery?: PushDelivery): PushDelivery | undefined {
  if (!delivery || !['accepted', 'failed', 'expired'].includes(delivery.status)
    || !Number.isFinite(delivery.at) || delivery.at < 0) return undefined;
  return {
    status: delivery.status,
    at: delivery.at,
    ...(delivery.error !== undefined ? { error: messages.testFailed } : {}),
  };
}

function keyBytes(key: string | null): Uint8Array | null {
  if (!key || !/^[A-Za-z0-9_+/-]+={0,2}$/.test(key)) return null;
  try {
    const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    return bytes.length === 65 && bytes[0] === 4 ? bytes : null;
  } catch {
    return null;
  }
}

function keyMatches(local: PushSubscription, key: string | null): boolean {
  const expected = keyBytes(key);
  const actual = local.options.applicationServerKey;
  if (!expected || !actual) return false;
  const bytes = new Uint8Array(actual);
  return bytes.length === expected.length && expected.every((byte, index) => byte === bytes[index]);
}

export function createNotificationSettings(
  onChange: (state: NotificationSettingsState) => void,
  overrides: Partial<NotificationSettingsDependencies> = {},
) {
  const deps: NotificationSettingsDependencies = {
    environment: notificationEnvironment,
    permission: browserPermission,
    requestPermission: ensureNotificationPermission,
    getSubscription: getLocalPushSubscription,
    subscribe: subscribeToPush,
    disable: disableLocalPush,
    loadDisabled,
    saveDisabled,
    listenForeground,
    ...overrides,
  };

  function environment() {
    const { supported, installed, reason } = deps.environment();
    let help: string | null = null;
    if (!supported) {
      help = reason === 'Notifications require a secure HTTPS connection.'
        ? '推送通知需要安全的 HTTPS 连接。'
        : reason === 'On iPhone or iPad, add this app to the Home Screen and open it there to enable notifications.'
          ? '请将此应用添加到 iPhone / iPad 主屏幕，并从主屏幕打开后启用通知。'
          : '当前浏览器不支持推送通知。';
    }
    return { supported, installed, reason: help, permission: deps.permission() };
  }

  let disabled: boolean;
  let preferenceError: string | null = null;
  try {
    disabled = deps.loadDisabled();
  } catch {
    disabled = true;
    preferenceError = messages.preferenceRead;
  }
  // Transport ownership is not inbox truth, and endpoint/key details stay private.
  let deliveryOwner: { endpoint: string; key: string } | null = null;
  let value: NotificationSettingsState = {
    ...environment(), ready: false, disabled, deliveryOwned: false, busy: false, configured: null,
    registered: null, error: preferenceError, message: null,
  };
  let net: Api | null = null;
  let identity = 0;
  let cancelWait = () => {};
  let removeForeground: (() => void) | undefined;
  let tail = Promise.resolve();
  let active = tail;
  // A rotation can remove the browser subscription before backend cleanup fails.
  // These endpoints remain private and survive reconnects for idempotent retries.
  const pendingCleanup = new Set<string>();
  type Operation = { id: number; api: Api; cancelled: Promise<void> };

  const state = (): NotificationSettingsState => ({
    ...value,
    ...(value.lastDelivery ? { lastDelivery: { ...value.lastDelivery } } : {}),
  });
  function publish(patch: Partial<NotificationSettingsState>) {
    value = { ...value, ...patch };
    if (!value.supported || value.permission !== 'granted'
      || value.configured === false || value.registered === false) deliveryOwner = null;
    value.deliveryOwned = deliveryOwner !== null;
    value.ready = value.ready && value.supported && value.permission === 'granted'
      && !value.disabled && value.deliveryOwned && value.configured === true && value.registered === true;
    if (preferenceError) {
      value.error = preferenceError;
      value.message = null;
    }
    onChange(state());
  }
  function setDisabled(next: boolean): boolean {
    try {
      deps.saveDisabled(next);
      if (deps.loadDisabled() !== next) throw new Error();
      preferenceError = null;
    } catch {
      preferenceError = next ? messages.preferenceDisable : messages.preferenceEnable;
      publish({ disabled: true, ready: false });
      return false;
    }
    publish({ disabled: next, ready: false, error: null, message: null });
    return true;
  }
  function supersede() {
    cancelWait();
    cancelWait = () => {};
    return ++identity;
  }
  function current(op: Operation) {
    return identity === op.id && net === op.api;
  }
  function check(op: Operation) {
    if (!current(op)) throw stale;
  }
  function update(op: Operation, patch: Partial<NotificationSettingsState>) {
    check(op);
    publish(patch);
  }
  async function step<T>(op: Operation, work: () => Promise<T>, error: string): Promise<T> {
    check(op);
    try {
      const result = await work();
      check(op);
      return result;
    } catch (cause) {
      check(op);
      if (cause === stale) throw stale;
      throw new SettingsFailure(error);
    }
  }

  function run(work: (op: Operation) => Promise<void>): Promise<void> {
    const id = supersede();
    publish({ ...environment(), ready: false, busy: !!net, error: null, message: null });
    if (!net) {
      publish({ configured: null, registered: null, lastDelivery: undefined, error: messages.offline });
      return Promise.resolve();
    }
    const op = { id, api: net, cancelled: new Promise<void>((resolve) => { cancelWait = resolve; }) };
    // Serialize browser mutations even across disconnects. A superseded operation
    // may finish its in-flight call, but cannot issue the next call or publish.
    active = tail.then(async () => {
      if (!current(op)) return;
      try {
        await work(op);
      } catch (error) {
        if (current(op)) publish({ error: error instanceof SettingsFailure ? error.message : messages.unknown });
      } finally {
        if (current(op)) {
          const env = environment();
          const permissionLost = value.ready && (!env.supported || env.permission !== 'granted');
          publish({
            ...env, busy: false,
            ...(permissionLost ? { message: null, error: env.reason ?? messages.permission } : {}),
          });
        }
      }
    });
    tail = active;
    return active;
  }

  async function localSubscription(op: Operation) {
    const local = await step(op, deps.getSubscription, messages.local);
    if (deliveryOwner && (!local || local.endpoint !== deliveryOwner.endpoint || !keyMatches(local, deliveryOwner.key))) {
      deliveryOwner = null;
      update(op, { ready: false, registered: null, lastDelivery: undefined });
    }
    return local;
  }

  async function snapshot(op: Operation) {
    update(op, { ready: false, configured: null, registered: null, lastDelivery: undefined });
    // One retry handles an endpoint changed outside this controller, without a
    // refresh loop that can livelock when foreground events arrive repeatedly.
    for (let attempt = 0; attempt < 2; attempt++) {
      const local = await localSubscription(op);
      const status = await step(op, () => op.api.pushStatus(local?.endpoint), messages.status);
      if (deliveryOwner && deliveryOwner.endpoint === local?.endpoint
        && (status.registered === false || status.configured === false
          || status.error !== undefined || !keyMatches(local, status.publicKey))) {
        deliveryOwner = null;
        update(op, { ready: false });
      }
      const latest = await localSubscription(op);
      if (local?.endpoint !== latest?.endpoint) continue;
      const env = environment();
      const ready = !value.disabled && env.supported && env.permission === 'granted'
        && status.configured === true && status.registered === true
        && status.error === undefined && status.lastDelivery?.status !== 'expired'
        && !!latest && keyMatches(latest, status.publicKey);
      if (status.error !== undefined || status.lastDelivery?.status === 'expired'
        || !latest || !keyMatches(latest, status.publicKey)) deliveryOwner = null;
      if (ready && latest) deliveryOwner = { endpoint: latest.endpoint, key: status.publicKey! };
      update(op, {
        ...env, ready, configured: status.configured === true,
        registered: latest ? (typeof status.registered === 'boolean' ? status.registered : null) : false,
        lastDelivery: latest ? safeDelivery(status.lastDelivery) : undefined,
      });
      if (status.error !== undefined) throw new SettingsFailure(messages.configuration);
      return { local: latest, status };
    }
    throw new SettingsFailure(messages.changed);
  }

  async function verifyLocal(op: Operation, endpoint: string, key: string | null) {
    try {
      const latest = await localSubscription(op);
      if (!latest || latest.endpoint !== endpoint || !keyMatches(latest, key)) {
        deliveryOwner = null;
        throw new SettingsFailure(messages.changed);
      }
    } catch (error) {
      update(op, { ready: false, registered: null, lastDelivery: undefined });
      throw error;
    }
  }

  async function unsubscribeServer(op: Operation, endpoint: string, error: string) {
    return step(op, async () => {
      const ack = await op.api.unsubscribePush(endpoint);
      // A completed mutation still removes ownership if its caller disconnected.
      if (ack.ok === true && deliveryOwner?.endpoint === endpoint) {
        deliveryOwner = null;
        publish({ ready: false });
      }
      return ack;
    }, error);
  }

  async function cleanup(op: Operation, observed: Awaited<ReturnType<typeof snapshot>>) {
    try {
      const local = await localSubscription(op);
      for (const endpoint of pendingCleanup) {
        if (endpoint === local?.endpoint) continue;
        const ack = await unsubscribeServer(op, endpoint, messages.cleanup);
        if (ack.ok !== true) throw new SettingsFailure(messages.cleanup);
        pendingCleanup.delete(endpoint);
      }
    } finally {
      if (current(op) && value.ready && observed.local) {
        await verifyLocal(op, observed.local.endpoint, observed.status.publicKey);
      }
    }
  }

  async function reconcile(op: Operation, allowCreate: boolean) {
    const observed = await snapshot(op);
    const { local, status } = observed;
    if (!value.supported || value.permission !== 'granted' || !status.configured) return observed;
    if (!local && !allowCreate) return observed;
    if (!keyBytes(status.publicKey)) throw new SettingsFailure(messages.configuration);
    if (value.ready || (value.disabled && !allowCreate)) return observed;
    const expired = !!local && status.lastDelivery?.status === 'expired';
    if (expired) {
      deliveryOwner = null;
      update(op, { ready: false, registered: false });
      if (!allowCreate) throw new SettingsFailure(messages.testExpired);
      pendingCleanup.add(local.endpoint);
      await step(op, deps.disable, messages.localDisable);
    }

    let subscription: PushSubscriptionJSON;
    if (local && !expired && keyMatches(local, status.publicKey)) {
      subscription = local.toJSON();
    } else {
      if (local) pendingCleanup.add(local.endpoint);
      subscription = await step(op, () => deps.subscribe(status.publicKey!), messages.subscribe);
    }
    const latest = await localSubscription(op);
    if (!latest || !subscription.endpoint || latest.endpoint !== subscription.endpoint
      || !keyMatches(latest, status.publicKey)) throw new SettingsFailure(messages.changed);
    update(op, { ready: false, registered: null, lastDelivery: undefined });
    const ack = await step(op, () => op.api.subscribePush(subscription), messages.registration);
    if (ack.ok !== true) throw new SettingsFailure(messages.registration);
    const verified = await snapshot(op);
    if (verified.local?.endpoint !== subscription.endpoint) {
      update(op, { ready: false });
      throw new SettingsFailure(messages.changed);
    }
    if (!value.ready) throw new SettingsFailure(messages.registration);
    return verified;
  }

  function refresh(): Promise<void> {
    // Permission revocation invalidates ownership even while another check is pending.
    publish(environment());
    // Do not invalidate an explicit action or queue a refresh per focus event.
    if (net && value.busy) return active;
    return run(async (op) => {
      const observed = await reconcile(op, false);
      await cleanup(op, observed);
    });
  }

  function connect(api: Api): void {
    removeForeground?.();
    supersede();
    net = api;
    publish({
      ...environment(), ready: false, busy: false, configured: null,
      registered: null, lastDelivery: undefined, error: null, message: null,
    });
    removeForeground = deps.listenForeground(() => { void refresh(); });
    void refresh();
  }

  function disconnect(): void {
    supersede();
    net = null;
    removeForeground?.();
    removeForeground = undefined;
    publish({
      ...environment(), ready: false, busy: false, configured: null,
      registered: null, lastDelivery: undefined, error: null, message: null,
    });
  }

  function enable(): Promise<void> {
    if ((value.disabled || preferenceError) && !setDisabled(false)) {
      supersede();
      publish({ busy: false });
      return Promise.resolve();
    }
    // Permission must be requested in the original click stack, not in the
    // serialized job or after even a single awaited status/browser lookup.
    let permission: Promise<boolean>;
    try {
      permission = net && deps.environment().supported
        ? Promise.resolve(deps.requestPermission()).catch(() => false)
        : Promise.resolve(false);
    } catch {
      permission = Promise.resolve(false);
    }
    return run(async (op) => {
      // Native permission prompts can remain unanswered indefinitely. They must
      // not block a subsequent disable or a different connection's work.
      const granted = await step(op, () => Promise.race([
        permission, op.cancelled.then(() => false),
      ]), messages.permission);
      update(op, environment());
      if (!value.supported) throw new SettingsFailure(value.reason!);
      if (!granted || value.permission !== 'granted') throw new SettingsFailure(messages.permission);
      const observed = await reconcile(op, true);
      if (!value.ready) throw new SettingsFailure(messages.configuration);
      await cleanup(op, observed);
      update(op, { message: messages.enabled });
    });
  }

  function disable(): Promise<void> {
    // Prevent a passive refresh from undoing a partially successful disable.
    setDisabled(true);
    return run(async (op) => {
      const local = await localSubscription(op);
      const endpoints = new Set(local ? [local.endpoint, ...pendingCleanup] : pendingCleanup);
      for (const endpoint of endpoints) {
        if (endpoint === local?.endpoint) update(op, { registered: null });
        const ack = await unsubscribeServer(op, endpoint,
          endpoint === local?.endpoint ? messages.backendDisable : messages.cleanup);
        if (ack.ok !== true) {
          throw new SettingsFailure(endpoint === local?.endpoint ? messages.backendDisable : messages.cleanup);
        }
        pendingCleanup.delete(endpoint);
        if (endpoint === local?.endpoint) update(op, { registered: false });
      }
      const latest = await localSubscription(op);
      if (latest?.endpoint !== local?.endpoint) throw new SettingsFailure(messages.changed);
      await step(op, deps.disable, messages.localDisable);
      if (await localSubscription(op)) throw new SettingsFailure(messages.localDisable);
      update(op, { ready: false, registered: false, lastDelivery: undefined, message: messages.disabled });
    });
  }

  function sendTest(confirm: true): Promise<void> {
    if (confirm !== true) return Promise.resolve();
    if (!net || value.busy || !value.ready || value.registered !== true) {
      if (!value.busy) publish({ error: messages.testUnavailable, message: null });
      return Promise.resolve();
    }
    return run(async (op) => {
      const { local, status } = await snapshot(op);
      if (!value.ready || !local) throw new SettingsFailure(messages.testUnavailable);
      const result = await step(op, () => op.api.testPush(local.endpoint), messages.testFailed);
      const lastDelivery = safeDelivery(result);
      if (!lastDelivery) throw new SettingsFailure(messages.testFailed);
      if (result.status === 'expired') update(op, { ready: false, registered: false });
      await verifyLocal(op, local.endpoint, status.publicKey);
      update(op, {
        lastDelivery,
        message: result.status === 'accepted' ? messages.accepted : null,
        error: result.status === 'failed' ? messages.testFailed
          : result.status === 'expired' ? messages.testExpired : null,
        ...(result.status === 'expired' ? { ready: false, registered: false } : {}),
      });
    });
  }

  return { state, connect, disconnect, refresh, enable, disable, sendTest };
}
