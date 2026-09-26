import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import { ModuleHost } from '../module-host.ts';
import { acquireModuleHostLease } from '../module-lifetime.ts';
import { GracefulShutdown } from '../shutdown.ts';

// A separately spawned synthetic host uses the real module loader and graceful-exit owner.
export async function startFixture(root: string) {
  const home = process.env.COCKPIT_HOME!;
  const release = await acquireModuleHostLease(home);
  const app = Fastify();
  const identity = {
    ...JSON.parse(readFileSync(join(root, 'runtime-manifest.json'), 'utf8')),
    instanceId: randomUUID(),
  };
  const modules = new ModuleHost({
    hostRoot: home, origin: `http://127.0.0.1:${process.env.COCKPIT_PORT}`,
    observer: { onNativeEvent: () => () => {} },
  });
  await modules.register(app);
  const shutdown = new GracefulShutdown({
    busyCount: async () => existsSync(join(home, 'fixture-busy')) ? 1 : 0,
    stopNative: async () => {}, closeTransport: async () => { await app.close(); await release(); },
    exit: code => process.exit(code), report: error => { throw error; }, delayMs: 5,
  });
  app.get('/version', async () => ({ instanceId: identity.instanceId, version: identity.version, sourceSha: identity.sourceSha }));
  app.get('/health', async () => ({ ok: true, instanceId: identity.instanceId }));
  app.get('/status', async () => ({ shutdown: shutdown.snapshot() }));
  app.get('/', async (_req, reply) => reply.type('text/html').send(readFileSync(join(root, 'apps/web/dist/index.html'))));
  app.get('/assets/app.js', async (_req, reply) => reply.type('text/javascript').send(readFileSync(join(root, 'apps/web/dist/assets/app.js'))));
  const timer = setInterval(() => shutdown.notify(), 20);
  timer.unref();
  process.on('SIGTERM', () => shutdown.request());
  await app.listen({ host: '127.0.0.1', port: Number(process.env.COCKPIT_PORT) });
  process.send?.({ ready: true, pid: process.pid, instanceId: identity.instanceId });
}
