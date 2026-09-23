import type { Plugin } from 'vite';
import { labModuleHandler, loadLabModules } from './lab-modules.ts';

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
    async configureServer(server) {
      const modules = labModuleHandler(await loadLabModules({
        file: process.env.COCKPIT_LAB_FILE_ROOT,
      }));
      server.httpServer?.once('close', () => modules.dispose());
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0] ?? '';
        if (path.startsWith('/intent/') || ['/events', '/chat/stream', '/status', '/version'].includes(path)) {
          response.writeHead(404).end('Isolated chat lab: no backend resource.');
        } else {
          void modules.handle(request, response).then(handled => { if (!handled) next(); }, error => {
            server.config.logger.error(String(error));
            if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Synthetic module failure' }));
          });
        }
      });
    },
  };
}
