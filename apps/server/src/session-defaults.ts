import { join, resolve } from 'node:path';
import { z } from 'zod';
import { cockpitHome, type SessionDefaultsStore } from '@cockpit/core';
import { INITIAL_SESSION_MODEL, NewSessionDefaults } from '@cockpit/protocol';
import { directory, regularBytes, writeModuleBytes } from './module-install.ts';
import { acquireAbstractLease } from './module-lease.ts';

const configLimit = 1024 * 1024;
const hostConfigSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  values: z.object({ sessionDefaults: NewSessionDefaults.optional() }).catchall(z.unknown()),
}).strict();
type HostConfig = z.infer<typeof hostConfigSchema>;

/** Host-owned preferences, separate from module selection and Copilot user settings. */
export class HostSessionDefaults implements SessionDefaultsStore {
  constructor(private readonly root = cockpitHome()) {}

  async read(): Promise<NewSessionDefaults> {
    const config = await this.readConfig();
    return config.values.sessionDefaults ?? { modelId: INITIAL_SESSION_MODEL };
  }

  private async readConfig(): Promise<HostConfig> {
    try {
      await directory(this.root, false);
      const bytes = await regularBytes(join(this.root, 'config.json'), configLimit);
      const raw: unknown = JSON.parse(bytes.toString('utf8'));
      // The first default-model release wrote a flat preference at this path.
      const flat = NewSessionDefaults.safeParse(raw);
      return flat.success ? { schemaVersion: 1, revision: 0, values: { sessionDefaults: flat.data } }
        : hostConfigSchema.parse(raw);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { schemaVersion: 1, revision: 0, values: {} };
      }
      throw error;
    }
  }

  async write(value: NewSessionDefaults): Promise<void> {
    const settings = NewSessionDefaults.parse(value);
    await directory(this.root, true);
    const release = await acquireAbstractLease(resolve(this.root), 'writer',
      'Cockpit configuration is being changed by another storage writer; inspect it after that operation finishes');
    try {
      const current = await this.readConfig();
      const next = hostConfigSchema.parse({
        ...current, revision: current.revision + 1, values: { ...current.values, sessionDefaults: settings },
      });
      const bytes = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(bytes) > configLimit) throw new Error('Cockpit configuration exceeds its size limit');
      await writeModuleBytes(join(this.root, 'config.json'), bytes);
    } finally { await release(); }
  }
}
