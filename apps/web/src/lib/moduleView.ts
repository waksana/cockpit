import type { ModuleRuntime } from './moduleRuntime';
import type { ModuleEventPayload } from '@cockpit/module-api/frontend';
import { EMPTY_CHAT_WINDOW, ModuleChatWindow, type WindowSource } from './moduleChatWindow';

interface ViewStore {
  getState(): {
    activeId: string | null;
    connState: string;
    sessions: readonly WindowSource[];
    onModuleInvalidated(listener: (moduleId: string) => void): () => void;
    onModuleEvent(listener: (moduleId: string, payload: ModuleEventPayload) => void): () => void;
  };
  subscribe(listener: () => void): () => void;
}

export function observeModuleView(runtime: ModuleRuntime, store: ViewStore,
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>): () => void {
  let active = true;
  const chatWindow = new ModuleChatWindow();
  const update = () => {
    if (!active) return;
    const state = store.getState();
    if (chatWindow.update(state.activeId, state.sessions.find(session => session.sessionId === state.activeId), state.connState === 'open')) {
      runtime.updateChatWindow(chatWindow.getSnapshot);
    }
    runtime.updateView({
      sessionId: state.activeId,
      visible: document.visibilityState === 'visible',
      connected: state.connState === 'open',
    });
  };
  const unsubscribe = store.subscribe(update);
  const invalidate = store.getState().onModuleInvalidated(id => runtime.invalidate(id));
  const events = store.getState().onModuleEvent((id, payload) => runtime.receiveEvent(id, payload));
  document.addEventListener('visibilitychange', update);
  update();
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    invalidate();
    events();
    document.removeEventListener('visibilitychange', update);
    runtime.updateChatWindow(() => EMPTY_CHAT_WINDOW);
    runtime.updateView({ sessionId: null, visible: false, connected: false });
  };
}
