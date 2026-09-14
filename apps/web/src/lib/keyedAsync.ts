export interface ResourceConnection {
  connState: string;
  connectionGeneration: number;
}

export interface AsyncSnapshot<T> {
  data?: T;
  error: string | null;
  errorCause?: unknown;
  pending: boolean;
  generation: number;
  dataGeneration?: number;
}

function resourceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One mounted resource/action owns one key. Requests are never shared globally.
export function createKeyedAsync<T>(getConnection: () => ResourceConnection) {
  let active = false;
  let request: AbortController | undefined;
  let refreshRequest: { dirty: boolean; load: (signal: AbortSignal) => T | Promise<T>; promise: Promise<boolean> } | undefined;
  let snapshot: AsyncSnapshot<T> = { error: null, pending: false, generation: -1 };
  const listeners = new Set<() => void>();
  const publish = (next: AsyncSnapshot<T>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const invalidate = (clearError = false) => {
    const previous = request;
    request = undefined;
    refreshRequest = undefined;
    previous?.abort();
    publish({ ...snapshot, pending: false, error: null,
      errorCause: clearError ? undefined : snapshot.errorCause, generation: getConnection().connectionGeneration });
  };
  const task = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate() { active = true; invalidate(); },
    deactivate(clearError = false) { active = false; invalidate(clearError); },
    release() {
      active = false;
      invalidate(true);
      publish({ error: null, pending: false, generation: getConnection().connectionGeneration });
    },
    refresh(load: (signal: AbortSignal) => T | Promise<T>): Promise<boolean> {
      if (!active || getConnection().connState !== 'open') return Promise.resolve(false);
      if (refreshRequest) {
        refreshRequest.dirty = true;
        refreshRequest.load = load;
        return refreshRequest.promise;
      }
      const refresh = { dirty: true, load, promise: Promise.resolve(false) };
      refreshRequest = refresh;
      refresh.promise = Promise.resolve().then(() => refreshRequest !== refresh ? false : task.run(async signal => {
        let data: T;
        do {
          refresh.dirty = false;
          data = await refresh.load(signal);
        } while (refresh.dirty && refreshRequest === refresh && !signal.aborted);
        return data;
      })).finally(() => {
        if (refreshRequest !== refresh) return;
        refreshRequest = undefined;
        // An invalidation may land between publication and promise settlement.
        if (refresh.dirty && active) void task.refresh(refresh.load);
      });
      return refresh.promise;
    },
    async run(load: (signal: AbortSignal) => T | Promise<T>, onSuccess?: (data: T) => void, exclusive = false): Promise<boolean> {
      const connection = getConnection();
      if (!active || connection.connState !== 'open') return false;
      if (exclusive && snapshot.pending && snapshot.generation === connection.connectionGeneration) return false;
      const previous = request;
      const identity = new AbortController();
      request = identity;
      previous?.abort();
      const generation = connection.connectionGeneration;
      const owns = () => active && request === identity
        && getConnection().connState === 'open'
        && getConnection().connectionGeneration === generation;
      publish({ ...snapshot, pending: true, error: null, errorCause: undefined, generation });
      try {
        if (!owns()) return false;
        const data = await load(identity.signal);
        if (!owns()) return false;
        publish({ data, pending: false, error: null, generation, dataGeneration: generation });
        if (owns()) onSuccess?.(data);
        return owns();
      } catch (error) {
        if (!owns()) return false;
        publish({ ...snapshot, pending: false, error: resourceError(error), errorCause: error, generation });
        return false;
      }
    },
  };
  return task;
}
