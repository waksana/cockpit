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

export function resourceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One mounted resource/action owns one key. Requests are never shared globally.
export function createKeyedAsync<T>(key: string, getConnection: () => ResourceConnection) {
  let active = false;
  let request: AbortController | undefined;
  let snapshot: AsyncSnapshot<T> = { error: null, pending: false, generation: -1 };
  const listeners = new Set<() => void>();
  const publish = (next: AsyncSnapshot<T>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const invalidate = (clearError = false) => {
    const previous = request;
    request = undefined;
    previous?.abort();
    publish({ ...snapshot, pending: false, error: null,
      errorCause: clearError ? undefined : snapshot.errorCause, generation: getConnection().connectionGeneration });
  };
  return {
    key,
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
}
