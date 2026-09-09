// Desktop/browser notifications + a short chime, used to alert the user when
// an agent session finishes a turn (waiting for input) or needs a choice.
// Notifications fire while the tab is backgrounded as long as permission is
// granted. No-ops gracefully when the Notification API is unavailable.

import { reportUxError } from './errorReporter';
import { parseNotificationPayload, showPushNotification } from './notificationTransport';
import { getSwRegistration, notificationEnvironment } from './push';

let audioCtx: AudioContext | null = null;

export function notificationsSupported(): boolean {
  return notificationEnvironment().supported;
}

export function notificationPermission(): NotificationPermission {
  if (!notificationsSupported()) return 'denied';
  return window.Notification.permission;
}

// Call directly from a user gesture, before any asynchronous work.
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (window.Notification.permission === 'granted') return true;
  if (window.Notification.permission === 'denied') return false;
  if (navigator.userActivation?.isActive !== true) return false;
  try {
    const res = await window.Notification.requestPermission();
    return res === 'granted';
  } catch {
    reportUxError('Notification permission could not be requested. Check browser settings and retry from the notification button.');
    return false;
  }
}

async function chime(kind: 'ready' | 'choice'): Promise<void> {
  try {
    audioCtx = audioCtx || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') await ctx.resume();
    if (!notificationsSupported() || window.Notification.permission !== 'granted' ||
        document.visibilityState === 'visible') return;
    const now = ctx.currentTime;
    // Two short notes; "choice" is a touch higher/urgent.
    const notes = kind === 'choice' ? [880, 1175] : [660, 880];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    });
  } catch {
    /* audio is best-effort */
  }
}

export interface NotifyOptions {
  title: string;
  body?: string;
  kind?: 'ready' | 'choice';
  // Only notify when the tab is not visible (default true). Set false to always.
  onlyWhenHidden?: boolean;
  // Bring this tag's notification to front / dedupe.
  tag?: string;
  // The session this alert is about. When set, the notification is shown through
  // the service worker so a click routes via the SW's notificationclick handler
  // (which posts `open-session` to the page) and can be cleared on confirmed read.
  sessionId?: string;
  attnId?: number;
  inboxRevision?: number;
  onClick?: () => void;
}

export function notify(opts: NotifyOptions): void {
  const kind = opts.kind ?? 'ready';
  const onlyWhenHidden = opts.onlyWhenHidden ?? true;
  const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';

  if (onlyWhenHidden && !hidden) return;
  if (!notificationsSupported() || window.Notification.permission !== 'granted') return;

  void showNotification(opts, kind).catch(() => {
    reportUxError('The browser could not display the notification. Check notification settings and retry.');
  });
}

// Prefer the service-worker registration so the banner is SW-owned: it can be
// selectively closed via getNotifications() and shares tags/click routing with
// web push. The store owns suppression when server push is ready.
async function showNotification(opts: NotifyOptions, kind: 'ready' | 'choice'): Promise<void> {
  const data = {
    type: 'notification',
    kind,
    title: opts.title,
    body: opts.body ?? '',
    tag: opts.tag ?? opts.sessionId,
    url: opts.sessionId ? `/session/${encodeURIComponent(opts.sessionId)}` : '/',
    sessionId: opts.sessionId,
    attnId: opts.attnId,
    inboxRevision: opts.inboxRevision,
  };
  const payload = parseNotificationPayload(data);
  const options: NotificationOptions = {
    body: data.body,
    tag: data.tag,
    icon: '/icon-refined-r4-192.png',
    badge: '/badge-refined-r4-96.png',
    requireInteraction: kind === 'choice',
    data: payload ?? data,
  };
  let reg: ServiceWorkerRegistration | null = null;
  try {
    reg = await getSwRegistration();
  } catch {
    reportUxError('The notification service worker is unavailable. Trying a browser notification instead.');
  }
  if (!notificationsSupported() || window.Notification.permission !== 'granted' ||
      ((opts.onlyWhenHidden ?? true) && document.visibilityState === 'visible')) return;
  if (reg && payload) {
    const registration = reg;
    await showPushNotification(payload, {
      getNotifications: (options) => registration.getNotifications(options),
      showNotification: (title, options = {}) => displayNotification(opts, kind, title, options, registration),
    }, navigator);
    return;
  }
  await displayNotification(opts, kind, opts.title, options, reg);
}

// Run the page's visibility/permission gates and constructor fallback inside the
// shared transport's display step, so its selected content and silence survive.
async function displayNotification(
  opts: NotifyOptions, kind: 'ready' | 'choice', title: string, options: NotificationOptions,
  reg: ServiceWorkerRegistration | null,
): Promise<void> {
  if (!notificationsSupported() || window.Notification.permission !== 'granted' ||
      ((opts.onlyWhenHidden ?? true) && document.visibilityState === 'visible')) return;
  let displayed = false;
  if (reg) {
    try {
      await reg.showNotification(title, options);
      displayed = true;
    } catch {
      reportUxError('The service worker could not display the notification. Trying a browser notification instead.');
    }
  }
  if (!notificationsSupported() || window.Notification.permission !== 'granted' ||
      ((opts.onlyWhenHidden ?? true) && document.visibilityState === 'visible')) return;
  if (!displayed) {
    try {
      const n = new window.Notification(title, options);
      n.onclick = () => {
        try {
          window.focus();
          void Promise.resolve(opts.onClick?.()).catch(() => {
            reportUxError('The notification target could not be opened. Open the session from the app.');
          });
        } catch {
          reportUxError('The notification target could not be opened. Open the session from the app.');
        } finally {
          try { n.close(); } catch { reportUxError('The browser notification could not be closed.'); }
        }
      };
    } catch {
      reportUxError('The browser could not display the notification. Check notification settings and retry.');
      return;
    }
  }
  if (!options.silent && document.visibilityState !== 'visible') void chime(kind);
}
