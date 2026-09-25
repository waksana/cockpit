import { useLayoutEffect, type RefObject } from 'react';

// Keep the shared editor in view for a new decision; CSS sizes it to its current draft.
export function useControlComposer(cardRef: RefObject<HTMLElement | null>, enabled: boolean,
  decision: string | undefined) {
  useLayoutEffect(() => {
    if (!enabled || !decision) return;
    const body = cardRef.current?.querySelector('.chat-input-card-body');
    if (body) body.scrollTop = body.scrollHeight;
  }, [cardRef, enabled, decision]);
}
