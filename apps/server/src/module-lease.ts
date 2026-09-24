import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

export type ModuleLeaseKind = 'host' | 'writer';

/**
 * Root-specific Linux abstract Unix socket lease. The kernel releases it when the
 * owning process exits, even after SIGKILL, so there is no stale lock to remove or
 * stale-owner reclamation race. All users of a root must share a network namespace.
 * `root` must already be the resolved, verified host root.
 */
export async function acquireAbstractLease(root: string, kind: ModuleLeaseKind, busy: string): Promise<() => Promise<void>> {
  if (process.platform !== 'linux') throw new Error('Module storage fencing currently requires Linux abstract sockets');
  const digest = createHash('sha256').update(root).digest('hex');
  // The host lease keeps its original name so older hosts and migrations still exclude it.
  const name = kind === 'host' ? `\0cockpit-module-${digest}` : `\0cockpit-module-writer-${digest}`;
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(name, () => { server.off('error', reject); resolve(); });
  }).catch(error => { throw new Error(busy, { cause: error }); });
  server.unref();
  let released: Promise<void> | undefined;
  return () => released ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
