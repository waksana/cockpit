import { INITIAL_SESSION_MODEL, type NewSessionDefaults } from '@cockpit/protocol';
import type { SessionDefaultsStore } from '../src/session-defaults.ts';

export function memorySessionDefaults(modelId = INITIAL_SESSION_MODEL): SessionDefaultsStore {
  let saved: NewSessionDefaults = { modelId };
  return {
    read: async () => ({ ...saved }),
    write: async value => { saved = { ...value }; },
  };
}

export const fixtureModelCatalog = () => [{
  id: 'gpt-4.1', name: 'Fixture GPT-4.1',
  capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 128000 } },
}];
