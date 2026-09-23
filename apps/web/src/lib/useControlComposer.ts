import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

// One editor survives purpose changes, while its draft remains purpose-owned.
export function useControlComposer(cardRef: RefObject<HTMLElement | null>, enabled: boolean,
  purpose: string, decision: string | undefined) {
  const geometry = useRef<{ purpose: string; height: number; width: number } | undefined>(undefined);
  const previousDecision = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!enabled) { geometry.current = undefined; previousDecision.current = undefined; return; }
    const card = cardRef.current;
    const editor = card?.querySelector<HTMLElement>('.chat-input-message');
    if (!card || !editor) return;
    const previous = geometry.current;
    if (previous && previous.purpose !== purpose && previous.height > 0) {
      card.style.setProperty('--control-editor-height', `${previous.height}px`);
      card.setAttribute('data-editor-fixed', '');
      card.setAttribute('data-editor-sized', '');
    }
    const measure = () => {
      const rect = editor.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) return;
      if (geometry.current && Math.abs(geometry.current.width - rect.width) > 1) {
        card.removeAttribute('data-editor-fixed');
        card.removeAttribute('data-editor-sized');
        card.style.removeProperty('--control-editor-height');
      }
      geometry.current = { purpose, height: rect.height, width: rect.width };
    };
    measure();
    if (decision && previousDecision.current !== decision) {
      const body = card.querySelector('.chat-input-card-body');
      if (body) body.scrollTop = body.scrollHeight;
    }
    previousDecision.current = decision;
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [cardRef, enabled, purpose, decision]);
  return useCallback(() => {
    // Run after the editor's onChange has consumed the value, never in capture.
    cardRef.current?.removeAttribute('data-editor-fixed');
  }, [cardRef]);
}
