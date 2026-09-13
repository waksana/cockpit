import type { ChatSession } from '../net/types';

type ListSession = Pick<ChatSession, 'sessionId' | 'title' | 'cwd' | 'lastActivity' | 'pinned'>;

export function groupSessions<T extends ListSession>(sessions: readonly T[], query: string) {
  const q = query.trim().toLowerCase();
  const filtered = sessions
    .filter((s) => !q
      || s.title.toLowerCase().includes(q)
      || s.cwd.toLowerCase().includes(q)
      || s.sessionId.toLowerCase().includes(q))
    .sort((a, b) => b.lastActivity - a.lastActivity);

  const pinnedList: T[] = [];
  const restList: T[] = [];
  for (const session of filtered) {
    (session.pinned ? pinnedList : restList).push(session);
  }
  return { pinnedList, restList };
}
