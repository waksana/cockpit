import type { ChatSession } from '../net/types';

type ListSession = Pick<ChatSession, 'sessionId' | 'title' | 'cwd' | 'lastActivity'>;

export function filterSessions<T extends ListSession>(sessions: readonly T[], query: string) {
  const q = query.trim().toLowerCase();
  return sessions
    .filter((s) => !q
      || s.title.toLowerCase().includes(q)
      || s.cwd.toLowerCase().includes(q)
      || s.sessionId.toLowerCase().includes(q))
    .sort((a, b) => b.lastActivity - a.lastActivity);
}
