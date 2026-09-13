import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

// Explicit opt-in, loopback-only, dev-only. No proxy, native backend or store.
export function chatLabPlugin(): Plugin {
  return {
    name: 'isolated-chat-lab',
    apply: 'serve',
    config: () => ({
      define: { 'import.meta.env.COCKPIT_CHAT_LAB': 'true' },
      server: {
        host: '127.0.0.1',
        headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*; worker-src 'self' blob:; frame-src 'none'" },
      },
    }),
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0] ?? '';
        if (path === '/files') request.url = `/chat-lab.html${request.url?.slice(path.length) ?? ''}`;
        if (path === '/uploads/lab-layout.svg' || path === '/uploads/lab-slow.svg') {
          if (path === '/uploads/lab-slow.svg') await new Promise(resolve => setTimeout(resolve, 1800));
          response.setHeader('Content-Type', 'image/svg+xml');
          response.end(await readFile(new URL('./src/dev/lab-layout.svg', import.meta.url)));
        } else if (path === '/uploads/lab-notes.txt' || path === '/uploads/lab-unknown.bin') {
          response.setHeader('Content-Type', 'text/plain');
          response.end('Synthetic design-review attachment. No user content.');
        } else if (path === '/uploads/lab-video.webm') {
          const video = await readFile(new URL('./src/dev/lab-video.webm', import.meta.url));
          response.setHeader('Content-Type', 'video/webm');
          response.setHeader('Accept-Ranges', 'bytes');
          const range = request.headers.range;
          if (range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(range);
            const start = match ? Number(match[1]) : -1;
            const end = match?.[2] ? Number(match[2]) : video.length - 1;
            if (start < 0 || start >= video.length || end < start || end >= video.length) {
              response.writeHead(416, { 'Content-Range': `bytes */${video.length}` }).end();
              return;
            }
            response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${video.length}`, 'Content-Length': end - start + 1 });
            response.end(video.subarray(start, end + 1));
          } else {
            response.setHeader('Content-Length', video.length);
            response.end(video);
          }
        } else if (path.startsWith('/uploads/') || path.startsWith('/intent/') || ['/upload', '/events', '/chat/stream'].includes(path)) {
          response.writeHead(404).end('Isolated chat lab: no backend resource.');
        } else next();
      });
    },
  };
}
