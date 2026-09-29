import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ChatSession } from '../../net/types';
import { observeLocalSubmissions } from '../../lib/localSubmission';
import { observeThreadScroll, type ThreadScroll } from '../../components/threadScroll';
import { observeHistoryPrefetch } from '../../components/historyPrefetch';
import { hasNewTranscriptContent } from '../../lib/transcriptActivity';

// The transcript's single scroll owner: reading position, explicit follow,
// near-head history prefetch and the "new content" badge state.
export function useThreadScroll(session: ChatSession, { readOnly, connected, snapshotReady, onLoadMore }: {
  readOnly: boolean; connected: boolean; snapshotReady: boolean; onLoadMore: () => void;
}) {
  const [viewport, scrollRef] = useState<HTMLDivElement | null>(null);
  const [content, contentRef] = useState<HTMLDivElement | null>(null);
  const scrollOwnerRef = useRef<ThreadScroll | null>(null);
  const retained = useRef<{ sessionId: string; position: ReturnType<ThreadScroll['snapshot']> } | null>(null);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const visible = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  const [heldHead, setHeldHead] = useState<{ sessionId: string; id: string } | null>(null);
  // Keep the existing DOM prefix under an active gesture. Only newly received
  // older rows wait for settle; tail updates and already mounted history stay live.
  const messages = useMemo(() => {
    const start = heldHead?.sessionId === session.sessionId
      ? session.messages.findIndex((message) => message.id === heldHead.id) : -1;
    return start > 0 ? session.messages.slice(start) : session.messages;
  }, [heldHead, session.sessionId, session.messages]);
  const prependHeld = messages !== session.messages;
  const [hasNewContent, setHasNewContent] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const previousMessages = useRef<ChatMessage[]>([]);
  useLayoutEffect(() => {
    if (!viewport || !content) return;
    const position = retained.current?.sessionId === session.sessionId ? retained.current.position : undefined;
    if (!position) previousMessages.current = [];
    const owner = observeThreadScroll(viewport, content, () => setHasNewContent(false), (active) => {
      const id = content.querySelector<HTMLElement>('[data-window-item-id]')?.getAttribute('data-window-item-id') ?? undefined;
      setHeldHead(active && id ? { sessionId: session.sessionId, id } : null);
    }, setAwayFromBottom, position);
    scrollOwnerRef.current = owner.scroll;
    // Middleware may replace the actual nodes without ending this Thread's view.
    return () => {
      retained.current = { sessionId: session.sessionId, position: owner.scroll.snapshot() };
      owner.dispose();
      scrollOwnerRef.current = null;
      setHeldHead(null);
    };
  }, [session.sessionId, viewport, content]);

  useLayoutEffect(() => {
    const owner = scrollOwnerRef.current;
    if (!owner || readOnly) return;
    return observeLocalSubmissions(session.sessionId, () => owner.follow());
  }, [session.sessionId, readOnly, viewport, content]);

  // Every mounted viewport owns its measured fill and near-head prefetch. A
  // retained native page proves neither two screens nor this viewport's size.
  // Existing rows stay visible; the separate scroll owner preserves the reader.
  useLayoutEffect(() => {
    if (!connected || !snapshotReady || !pageVisible || !viewport || !content || !session.materialized
      || session.loadingHistory || session.historyError || session.error || session.historyStale || prependHeld) return;
    const needsFill = () => viewport.clientHeight > 0 && viewport.scrollHeight < viewport.clientHeight * 2;
    return observeHistoryPrefetch(viewport, content, () => session.hasMore && !session.incompleteBoundary
      && (needsFill() || !scrollOwnerRef.current?.following), onLoadMore, () => viewport.scrollTop, needsFill);
  }, [session.sessionId, session.hasMore, session.materialized, session.loadingHistory, session.historyError,
    session.error, session.historyStale, session.incompleteBoundary, onLoadMore,
    prependHeld, pageVisible, connected, snapshotReady, viewport, content]);

  useLayoutEffect(() => {
    const owner = scrollOwnerRef.current;
    if (owner && !owner.following && hasNewTranscriptContent(previousMessages.current, session.messages)) {
      setHasNewContent(true);
    }
    previousMessages.current = session.messages;
    owner?.changed({ contentReady: !!content?.querySelector('[data-message-frame]') });
  }, [messages, session.sessionId, session.messages, session.status, session.compacting, session.error, session.materialized, session.hasMore, viewport, content]);

  const follow = useCallback(() => { scrollOwnerRef.current?.follow(); }, []);
  return { scrollRef, contentRef, messages, hasNewContent, awayFromBottom, follow };
}
