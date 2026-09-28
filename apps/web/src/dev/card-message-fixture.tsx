import type { ActivateFrontend } from '@cockpit/module-api/frontend';
import { ModuleRuntime } from '../lib/moduleRuntime';

export function createCardMessageFixture() {
  const digest = 'a'.repeat(64);
  return new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'card-message', name: 'Synthetic cards', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/card-message/${digest}/api`, entry: `/_modules/assets/card-message/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate: (context => {
      if (context.uiVersion !== 1 || context.uiSurfaceVersion !== 1) throw new Error('Public UI v1 required');
      return { apiVersion: 2, markdown: [{
        id: 'card', matches: node => node.target.startsWith('synthetic-card:'),
        component: ({ node }) => <span className="lab-inline-card">
          <span className="ck-surface">
            <strong>{node.label}</strong>
            <span>{'Synthetic long content for intrinsic sizing. '.repeat(6)}</span>
            <button type="button" className="ck-button">Card action</button>
          </span>
        </span>,
      }] };
    }) satisfies ActivateFrontend }),
  });
}
