import type { ChatSession, SessionMeta } from './types';

export function metaToSession(meta: SessionMeta, previous?: ChatSession): ChatSession {
  return {
    ...meta,
    activityDisplay: meta.loaded && !meta.activity ? previous?.activityDisplay : undefined,
    controlsStale: meta.loaded && !!meta.controls ? previous?.controlsStale : undefined,
    controlsDisplay: meta.loaded && !meta.controls ? previous?.controlsDisplay : undefined,
    controlsError: meta.loaded ? previous?.controlsError : undefined,
    messages: previous?.messages ?? [],
    materialized: previous?.materialized ?? false,
    historyStale: previous?.historyStale ?? false,
    hasMore: previous?.hasMore ?? false,
    loadingHistory: previous?.loadingHistory ?? false,
    ...(previous?.historyError ? { historyError: previous.historyError } : {}),
    partialHistory: previous?.partialHistory,
    incompleteBoundary: previous?.incompleteBoundary,
  };
}

export function invalidateWindow(session: ChatSession): ChatSession {
  return { ...session, historyStale: true, loadingHistory: false };
}
