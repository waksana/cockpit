import { isUnreadAttention } from '@cockpit/protocol';
import { reportUxError } from './errorReporter';

export function pushSupported(): boolean {
  return notificationEnvironment().supported;
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    (typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}

function secureContext(): boolean {
  return typeof window !== 'undefined' &&
    window.isSecureContext === true && window.location?.protocol === 'https:';
}

export function notificationEnvironment(): { supported: boolean; installed: boolean; reason: string | null } {
  const installed = isStandalone();
  if (!secureContext()) {
    return { supported: false, installed, reason: 'Notifications require a secure HTTPS connection.' };
  }
  const ios = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
  if (ios && !installed) {
    return { supported: false, installed, reason: 'On iPhone or iPad, add this app to the Home Screen and open it there to enable notifications.' };
  }
  if (typeof navigator === 'undefined' || !navigator.serviceWorker ||
      typeof window.PushManager !== 'function' || typeof window.Notification !== 'function') {
    return { supported: false, installed, reason: 'This browser does not support push notifications.' };
  }
  return { supported: true, installed, reason: null };
}

const OPERATION_TIMEOUT_MS = 10_000;
let nativeMutationPending = false;

function requireNoNativeMutation(): void {
  if (nativeMutationPending) {
    throw new Error('A local push subscription change is still pending. Wait for it to finish, then retry.');
  }
}

// Browser errors may contain subscription endpoints or credentials. Never forward
// their message, cause, or stack; callers get only the operation's fixed diagnosis.
async function bounded<T>(operation: () => PromiseLike<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), OPERATION_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}

async function mutateSubscription<T>(operation: () => PromiseLike<T>, message: string): Promise<T> {
  requireNoNativeMutation();
  nativeMutationPending = true;
  return bounded(async () => {
    try {
      return await operation();
    } finally {
      // A timeout does not cancel the native mutation; only settlement releases it.
      nativeMutationPending = false;
    }
  }, message);
}

async function activeRegistration(reg: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    await bounded(() => new Promise<void>((resolve, reject) => {
      const check = () => {
        if (reg.active?.state === 'activated') {
          resolve();
        } else {
          const workers = [reg.active, reg.installing, reg.waiting].filter(Boolean);
          if (workers.length && workers.every((worker) => worker?.state === 'redundant')) reject();
        }
      };
      poll = setInterval(check, 50);
      check();
    }), 'The notification service worker did not activate. Reload the page and retry.');
    return reg;
  } finally {
    clearInterval(poll);
  }
}

async function serverKey(base64: string): Promise<Uint8Array> {
  let key: Uint8Array;
  try {
    if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(base64)) throw new Error();
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    key = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    if (key.length !== 65 || key[0] !== 4) throw new Error();
  } catch {
    throw new Error('The notification server public key is invalid. Check the server configuration.');
  }
  // Validate the curve point before removing a working subscription for rotation.
  await bounded(
    () => crypto.subtle.importKey('raw', key as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []),
    'The notification server public key could not be verified. Check the server configuration and retry.',
  );
  return key;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  const reg = await bounded(
    () => navigator.serviceWorker.register('/sw.js', { scope: '/' }),
    'Notification service worker registration failed or timed out. Reload the page and retry.',
  );
  return activeRegistration(reg);
}

function requirePermission(): void {
  if (window.Notification.permission !== 'granted') {
    throw new Error('Notification permission is not granted. Enable notifications using the notification settings.');
  }
}

async function unsubscribe(sub: PushSubscription): Promise<void> {
  const removed = await mutateSubscription(
    () => sub.unsubscribe(),
    'Removing the local push subscription failed or timed out. Retry before changing notification settings.',
  );
  if (removed !== true) throw new Error('The browser did not remove the local push subscription. Retry before continuing.');
}

