import { useLayoutEffect } from 'react';
import { hasUnpersistedDraftChanges, subscribeDraftChanges } from './draftSelection';

const listeners = new Set<() => void>();
let pending = 0;
let uncertain = false;
let unsavedForms = 0;
const notify = () => { for (const listener of listeners) listener(); };

export function hasHostLeaveRisk(): boolean {
  return pending > 0 || uncertain || unsavedForms > 0 || hasUnpersistedDraftChanges();
}

// Called at dispatch, never by a view's lifecycle. Unknown outcomes remain a
// document-local risk: a later unrelated read cannot establish what happened.
export function beginHostMutation(): (known: boolean) => void {
  pending++;
  notify();
  let settled = false;
  return known => {
    if (settled) return;
    settled = true;
    pending--;
    uncertain ||= !known;
    notify();
  };
}

export function registerHostUnsavedChanges(): () => void {
  unsavedForms++;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsavedForms--;
    notify();
  };
}

// The document entry owns this subscription, outside React/error boundaries.
// Dispose only when that entry is replaced, not when its rendered App unmounts.
export function installHostLeaveProtection(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  let installed = false;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  };
  const update = () => {
    const needed = hasHostLeaveRisk();
    if (needed === installed) return;
    installed = needed;
    if (needed) target.addEventListener('beforeunload', beforeUnload);
    else target.removeEventListener('beforeunload', beforeUnload);
  };
  listeners.add(update);
  const unsubscribe = subscribeDraftChanges(update);
  update();
  return () => {
    listeners.delete(update);
    unsubscribe();
    if (installed) {
      target.removeEventListener('beforeunload', beforeUnload);
      installed = false;
    }
  };
}

export function useHostUnsavedChanges(dirty: boolean): void {
  useLayoutEffect(() => dirty ? registerHostUnsavedChanges() : undefined, [dirty]);
}
