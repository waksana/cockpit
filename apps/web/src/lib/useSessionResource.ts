import { useCockpit } from '../net/store';
import { isSessionUnloadedError } from '../net/client';
import { useKeyedResource } from './useKeyedResource';
import type { AsyncSnapshot } from './keyedAsync';
import type { SessionResource } from '@cockpit/protocol';

export function canAutoRefreshSessionResource(snapshot: AsyncSnapshot<unknown>) {
  return !isSessionUnloadedError(snapshot.errorCause);
}

export function useSessionResource<T>(
  sessionId: string, key: string, load: (signal: AbortSignal) => Promise<T>, revision: string | number = 0,
  dependencies: readonly SessionResource[] = [],
) {
  const loaded = useCockpit((s) => s.sessions.find((session) => session.sessionId === sessionId)?.loaded === true);
  const closing = useCockpit((s) => s.sessions.find((session) => session.sessionId === sessionId)?.closing === true);
  const resourceRevision = useCockpit(s => dependencies.map(resource => s.resourceRevisions[sessionId]?.[resource] ?? 0).join(':'));
  // Do not use the session object or lastActivity as a revision: detail reads can
  // themselves produce patches. Only explicit resource changes should reread.
  const resource = useKeyedResource<T>(key, load, `${revision}:${resourceRevision}`, loaded && !closing, canAutoRefreshSessionResource);
  const requiresResume = !loaded || isSessionUnloadedError(resource.errorCause);
  return {
    ...resource,
    requiresResume,
    data: requiresResume ? undefined : resource.data,
    valid: !requiresResume && resource.valid,
    status: requiresResume && resource.connected ? null : resource.status,
    failed: !requiresResume && resource.failed,
  };
}