export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  requireNoNativeMutation();
  const environment = notificationEnvironment();
  if (!environment.supported) throw new Error(environment.reason!);
  requirePermission();
  const key = await serverKey(vapidPublicKey);
  requireNoNativeMutation();
  requirePermission();
  const reg = await registerServiceWorker();
  requireNoNativeMutation();
  if (!reg) throw new Error('Push notifications are unavailable in this browser.');
  requirePermission();
  const existing = await bounded(
    () => reg.pushManager.getSubscription(),
    'Reading the local push subscription failed or timed out. Retry without removing the existing subscription.',
  );
  requireNoNativeMutation();
  requirePermission();
  if (existing) {
    const currentKey = existing.options.applicationServerKey;
    const currentBytes = currentKey ? new Uint8Array(currentKey) : null;
    const matches = currentBytes?.length === key.length &&
      key.every((byte, index) => byte === currentBytes[index]);
    if (matches) return subscriptionJson(existing);
    await unsubscribe(existing);
  }
  requirePermission();
  const sub = await mutateSubscription(
    () => reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key as BufferSource,
    }),
    'Creating the local push subscription failed or timed out. Check browser notification settings and retry.',
  );
  requireNoNativeMutation();
  requirePermission();
  return subscriptionJson(sub);
}

function subscriptionJson(sub: PushSubscription): PushSubscriptionJSON {
  try {
    return sub.toJSON();
  } catch {
    throw new Error('The browser could not read the push subscription details. Retry without removing the subscription.');
  }
}

// Look up this app's registration, never register or wait on serviceWorker.ready.
export async function getSwRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!secureContext() || typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
  const reg = await bounded(
    () => navigator.serviceWorker.getRegistration('/'),
    'Looking up the notification service worker failed or timed out. Reload the page and retry.',
  );
  return reg ? activeRegistration(reg) : null;
}

export async function getLocalPushSubscription(): Promise<PushSubscription | null> {
  requireNoNativeMutation();
  const reg = await getSwRegistration();
  requireNoNativeMutation();
  if (!reg?.pushManager) return null;
  const sub = await bounded(
    () => reg.pushManager.getSubscription(),
    'Reading the local push subscription failed or timed out. Retry without removing the existing subscription.',
  );
  requireNoNativeMutation();
  return sub;
}

export async function disableLocalPush(): Promise<void> {
  const sub = await getLocalPushSubscription();
  requireNoNativeMutation();
  if (sub) await unsubscribe(sub);
}

type NotificationSession = {
  sessionId: string;
  attention?: 'ready' | 'choice' | null;
  attnId?: number;
  seenId?: number;
};

function counter(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Only confirmed server metadata is supplied here. Absence from a partial list
// is not removal; removed sessions must be named explicitly by the caller.
// No metadata is a no-op, including legacy calls without arguments.
export async function clearOsNotifications(
  sessions: readonly NotificationSession[] = [],
  resolvedSessionIds: readonly string[] = [],
): Promise<void> {
  try {
    const targets = new Map((sessions ?? []).map((session) => [session.sessionId, session]));
    const resolved = new Set(resolvedSessionIds);
    if (!targets.size && !resolved.size) return;
    const reg = await getSwRegistration();
    if (!reg || typeof reg.getNotifications !== 'function') return;
    const notes = await bounded(
      () => reg.getNotifications(),
      'Reading OS notifications failed or timed out. Retry clearing them.',
    );
    for (const note of notes) {
      const data = note.data as { type?: unknown; kind?: unknown; sessionId?: unknown; attnId?: unknown } | null;
      if (!data || typeof data.sessionId !== 'string' || !data.sessionId ||
          (data.type !== undefined && data.type !== 'notification') ||
          (data.kind !== undefined && data.kind !== 'ready' && data.kind !== 'choice') ||
          note.tag === 'push:test') continue;
      const noteId = counter(data.attnId);
      if (noteId === null) continue;
      const session = targets.get(data.sessionId);
      let close = !session && resolved.has(data.sessionId);
      if (session) {
        const seenId = counter(session.seenId);
        const attnId = counter(session.attnId);
        if (seenId === null || attnId === null) continue;
        close = noteId <= seenId || (!isUnreadAttention(session) && noteId <= attnId);
      }
      if (close) {
        try { note.close(); } catch { reportUxError('An OS notification could not be closed. Retry clearing it.'); }
      }
    }
  } catch {
    reportUxError('OS notifications could not be cleared. Reload the page and retry.');
  }
}
