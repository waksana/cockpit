import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatSession } from '../../net/types';
import { observeLocalSubmissions } from '../../lib/localSubmission';
import { useConversationScroll } from '../../lib/useConversationScroll';
import { observeHistoryPrefetch } from '../../components/historyPrefetch';
import { hasNewTranscriptContent } from '../../lib/transcriptActivity';

// The transcript's single scroll owner: reading position, explicit follow,
// near-head history prefetch and the "new content" badge state.
export function useThreadScroll(session: ChatSession, { readOnly, connected, snapshotReady, onLoadMore }: {
  readOnly: boolean; connected: boolean; snapshotReady: boolean; onLoadMore: () => void;
}) {
  const scroll = useConversationScroll({ key: session.sessionId, items: session.messages, itemKey: message => message.id });
  const { viewport, content, viewportRef: scrollRef, contentRef, follow, isFollowing, changed,
    hasNewContent, awayFromBottom, items: messages, prependHeld } = scroll;
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const visible = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  const previousMessages = useRef<ChatMessage[]>([]);

  useLayoutEffect(() => {
    if (!viewport || !content || readOnly) return;
    return observeLocalSubmissions(session.sessionId, follow);
  }, [session.sessionId, readOnly, viewport, content, follow]);

  // Every mounted viewport owns its measured fill and near-head prefetch. A
  // retained native page proves neither two screens nor this viewport's size.
  // Existing rows stay visible; the separate scroll owner preserves the reader.
  useLayoutEffect(() => {
    if (!connected || !snapshotReady || !pageVisible || !viewport || !content || !session.materialized
      || session.loadingHistory || session.historyError || session.error || session.historyStale || prependHeld) return;
    const needsFill = () => viewport.clientHeight > 0 && viewport.scrollHeight < viewport.clientHeight * 2;
    return observeHistoryPrefetch(viewport, content, () => session.hasMore && !session.incompleteBoundary
      && (needsFill() || !isFollowing()), onLoadMore, () => viewport.scrollTop, needsFill);
  }, [session.sessionId, session.hasMore, session.materialized, session.loadingHistory, session.historyError,
    session.error, session.historyStale, session.incompleteBoundary, onLoadMore,
    prependHeld, pageVisible, connected, snapshotReady, viewport, content, isFollowing]);

  useLayoutEffect(() => {
    changed({ contentReady: !!content?.querySelector('[data-message-frame]'),
      newContent: hasNewTranscriptContent(previousMessages.current, session.messages) });
    previousMessages.current = session.messages;
  }, [messages, session.sessionId, session.messages, session.status, session.compacting, session.error, session.materialized, session.hasMore, viewport, content, changed]);

  return { scrollRef, contentRef, messages, hasNewContent, awayFromBottom, follow };
}
