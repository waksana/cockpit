import type { ModuleRuntime } from './moduleRuntime';

interface ViewStore {
  getState(): {
    activeId: string | null;
    connState: string;
    onModuleInvalidated(listener: (moduleId: string) => void): () => void;
  };
  subscribe(listener: () => void): () => void;
}

export function observeModuleView(runtime: ModuleRuntime, store: ViewStore,
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>): () => void {
  let active = true;
  const update = () => {
    if (!active) return;
    const state = store.getState();
    runtime.updateView({
      sessionId: state.activeId,
      visible: document.visibilityState === 'visible',
      connected: state.connState === 'open',
    });
  };
  const unsubscribe = store.subscribe(update);
  const invalidate = store.getState().onModuleInvalidated(id => runtime.invalidate(id));
  document.addEventListener('visibilitychange', update);
  update();
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    invalidate();
    document.removeEventListener('visibilitychange', update);
    runtime.updateView({ sessionId: null, visible: false, connected: false });
  };
}
