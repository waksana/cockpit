import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationScrollController, ConversationScrollOptions } from '@cockpit/module-api/frontend';
import { observeThreadScroll, type ThreadScroll } from '../components/threadScroll';

/** Shared lifecycle around Chat's only scroll-position writer. */
export function useConversationScroll<Item>({ key, items, itemKey }: ConversationScrollOptions<Item>): ConversationScrollController<Item> {
  const [viewport, viewportRef] = useState<HTMLDivElement | null>(null);
  const [content, contentRef] = useState<HTMLDivElement | null>(null);
  const owner = useRef<ThreadScroll | null>(null);
  const retained = useRef<{ key: string; position: ReturnType<ThreadScroll['snapshot']> } | null>(null);
  const [heldHead, setHeldHead] = useState<{ key: string; id: string } | null>(null);
  const shown = useMemo(() => {
    const start = heldHead?.key === key ? items.findIndex(item => itemKey(item) === heldHead.id) : -1;
    return start > 0 ? items.slice(start) : items;
  }, [heldHead, key, items, itemKey]);
  const head = useRef<string | undefined>(undefined);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  useLayoutEffect(() => { head.current = shown.length ? itemKey(shown[0]) : undefined; });
  useLayoutEffect(() => {
    if (!viewport || !content) return;
    const position = retained.current?.key === key ? retained.current.position : undefined;
    if (!position) {
      setHasNewContent(false);
      setAwayFromBottom(false);
    }
    const observed = observeThreadScroll(viewport, content, () => setHasNewContent(false),
      active => setHeldHead(active && head.current !== undefined ? { key, id: head.current } : null),
      setAwayFromBottom, position);
    owner.current = observed.scroll;
    return () => {
      retained.current = { key, position: observed.scroll.snapshot() };
      observed.dispose();
      owner.current = null;
      setHeldHead(null);
    };
  }, [key, viewport, content]);
  const isFollowing = useCallback(() => owner.current?.following ?? true, []);
  const follow = useCallback(() => { owner.current?.follow(); }, []);
  const changed = useCallback<ConversationScrollController<Item>['changed']>(({ contentReady, newContent }) => {
    if (newContent && owner.current && !owner.current.following) setHasNewContent(true);
    owner.current?.changed({ contentReady });
  }, []);
  return { items: shown, prependHeld: shown !== items, viewportRef, contentRef, viewport, content,
    awayFromBottom, hasNewContent, isFollowing, follow, changed };
}
