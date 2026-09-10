import type { ChatSession, SessionMeta } from './types';

export function metaToSession(meta: SessionMeta, previous?: ChatSession): ChatSession {
  return {
    ...meta,
    messages: previous?.messages ?? [],
    materialized: previous?.materialized ?? false,
    historyStale: previous?.historyStale ?? false,
    hasMore: previous?.hasMore ?? false,
    loadingHistory: previous?.loadingHistory ?? false,
    partialHistory: previous?.partialHistory,
    incompleteBoundary: previous?.incompleteBoundary,
  };
}

export function invalidateWindow(session: ChatSession): ChatSession {
  return { ...session, historyStale: true, loadingHistory: false };
}
