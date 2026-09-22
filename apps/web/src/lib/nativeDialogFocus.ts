const pointerFocus = 'data-native-dialog-pointer-focus';

// WebKit's native dialog entry/return can indicate focus even after a pointer
// action. Keep native focus and isolation; adjust only that focus's presentation.
export function installNativeDialogFocus(document: Document): () => void {
  let pointer = false;
  let previousModal: WeakRef<HTMLDialogElement> | undefined;
  let marked: WeakRef<HTMLElement> | undefined;
  const clear = () => {
    marked?.deref()?.removeAttribute(pointerFocus);
    marked = undefined;
  };
  const modalOf = (element: HTMLElement) =>
    element.closest<HTMLDialogElement>('dialog.ck-modal:modal');
  const mark = (element: HTMLElement) => {
    clear();
    // Editing controls retain their normal focus indication for either input.
    if (element.matches('input, textarea, select') || element.isContentEditable) return;
    element.setAttribute(pointerFocus, '');
    marked = new WeakRef(element);
  };
  const onPointer = () => {
    pointer = true;
    const active = document.activeElement;
    // Clicking an already focused control need not produce another focus event.
    if (active instanceof HTMLElement && modalOf(active)) mark(active);
    if (!previousModal?.deref()?.open) previousModal = undefined;
  };
  const onKey = () => {
    pointer = false;
    clear();
  };
  const onFocus = (event: FocusEvent) => {
    clear();
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const modal = modalOf(target);
    const previous = previousModal?.deref();
    const returning = previous && (!previous.open || !previous.isConnected);
    if (pointer && (modal || returning)) mark(target);
    previousModal = modal ? new WeakRef(modal) : undefined;
  };
  const onBlur = () => { clear(); };
  const onClose = (event: Event) => {
    if (previousModal?.deref() === event.target) previousModal = undefined;
  };
  document.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onBlur, true);
  document.addEventListener('close', onClose, true);
  // Keyboard navigation back from browser chrome may not send us its keydown.
  document.defaultView?.addEventListener('blur', onKey);
  return () => {
    clear();
    previousModal = undefined;
    document.removeEventListener('pointerdown', onPointer, { capture: true });
    document.removeEventListener('keydown', onKey, { capture: true });
    document.removeEventListener('focusin', onFocus, { capture: true });
    document.removeEventListener('focusout', onBlur, { capture: true });
    document.removeEventListener('close', onClose, { capture: true });
    document.defaultView?.removeEventListener('blur', onKey);
  };
}
