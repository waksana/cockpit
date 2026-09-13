/// <reference lib="webworker" />
// Keep the App worker lifecycle without notification business or offline caches.
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: unknown };
void self.__WB_MANIFEST;
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
