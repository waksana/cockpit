import type { Plugin } from 'vite';

// Explicit opt-in, loopback-only, dev-only. No backend connection or proxy.
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
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0] ?? '';
        if (path.startsWith('/intent/') || ['/events', '/chat/stream', '/status', '/version'].includes(path)) {
          response.writeHead(404).end('Isolated chat lab: no backend resource.');
        } else next();
      });
    },
  };
}
