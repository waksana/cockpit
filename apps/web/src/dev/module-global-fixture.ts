import { ModuleRuntime } from '../lib/moduleRuntime';
import { activate } from './module-global-example';

export function createGlobalModuleFixture() {
  const digest = 'c'.repeat(64);
  return new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'global-example', name: 'Global example', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/global-example/${digest}/api`,
      entry: `/_modules/assets/global-example/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate }),
  });
}
