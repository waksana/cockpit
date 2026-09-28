import type { ActivateFrontend } from '@cockpit/module-api/frontend';
import type { ChangeEvent } from 'react';

export const activate: ActivateFrontend = context => {
  if (context.globalComponentVersion !== 1 || context.menuVersion !== 1
    || context.uiSurfaceVersion !== 1 || typeof context.createPortal !== 'function') {
    throw new Error('Example requires global components, menus and public modal surfaces');
  }
  const { createElement: h, useLayoutEffect, useRef, useState, useSyncExternalStore } = context.react;
  const visibility = context.state.register({
    id: 'visibility',
    create: () => {
      let open = false;
      const listeners = new Set<() => void>();
      return {
        getSnapshot: () => open,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        setOpen(value: boolean) { open = value; for (const listener of listeners) listener(); },
        dispose() { listeners.clear(); },
      };
    },
    dispose: service => service.dispose(),
  }).get();

  function GlobalDialog() {
    const open = useSyncExternalStore(visibility.subscribe, visibility.getSnapshot, visibility.getSnapshot);
    const dialog = useRef<HTMLDialogElement>(null);
    const [text, setText] = useState('');
    // Run after the selection event has closed the menu and returned trigger focus.
    useLayoutEffect(() => {
      if (open) dialog.current?.showModal();
      else dialog.current?.close();
    }, [open]);
    useLayoutEffect(() => {
      const element = dialog.current;
      return () => { element?.close(); };
    }, []);
    return context.createPortal(h('dialog', {
      ref: dialog, className: 'ck-modal ck-surface example-global-dialog', 'aria-label': 'Global module example',
      onClose: () => { if (!context.signal.aborted) visibility.setOpen(false); },
    },
    h('h2', { className: 'ck-heading' }, 'Global module example'),
    h('label', null, 'Module note', h('input', {
      className: 'ck-input', value: text, onChange: (event: ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    })),
    h('form', { method: 'dialog', className: 'ck-actions' },
      h('button', { className: 'ck-button', type: 'submit' }, 'Close example'))), document.body);
  }

  return {
    apiVersion: 2,
    menus: [{
      id: 'open', menu: 'global', getState: () => ({ label: 'Global module example' }),
      onSelect: () => visibility.setOpen(true),
    }],
    globalComponents: [{ id: 'dialog', component: GlobalDialog }],
  };
};
