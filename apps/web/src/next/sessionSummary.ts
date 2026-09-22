import type { SessionMeta } from '../net/types';

export function sessionSummary(session: Pick<SessionMeta, 'cwd' | 'lastActivity'>, now = Date.now()) {
  const elapsed = Math.max(0, now - session.lastActivity);
  const date = new Date(session.lastActivity);
  return {
    directory: session.cwd.split('/').filter(Boolean).pop() || session.cwd || '工作目录未提供',
    time: elapsed < 60_000 ? '刚刚' : elapsed < 3_600_000 ? `${Math.floor(elapsed / 60_000)}分`
      : elapsed < 86_400_000 ? `${Math.floor(elapsed / 3_600_000)}时` : `${date.getMonth() + 1}/${date.getDate()}`,
  };
}
