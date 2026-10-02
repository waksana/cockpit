import type { ModuleBackend } from '@cockpit/module-api/backend';

export const moduleDrainIntents = new Set([
  'session/get', 'session/chat', 'session/directory', 'session/tool-scope', 'respondAsk',
]);

export class ModuleLifetime {
  readonly controller = new AbortController();
  readonly stopping = new AbortController();
  readonly pending = new Set<Promise<unknown>>();
  backend?: ModuleBackend;
  preparation?: Promise<unknown>;
  activationSettled = false;
  drained = false;
  private draining?: Promise<void>;
  private disposal?: Promise<void>;

  constructor(readonly id: string) {}

  get awaitable(): boolean { return typeof this.backend?.onStop === 'function'; }

  invoke<T>(callback: () => T | Promise<T>): Promise<T> {
    const result = Promise.withResolvers<T>();
    this.pending.add(result.promise);
    void result.promise.then(() => this.pending.delete(result.promise), () => this.pending.delete(result.promise));
    try { result.resolve(callback()); } catch (error) { result.reject(error); }
    return result.promise;
  }

  signalStop(): void {
    this.stopping.abort();
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const result = Promise.withResolvers<void>();
    this.draining = result.promise;
    void (async () => {
      // Activation errors are reported by ModuleHost; join late preparation too.
      if (this.preparation) await Promise.allSettled([this.preparation]);
      this.signalStop();
      if (this.awaitable) {
        await this.backend!.onStop!();
        while (this.pending.size) await Promise.allSettled([...this.pending]);
      }
      this.drained = true;
    })().then(result.resolve, result.reject);
    return result.promise;
  }

  dispose(report: (error: unknown) => void): Promise<void> {
    if (this.disposal) return this.disposal;
    const disposed = Promise.withResolvers<void>();
    this.disposal = disposed.promise;
    this.controller.abort();
    try {
      const result = this.backend?.dispose?.();
      if (this.awaitable) {
        void Promise.resolve(result).then(disposed.resolve, disposed.reject);
      } else {
        void Promise.resolve(result).catch(report);
        disposed.resolve();
      }
    } catch (error) {
      if (this.awaitable) disposed.reject(error);
      else { report(error); disposed.resolve(); }
    }
    return disposed.promise;
  }
}
