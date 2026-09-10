import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { useCockpit } from '../net/store';
import { createKeyedAsync, type AsyncSnapshot } from './keyedAsync';

function useOwnedAsync<T>(key: string, enabled = true) {
  const connected = useCockpit((s) => s.connState === 'open');
  const generation = useCockpit((s) => s.connectionGeneration);
  const task = useMemo(() => createKeyedAsync<T>(key, useCockpit.getState), [key]);
  const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);
  useLayoutEffect(() => {
    if (enabled) task.activate();
    else task.deactivate(true);
    return () => task.deactivate();
  }, [task, connected, generation, enabled]);
  return { task, snapshot, connected, generation };
}

export function useKeyedResource<T>(
  key: string, load: (signal: AbortSignal) => Promise<T>, revision: string | number = 0, enabled = true,
  canAutoRefresh?: (snapshot: AsyncSnapshot<T>) => boolean,
) {
  const { task, snapshot, connected, generation } = useOwnedAsync<T>(key, enabled);
  const refresh = useCallback((read = load) => task.refresh(read), [task, load]);
  useLayoutEffect(() => {
    if (connected && enabled && (!canAutoRefresh || canAutoRefresh(task.getSnapshot()))) void refresh();
  }, [task, refresh, connected, generation, revision, enabled, canAutoRefresh]);
  const pending = enabled && connected && (snapshot.pending || snapshot.generation !== generation);
  const error = enabled && snapshot.generation === generation ? snapshot.error : null;
  return {
    data: enabled ? snapshot.data : undefined, error, pending, connected, refresh,
    errorCause: enabled ? snapshot.errorCause : undefined,
    valid: enabled && connected && !pending && !error && snapshot.dataGeneration === generation,
    failed: Boolean(error),
    status: !connected ? '等待连接…' : !enabled ? null : error ? `加载失败：${error}` : pending ? '加载中…' : null,
  };
}

export function useKeyedAction(key: string) {
  const { task, snapshot, connected, generation } = useOwnedAsync<void>(key);
  const run = useCallback((action: () => void | Promise<void>, onSuccess?: () => void) =>
    task.run(action, onSuccess, true), [task]);
  return {
    run, connected,
    busy: snapshot.pending && snapshot.generation === generation,
    error: snapshot.generation === generation ? snapshot.error : null,
  };
}
