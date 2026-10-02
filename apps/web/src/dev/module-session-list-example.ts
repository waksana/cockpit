import type { ActivateLegacyFrontend } from '@cockpit/module-api/frontend';

/** Synthetic module data only; real modules own their service and session-keyed state. */
export const activate = ((context) => {
  if (context.sessionListItemVersion !== 1 || context.uiSurfaceVersion !== 1) {
    throw new Error('Example requires sessionListItem v1 and public surfaces');
  }
  const { createElement: h, Fragment } = context.react;
  const sessionId = typeof context.config.sessionId === 'string' ? context.config.sessionId : 'demo-roles';
  const text = typeof context.config.description === 'string' ? context.config.description : 'Synthetic module description';
  return {
    apiVersion: 2,
    components: [{
      id: 'description', boundary: 'sessionListItem',
      wrap: Base => props => h(Base, {
        ...props,
        description: props.sessionId === sessionId
          ? h(Fragment, null, props.description, h('span', { className: 'ck-badge' }, 'Example'), ' ', text)
          : props.description,
      }),
    }],
  };
}) satisfies ActivateLegacyFrontend;
