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

import { routeNotificationClick } from './lib/notificationRouting';
import { reportNotificationFailure, showPushNotification } from './lib/notificationTransport';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: unknown };

// injectManifest requires this reference to exist; we intentionally don't
// precache (no offline shell).
void self.__WB_MANIFEST;

self.addEventListener('install', (event) => {
  // Activate immediately so push works on first load without a reload.
  event.waitUntil(self.skipWaiting().catch(() => reportNotificationFailure('Worker activation failed')));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim().catch(() => reportNotificationFailure('Worker client claim failed')));
});

self.addEventListener('push', (event) => {
  let data: unknown;
  try { data = event.data?.json(); } catch { /* The transport displays a safe invalid-payload fallback. */ }
  event.waitUntil(showPushNotification(data, self.registration, self.navigator));
});

self.addEventListener('notificationclick', (event) => {
  try { event.notification.close(); } catch { reportNotificationFailure('Notification close failed'); }
  event.waitUntil(routeNotificationClick(self.clients, self.location.origin, event.notification.data)
    .catch(() => reportNotificationFailure('Notification click routing failed')));
});
