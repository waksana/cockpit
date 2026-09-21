import { useLayoutEffect, type RefObject } from 'react';

// The browser owns modal isolation, Tab, initial focus and close-time return.
// A docked panel uses open instead of show(), which would also move focus.
export function useNativeDialog(ref: RefObject<HTMLDialogElement | null>, modal = true) {
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (modal) dialog.showModal();
    else dialog.open = true;
    return () => { dialog.close(); };
  }, [ref, modal]);
}
