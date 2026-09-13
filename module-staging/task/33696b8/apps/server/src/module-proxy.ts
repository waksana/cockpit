import { request } from 'node:http';
import type { FastifyInstance } from 'fastify';

export function registerModuleProxy(app: FastifyInstance,
  target: () => { origin: string; publicOrigin: string; token: string }) {
  app.route({
    method: ['GET', 'HEAD', 'POST'], url: '/modules/task/*',
    async handler(req, reply) {
      const raw = req.raw.url!;
      const path = raw.split('?')[0]!.slice('/modules/task'.length);
      const allowed = (['GET', 'HEAD'].includes(req.method) && ['/', '/app.js', '/style.css', '/api/events'].includes(path))
        || (req.method === 'POST' && path === '/api/read');
      if (!allowed) return reply.code(404).send({ error: 'Module route is not publicly exposed' });
      let destination: ReturnType<typeof target>;
      try { destination = target(); }
      catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : 'Module gateway unavailable' }); }
      if (req.headers.origin && req.headers.origin !== destination.publicOrigin) {
        return reply.code(403).send({ error: 'Module gateway origin mismatch' });
      }
      const body = req.method === 'POST' ? JSON.stringify(req.body) : undefined;
      if (body && Buffer.byteLength(body) > 64 * 1024) return reply.code(413).send({ error: 'Module read request exceeds limit' });
      const upstream = request(new URL(raw.slice('/modules/task'.length), destination.origin), {
        method: req.method, headers: {
          host: new URL(destination.publicOrigin).host, authorization: `Bearer ${destination.token}`,
          ...(req.headers.origin ? { origin: req.headers.origin } : {}),
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        },
      });
      req.raw.once('aborted', () => upstream.destroy());
      reply.raw.once('close', () => upstream.destroy());
      const response = await new Promise<import('node:http').IncomingMessage>((done, reject) => {
        upstream.once('response', done);
        upstream.once('error', reject);
        upstream.end(body);
      });
      reply.code(response.statusCode ?? 502);
      for (const header of ['content-type', 'cache-control', 'etag', 'last-modified', 'x-content-type-options',
        'content-security-policy', 'referrer-policy', 'x-accel-buffering']) {
        if (response.headers[header]) reply.header(header, response.headers[header]);
      }
      return reply.send(response);
    },
  });
  app.get('/modules/task', (_req, reply) => reply.redirect('/modules/task/'));
}
