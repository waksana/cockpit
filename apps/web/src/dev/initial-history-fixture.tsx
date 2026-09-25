import { useEffect, useState } from 'react';
import type { ActivateFrontend, ComponentMiddleware, MessageProps } from '@cockpit/module-api/frontend';
import { ModuleRuntime } from '../lib/moduleRuntime';

const decorate: ComponentMiddleware<MessageProps> = Base => function AsyncCard(props) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 1800);
    return () => window.clearTimeout(timer);
  }, []);
  const card = props.identity.kind === 'message' && props.identity.id === 'followup';
  return <Base {...props} adornment={<>{props.adornment}{card && <section className="ck-surface lab-async-card" data-ready={ready}>
    <h3 className="ck-heading">{ready ? 'Synthetic module ready' : 'Synthetic module loading'}</h3>
    {ready && Array.from({ length: 6 }, (_, i) => <p key={i}>Synthetic asynchronous detail {i + 1}; no task data or network access.</p>)}
  </section>}</>} />;
};

export function createAsyncCardFixture() {
  const digest = 'a'.repeat(64);
  return new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'async-card', name: 'Synthetic async card', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/async-card/${digest}/api`, entry: `/_modules/assets/async-card/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate: (context => {
      if (context.uiVersion !== 1 || context.uiSurfaceVersion !== 1) {
        throw new Error('Synthetic card requires UI v1 and shared surfaces v1');
      }
      return { apiVersion: 2, components: [{ id: 'card', boundary: 'message', wrap: decorate }] };
    }) satisfies ActivateFrontend }),
  });
}
