// Web Push registration (client side). Registers the service worker, subscribes
// to the browser's push service with the bridge's VAPID public key, and hands the
// resulting PushSubscription back to the caller (which forwards it to the bridge).
//
// iOS note: this only works when the site is installed as a PWA (Add to Home
// Screen, iOS 16.4+). In a plain Safari tab `PushManager` is unavailable, so we
// detect support and no-op gracefully.

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// True when running as an installed PWA (standalone display mode). On iOS this
// is the precondition for push to be available at all.
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari legacy flag
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let registration: ServiceWorkerRegistration | null = null;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  if (registration) return registration;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    return registration;
  } catch {
    return null;
  }
}

// Subscribe to push with the given VAPID public key. Returns the subscription as
// a plain JSON object (endpoint + keys) ready to send to the bridge, or null if
// unsupported / permission denied.
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionJSON | null> {
  if (!pushSupported() || !vapidPublicKey) return null;
  const reg = await registerServiceWorker();
  if (!reg) return null;
  if (Notification.permission !== 'granted') return null;
  try {
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    });
    return sub.toJSON();
  } catch {
    return null;
  }
}

// The active service-worker registration if one already exists (does NOT force a
// registration). Used to show / enumerate / close notifications through the SW so
// they share a single surface with web push.
export async function getSwRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (registration) return registration;
  try { return (await navigator.serviceWorker.getRegistration()) ?? null; } catch { return null; }
}

// Close every OS notification this origin has shown via the service worker on THIS
// device. Called when the app becomes visible: once you're looking at the app, the
// in-app dots + badge are the source of truth, so the OS banners/tray entries are
// redundant. Runs locally (no push), so it sidesteps the `userVisibleOnly` limit
// that blocks closing a backgrounded device's banner remotely. No-op without a SW.
export async function clearOsNotifications(): Promise<void> {
  const reg = await getSwRegistration();
  if (!reg || typeof reg.getNotifications !== 'function') return;
  try {
    const notes = await reg.getNotifications();
    for (const n of notes) n.close();
  } catch { /* best-effort */ }
}
