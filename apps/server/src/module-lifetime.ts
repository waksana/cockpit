import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { cockpitHome } from '@cockpit/core';
import { assertNoModuleMigration, directory, modulePaths } from './module-install.ts';

/**
 * The kernel releases this lease even after SIGKILL. Unlike a PID file it has no
 * stale-owner reclamation race. All users of a root must share a network namespace.
 */
export async function acquireModuleLease(hostRoot = cockpitHome()): Promise<() => Promise<void>> {
  if (process.platform !== 'linux') throw new Error('Offline module fencing currently requires Linux abstract sockets');
  const root = modulePaths(hostRoot).hostRoot;
  await directory(root, true);
  const name = `\0cockpit-module-${createHash('sha256').update(root).digest('hex')}`;
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(name, () => { server.off('error', reject); resolve(); });
  }).catch(error => {
    throw new Error('Module storage is in use by a host or migration, or its exclusive lease is unavailable', { cause: error });
  });
  server.unref();
  return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function acquireModuleHostLease(hostRoot = cockpitHome()): Promise<() => Promise<void>> {
  const release = await acquireModuleLease(hostRoot);
  try {
    await assertNoModuleMigration(hostRoot);
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

export type ModuleStartupGuard =
  | { fencing: 'linux-abstract-socket'; release: () => Promise<void> }
  | { fencing: 'unsupported-platform'; platform: NodeJS.Platform };

export async function guardModuleHostStartup(hostRoot = cockpitHome()): Promise<ModuleStartupGuard> {
  if (process.platform === 'linux') {
    return { fencing: 'linux-abstract-socket', release: await acquireModuleHostLease(hostRoot) };
  }
  await assertNoModuleMigration(hostRoot);
  return { fencing: 'unsupported-platform', platform: process.platform };
}
