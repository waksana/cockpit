import { shallow } from 'zustand/shallow';
import type { ChatSession, SessionMeta } from '../net/types';

const WINDOW_FIELDS = new Set([
  'messages', 'materialized', 'historyStale', 'hasMore', 'loadingHistory', 'partialHistory', 'incompleteBoundary',
]);

// A message window is not sidebar data. Keep the existing store contract while
// giving layout subscribers stable metadata rows through streaming/history updates.
export function createSessionMetadataSelector() {
  let input: ChatSession[] | undefined;
  let rows: SessionMeta[] = [];
  let byId = new Map<string, { source: ChatSession; row: SessionMeta }>();
  return ({ sessions }: { sessions: ChatSession[] }): SessionMeta[] => {
    if (sessions === input) return rows;
    const nextById = new Map<string, { source: ChatSession; row: SessionMeta }>();
    const next = sessions.map((session) => {
      const previous = byId.get(session.sessionId);
      let row = previous?.row;
      if (previous?.source !== session) {
        const metadata = Object.fromEntries(
          Object.entries(session).filter(([key]) => !WINDOW_FIELDS.has(key)),
        ) as SessionMeta;
        if (!row || !shallow(row, metadata)) row = metadata;
      }
      nextById.set(session.sessionId, { source: session, row: row! });
      return row!;
    });
    input = sessions;
    byId = nextById;
    if (next.length !== rows.length || next.some((row, index) => row !== rows[index])) rows = next;
    return rows;
  };
}
