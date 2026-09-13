import { isUnreadAttention, unreadSessionCount, type SessionMeta } from '@cockpit/protocol';

export { isUnreadAttention, unreadSessionCount };

export function mergeAttentionPatch<T extends SessionMeta>(session: T, patch: Partial<SessionMeta>): T {
  const next = { ...session, ...patch };
  next.seenId = Math.max(session.seenId ?? 0, patch.seenId ?? 0);
  if ((patch.attnId !== undefined && patch.attnId < (session.attnId ?? 0))
    || (patch.attention === null && patch.seenId !== undefined
      && patch.seenId < (session.attnId ?? 0) && patch.attnId === undefined)) {
    next.attnId = session.attnId;
    next.attention = session.attention;
  }
  return next;
}

// Preserve a server total across partial metadata patches, adjusting only by the
// changed rows' confirmed unread waterlines. Never infer attention from messages.
export function patchedUnreadCount(
  count: number, before: readonly SessionMeta[], after: readonly SessionMeta[],
): number {
  return Math.max(0, count + unreadSessionCount(after) - unreadSessionCount(before));
}

export function currentInboxRevision(previous: number | undefined, incoming: number | undefined): boolean {
  return previous === undefined || (incoming !== undefined && incoming >= previous);
}
