// Desktop/browser notifications + a short chime, used to alert the user when
// an agent session finishes a turn (waiting for input) or needs a choice.
// Notifications fire while the tab is backgrounded as long as permission is
// granted. No-ops gracefully when the Notification API is unavailable.

import { getSwRegistration } from './push';

let audioCtx: AudioContext | null = null;

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission {
  if (!notificationsSupported()) return 'denied';
  return Notification.permission;
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const res = await Notification.requestPermission();
    return res === 'granted';
  } catch {
    return false;
  }
}

function chime(kind: 'ready' | 'choice') {
  try {
    audioCtx = audioCtx || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
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
  // (which posts `open-session` to the page) and so it can be cleared on app open.
  sessionId?: string;
  onClick?: () => void;
}

export function notify(opts: NotifyOptions): void {
  const kind = opts.kind ?? 'ready';
  const onlyWhenHidden = opts.onlyWhenHidden ?? true;
  const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';

  if (onlyWhenHidden && !hidden) return;

  // Always chime (audio is a nice in-tab cue too, but keep it to hidden case
  // to avoid annoyance when the user is actively watching).
  if (hidden) chime(kind);

  if (!notificationsSupported() || Notification.permission !== 'granted') return;

  void showNotification(opts, kind);
}

// Prefer the service-worker registration so the banner is SW-owned: it can be
// enumerated and closed via getNotifications() (so "clear on app open" wipes it),
// it shares one tag-space with web push (no duplicate banner when both a hidden
// page and the server fire for the same session), and its click is handled by the
// SW notificationclick handler (focus window + postMessage `open-session`). Fall
// back to a page-context Notification only when no SW is available.
async function showNotification(opts: NotifyOptions, kind: 'ready' | 'choice'): Promise<void> {
  const reg = await getSwRegistration();
  if (reg) {
    try {
      await reg.showNotification(opts.title, {
        body: opts.body,
        tag: opts.tag,
        icon: '/icon.svg',
        badge: '/icon.svg',
        requireInteraction: kind === 'choice',
        data: { url: opts.sessionId ? `/session/${opts.sessionId}` : '/', sessionId: opts.sessionId },
      } as NotificationOptions);
      return;
    } catch { /* fall through to a page Notification */ }
  }
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: '/icon.svg',
      badge: '/icon.svg',
      requireInteraction: kind === 'choice',
    });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* ignore */
  }
}
