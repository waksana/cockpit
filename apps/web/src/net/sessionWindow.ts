import type { ChatMessage, ChatSession, HistoryPage, SessionMeta } from './types';

export const HISTORY_PAGE = 30;

export class HistoryRangeError extends Error {}

export function metaToSession(meta: SessionMeta, previous?: ChatSession): ChatSession {
  return {
    ...meta,
    messages: previous?.messages ?? [],
    materialized: previous?.materialized ?? false,
    historyStale: previous?.historyStale ?? true,
    resumeAfter: previous?.resumeAfter,
    hasMore: previous?.hasMore ?? false,
    loadingHistory: previous?.loadingHistory ?? false,
    ...(previous?.resumeToken ? { resumeToken: previous.resumeToken } : {}),
    ...(previous?.liveMessageIds ? { liveMessageIds: previous.liveMessageIds } : {}),
  };
}

export function invalidateWindow(session: ChatSession): ChatSession {
  return {
    ...session,
    historyStale: true,
    loadingHistory: false,
  };
}

export function releaseWindow(session: ChatSession): ChatSession {
  return {
    ...session, messages: [], materialized: false, historyStale: true,
    resumeAfter: undefined, hasMore: false, loadingHistory: false,
    resumeToken: undefined, liveMessageIds: undefined,
  };
}

export function retainLatestWindow(session: ChatSession): ChatSession {
  if (!session.materialized) return releaseWindow(session);
  const start = Math.max(0, session.messages.length - HISTORY_PAGE);
  const messages = session.messages.slice(start);
  const retained = new Set(messages.map(message => message.id));
  return {
    ...invalidateWindow(session), messages, hasMore: session.hasMore || start > 0,
    resumeAfter: undefined, resumeToken: undefined,
    liveMessageIds: session.liveMessageIds?.filter(id => retained.has(id)),
  };
}

export function applyResumedHistory(
  session: ChatSession, page: HistoryPage, streamed: ReadonlyMap<string, ChatMessage>,
): ChatSession {
  const have = new Set(session.messages.map(message => message.id));
  const first = page.messages.findIndex(message => have.has(message.id));
  const boundary = first < 0 ? -1 : session.messages.findIndex(message => message.id === page.messages[first].id);
  const prefixIds = new Set(session.messages.slice(0, Math.max(0, boundary)).map(message => message.id));
  if (first < 0 || (session.resumeAfter && !page.messages.some(message => message.id === session.resumeAfter)
    && !streamed.has(session.resumeAfter)) || page.messages.slice(first).some(message => prefixIds.has(message.id))) {
    throw new HistoryRangeError('历史同步未能覆盖本次已读取的记录，请重新读取最新历史');
  }
  const messages = page.messages.slice(first);
  const next = applyHistoryPage({ ...session, resumeAfter: messages[0].id }, { ...page, messages, append: true }, streamed);
  return {
    ...next,
    resumeToken: page.resume?.status === 'ready' ? page.resume.token : undefined,
  };
}

export function applyHistoryPage(
  session: ChatSession,
  page: HistoryPage,
  streamed: ReadonlyMap<string, ChatMessage> = new Map(),
): ChatSession {
  if (page.sessionId !== session.sessionId) throw new Error('History sessionId mismatch');
  const persistedIds = new Set(page.messages.map(message => message.id));
  // HTTP owns persisted values; preserve earlier live-only messages until they
  // reach the journal, and let upserts observed during this read win races.
  const firstSurvivor = session.messages.findIndex(message => persistedIds.has(message.id));
  const offPage = new Set(page.latest && firstSurvivor > 0
    ? session.messages.slice(0, firstSurvivor).map(message => message.id) : []);
  const keepPriorLive = !page.latest || firstSurvivor >= 0 || (!page.messages.length && !session.resumeAfter);
  const liveIds = new Set(keepPriorLive
    ? session.liveMessageIds?.filter(id => !persistedIds.has(id) && !offPage.has(id)) : []);
  const live = new Map(session.messages.filter(message => liveIds.has(message.id)).map(message => [message.id, message]));
  for (const [id, message] of streamed) {
    if (!offPage.has(id)) { live.set(id, message); liveIds.add(id); }
  }
  const overlay = (messages: ChatMessage[]) => {
    const have = new Set(messages.map((message) => message.id));
    const before = new Map<string | undefined, ChatMessage[]>();
    let next: string | undefined;
    // Preserve live positions inside the retained range, never an off-page prefix
    // that would make the next older cursor skip an unloaded interval.
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const message = session.messages[i];
      if (have.has(message.id)) next = message.id;
      else if (live.has(message.id)) {
        const bucket = before.get(next) ?? [];
        bucket.push(live.get(message.id)!);
        before.set(next, bucket);
      }
    }
    const result: ChatMessage[] = [];
    for (const message of messages) {
      result.push(...(before.get(message.id)?.reverse() ?? []), live.get(message.id) ?? message);
    }
    result.push(...(before.get(undefined)?.reverse() ?? []));
    const included = new Set(result.map((message) => message.id));
    for (const message of live.values()) if (!included.has(message.id)) result.push(message);
    return result;
  };
  if (page.append) {
    if (!session.materialized) return session;
    const reconciled = !session.historyStale || (session.resumeAfter !== undefined
      && page.messages.some((message) => message.id === session.resumeAfter));
    const tailIds = new Set(page.messages.map((message) => message.id));
    const boundary = session.messages.findIndex((message) => tailIds.has(message.id));
    const prefix = boundary < 0 ? session.messages : session.messages.slice(0, boundary);
    // HTTP owns the suffix; only upserts observed during this request may outlive it.
    return {
      ...session,
      liveMessageIds: [...liveIds],
      messages: overlay([
        ...prefix.filter((message) => !tailIds.has(message.id)),
        ...page.messages,
      ]),
      ...(reconciled ? { historyStale: false, resumeAfter: page.messages.at(-1)?.id, loadingHistory: false, error: null } : {}),
    };
  }
  if (page.latest) {
    return {
      ...session, messages: overlay(page.messages), hasMore: page.hasMore,
      materialized: true, historyStale: false, resumeAfter: page.messages.at(-1)?.id, loadingHistory: false, error: null,
      liveMessageIds: [...liveIds],
      resumeToken: page.resume?.status === 'ready' ? page.resume.token : undefined,
    };
  }
  const have = new Set(session.messages.map((message) => message.id));
  return {
    ...session,
    messages: overlay([...page.messages.filter((message) => !have.has(message.id)), ...session.messages]),
    hasMore: page.hasMore,
    loadingHistory: session.historyStale && session.loadingHistory,
    liveMessageIds: [...liveIds],
  };
}
