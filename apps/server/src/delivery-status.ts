import { lstat, readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { DeliveryStatus } from '@cockpit/protocol';

export async function readDeliveryStatus(credentialPath: string, signal?: AbortSignal): Promise<DeliveryStatus> {
  const stat = await lstat(credentialPath);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Delivery viewer credential must be a private regular file');
  const credential: unknown = JSON.parse(await readFile(credentialPath, 'utf8'));
  if (!credential || typeof credential !== 'object' || !('url' in credential) || !('token' in credential)
    || typeof credential.url !== 'string' || typeof credential.token !== 'string') throw new Error('Invalid delivery viewer configuration');
  const url = new URL(credential.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') {
    throw new Error('Delivery viewer must use a loopback authority');
  }
  const response = await fetch(new URL('/status', url), {
    headers: { authorization: `Bearer ${credential.token}`, 'cache-control': 'no-store' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Delivery authority HTTP ${response.status}`);
  return DeliveryStatus.parse(await response.json());
}

export function registerDeliveryStatus(app: FastifyInstance): void {
  app.get('/system/versions', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const path = process.env.COCKPIT_DELIVERY_VIEWER_CREDENTIAL;
    if (!path) return reply.code(503).send({ error: '交付状态未接入；不能推断运行版本或更新状态' });
    try { return await readDeliveryStatus(path); }
    catch (error) {
      app.log.warn({ errorType: error instanceof Error ? error.name : 'InvalidDeliveryResponse' }, 'Delivery status unavailable');
      return reply.code(502).send({ error: '交付状态暂不可用；未读取仓库 HEAD 或缓存来代替实际版本' });
    }
  });
}
