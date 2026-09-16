import type { ActivateFrontend, ComposerContext } from '@cockpit/module-api';

// SquarePen paths from Lucide 1.46.0; distributed license: public/licenses/lucide.txt.
export const activate: ActivateFrontend = context => {
  if (context.uiVersion !== 1) throw new Error('Example requires Cockpit Module UI v1');
  const { createElement: h, useSyncExternalStore } = context.react;
  function AddExample({ draft, disabled, operation }: ComposerContext) {
    const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
    const blocked = disabled || state.pending || operation !== 'prompt';
    return h('button', {
      type: 'button', className: 'ck-icon-button example-draft-action',
      'aria-label': 'Append example text', title: 'Append example text', disabled: blocked,
      onClick: () => {
        if (blocked || draft.getSnapshot().pending) return;
        draft.editText(`${draft.getSnapshot().text}Example`);
      },
    }, h('svg', {
      className: 'ck-icon ck-icon-lg', viewBox: '0 0 24 24',
      'aria-hidden': true, focusable: false,
    },
    h('path', { d: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }),
    h('path', { d: 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z' })));
  }
  return { writes: ['text'], composerActions: [{ id: 'example-text', component: AddExample }] };
};
