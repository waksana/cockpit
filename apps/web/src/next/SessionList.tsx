import { Link } from 'react-router-dom';
import type { SessionMeta } from '../net/types';
import { sessionPath } from '../lib/routeOwnership';
import type { SessionActionHandlers } from '../lib/sessionActions';
import { SessionActions, SessionContextMenu } from './SessionActions';
import { SessionStatus } from './modules';
import { sessionSummary } from './sessionSummary';

export function SessionList({ sessions, activeId, snapshotReady, handlers }: {
  sessions: SessionMeta[]; activeId: string | null; snapshotReady: boolean; handlers: SessionActionHandlers;
}) {
  return <ul className="next-session-list" aria-busy={!snapshotReady}>
    {sessions.map(session => {
      const summary = sessionSummary(session);
      return <li key={session.sessionId}>
        <SessionContextMenu session={session} handlers={handlers}>
          <div className="next-session-row" data-session-id={session.sessionId} data-active={session.sessionId === activeId}>
            <Link to={sessionPath(session.sessionId)} replace={activeId !== null}
              aria-current={session.sessionId === activeId ? 'page' : undefined}>
              <span className="next-session-title">{session.title}</span>
              <time className="next-session-time" dateTime={new Date(session.lastActivity).toISOString()}>{summary.time}</time>
              <span className="next-session-directory">{summary.directory}</span>
              <SessionStatus sessionId={session.sessionId} status={session.status}
                needsDecision={!!(session.ask || session.planRequest || session.elicitation)} />
              {!!session.roles?.length && <span className="next-session-roles">
                <span className="sr-only">已保存角色（不代表已应用或能力就绪）：</span>
                {session.roles.map(role => `${role.moduleName} · ${role.name}`).join(' / ')}
              </span>}
            </Link>
            <SessionActions session={session} handlers={handlers} />
          </div>
        </SessionContextMenu>
      </li>;
    })}
  </ul>;
}
