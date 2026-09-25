import { join } from 'node:path';
import { cockpitHome, type SessionDefaultsStore } from '@cockpit/core';
import { INITIAL_SESSION_MODEL, NewSessionDefaults } from '@cockpit/protocol';
import { directory, regularBytes, writeModuleBytes } from './module-install.ts';

/** Host-owned preferences, separate from module selection and Copilot user settings. */
export class HostSessionDefaults implements SessionDefaultsStore {
  constructor(private readonly root = cockpitHome()) {}

  async read(): Promise<NewSessionDefaults> {
    try {
      await directory(this.root, false);
      const bytes = await regularBytes(join(this.root, 'config.json'), 4096);
      return NewSessionDefaults.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { modelId: INITIAL_SESSION_MODEL };
      }
      throw error;
    }
  }

  async write(value: NewSessionDefaults): Promise<void> {
    const settings = NewSessionDefaults.parse(value);
    await directory(this.root, true);
    // Reuse the host's file-sync / atomic rename / directory-sync persistence boundary.
    await writeModuleBytes(join(this.root, 'config.json'), `${JSON.stringify(settings, null, 2)}\n`);
  }
}
