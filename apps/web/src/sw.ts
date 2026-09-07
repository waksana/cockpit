/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa injectManifest). Its job is Web Push:
// receive a push from the cockpit server when a session finishes a turn and show
// a notification — this is what lets the phone alert with the screen off, which
// a page-context Notification cannot do. Also handles notification clicks: focus
// an existing window or open the deep-linked session URL.
//
// The app needs a live SSE connection to be useful, so there is no offline
// app-shell caching; we just satisfy the injectManifest precache injection point
// without registering routes.

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: unknown };

// injectManifest requires this reference to exist; we intentionally don't
// precache (no offline shell).
void self.__WB_MANIFEST;

interface PushPayload { title?: string; body?: string; tag?: string; url?: string; kind?: string; sessionId?: string; badge?: number }

self.addEventListener('install', () => {
  // Activate immediately so push works on first load without a reload.
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data: PushPayload;
  try { data = event.data ? (event.data.json() as PushPayload) : {}; } catch { data = {}; }
  const title = data.title || 'cockpit';
  // A 'choice' is a blocking request for a decision — make it sticky (stays until
  // acted on) and vibrate a touch more urgently than a plain 'ready'.
  const isChoice = data.kind === 'choice';
  event.waitUntil((async () => {
    // App-icon badge (count of sessions awaiting the user). Carried on the push so
    // the count is right even with the screen off; the foreground client keeps it
    // in sync while open. Update it FIRST so the count stays correct even when we
    // skip the banner below. No-op where the Badging API is unavailable.
    const nav = self.navigator as unknown as { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (typeof data.badge === 'number' && nav.setAppBadge) {
      try {
        if (data.badge > 0) await nav.setAppBadge(data.badge);
        else await nav.clearAppBadge?.();
      } catch { /* ignore */ }
    }
    // The documented exception to "a push must show a notification": when the app
    // is open and visible on THIS device, don't pop an OS banner — the in-app red
    // dots + badge already convey it, and a banner over the app you're looking at
    // is just noise. Only alert when no window is visible (backgrounded / screen
    // off / home screen). Skipping while a client is visible is penalty-free (it
    // does NOT trigger Chrome's "site updated in background"). Mirrors the same
    // visibility gate the in-page notifier (notify.ts) already uses, so the two
    // notification paths stay complementary rather than double-firing.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === 'visible')) return;

    await self.registration.showNotification(title, {
      body: data.body || '已回复，等待你的输入',
      tag: data.tag || 'copilot',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      requireInteraction: isChoice,
      vibrate: isChoice ? [60, 40, 60, 40, 60] : [80],
      data: { url: data.url || '/', sessionId: data.sessionId },
    } as NotificationOptions);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const info = (event.notification.data || {}) as { url?: string; sessionId?: string };
  const url = info.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      try { await client.focus(); } catch { /* ignore */ }
      // Soft-route an already-open app to the session (no reload, no reconnect):
      // the page listens for this and navigates the URL to `/session/<sessionId>`.
      // Falls through to navigate() only if no client is open.
      if (info.sessionId) { try { client.postMessage({ type: 'open-session', sessionId: info.sessionId }); } catch { /* ignore */ } }
      else if ('navigate' in client) { try { await (client as WindowClient).navigate(url); } catch { /* ignore */ } }
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
