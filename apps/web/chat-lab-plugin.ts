import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

// Explicit opt-in, loopback-only, dev-only. No proxy, native backend or store.
export function chatLabPlugin(): Plugin {
  return {
    name: 'isolated-chat-lab',
    apply: 'serve',
    config: () => ({ server: { host: '127.0.0.1' } }),
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0] ?? '';
        if (path === '/files') request.url = `/chat-lab.html${request.url?.slice(path.length) ?? ''}`;
        if (path === '/uploads/lab-layout.svg') {
          response.setHeader('Content-Type', 'image/svg+xml');
          response.end(await readFile(new URL('./src/dev/lab-layout.svg', import.meta.url)));
        } else if (path === '/uploads/lab-notes.txt') {
          response.setHeader('Content-Type', 'text/plain');
          response.end('Synthetic design-review attachment. No user content.');
        } else if (path === '/uploads/lab-video.webm') {
          response.setHeader('Content-Type', 'video/webm');
          response.end(await readFile(new URL('./src/dev/lab-video.webm', import.meta.url)));
        } else if (path.startsWith('/uploads/') || path.startsWith('/intent/') || ['/events', '/chat/stream'].includes(path)) {
          response.writeHead(404).end('Isolated chat lab: no backend resource.');
        } else next();
      });
    },
  };
}
