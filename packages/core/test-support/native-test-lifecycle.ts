import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import type { Server } from 'node:http';
import { CopilotClient, type CopilotClientOptions } from '@github/copilot-sdk';

type OwnedClient = { forceStop(): Promise<void> };
type OwnedChild = { closed: Promise<void>; didClose: boolean; killing: boolean; failed: boolean };

/** Test-owned resources only; never attach this to a shared or external runtime. */
export class NativeTestLifecycle {
  private readonly clients = new Set<OwnedClient>();
  private readonly children = new Map<ChildProcess, OwnedChild>();
  private readonly startups = new Set<Promise<void>>();
  private readonly terminationFailure = Promise.withResolvers<never>();
  private readonly servers = new Map<Server, Promise<void> | undefined>();
  private readonly pending = new Map<symbol, string>();
  private readonly failures: unknown[] = [];
  private readonly forced: Promise<void>[] = [];
  private phase = 'fixture setup';
  private finished = false;
  private terminating = false;
  private terminationFailed = false;

  constructor(
    private readonly signal: AbortSignal,
    private readonly diagnostic: (message: string) => void,
  ) {
    void this.terminationFailure.promise.catch(() => {});
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  setPhase(phase: string): void { this.phase = phase; }

  async operation<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const key = Symbol();
    this.pending.set(key, name);
    try { return await work(); }
    finally { this.pending.delete(key); }
  }

  own<T extends OwnedClient>(client: T): T {
    this.signal.throwIfAborted();
    this.clients.add(client);
    return client;
  }

  server(server: Server): Server {
    this.signal.throwIfAborted();
    this.servers.set(server, undefined);
    return server;
  }

  readonly clientFactory = (options: CopilotClientOptions): CopilotClient => {
    const client = this.own(new CopilotClient(options));
    const start = client.start.bind(client), stop = client.stop.bind(client);
    const create = client.createSession.bind(client), resume = client.resumeSession.bind(client);
    client.start = () => this.operation('client.start', () => this.starting(client, start));
    client.stop = () => this.operation('client.stop', async () => {
      const errors = await stop();
      if (errors.length) throw new AggregateError(errors, 'Native fixture client.stop failed');
      return errors;
    });
    client.createSession = (...args) => this.operation('client.createSession', () => create(...args));
    client.resumeSession = (...args) => this.operation('client.resumeSession', () => resume(...args));
    return client;
  };

  async starting<T>(client: OwnedClient, work: () => Promise<T>): Promise<T> {
    // As in OfficialRuntime, the SDK has no public child-close subscription.
    // Observe only descendants spawned in this owned startup's async context.
    const scope = new AsyncLocalStorage<boolean>();
    const spawning = channel('child_process');
    const settled = Promise.withResolvers<void>();
    this.startups.add(settled.promise);
    const observe = (message: unknown) => {
      if (!scope.getStore()) return;
      const child = (message as { process: ChildProcess }).process;
      if (this.children.has(child)) return;
      const closed = Promise.withResolvers<void>();
      const owned: OwnedChild = { closed: closed.promise, didClose: false, killing: false, failed: false };
      this.children.set(child, owned);
      child.once('close', () => { owned.didClose = true; closed.resolve(); });
      child.on('error', error => {
        if (owned.killing) this.childKillFailed(owned, error);
      });
      child.once('spawn', () => {
        // start() may still be resolving the executable when the deadline fires.
        if (this.terminating) {
          this.force(client);
          this.killChild(child, owned);
        }
      });
    };
    spawning.subscribe(observe);
    try { return await scope.run(true, work); }
    finally {
      spawning.unsubscribe(observe);
      scope.disable();
      this.startups.delete(settled.promise);
      settled.resolve();
    }
  }

  private record(label: string, error: unknown): void {
    this.failures.push(error);
    // Do not serialize native errors: they may contain request/configuration data.
    this.diagnostic(`Native fixture cleanup failed: ${label}`);
  }

  private force(client: OwnedClient): void {
    this.forced.push(Promise.resolve().then(() => client.forceStop())
      .catch(error => { this.record('client.forceStop', error); }));
  }

  private childKillFailed(owned: OwnedChild, error: unknown): void {
    if (owned.failed) return;
    owned.failed = true;
    this.terminationFailed = true;
    this.record('owned child SIGKILL', error);
    this.terminationFailure.reject(error);
  }

  private killChild(child: ChildProcess, owned: OwnedChild): void {
    if (owned.didClose || owned.killing || child.pid === undefined ||
        child.exitCode !== null || child.signalCode !== null) return;
    owned.killing = true;
    try {
      if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null) {
        this.childKillFailed(owned, new Error('Owned child rejected SIGKILL'));
      }
    } catch (error) { this.childKillFailed(owned, error); }
  }

  private terminate(): void {
    this.terminating = true;
    for (const client of this.clients) this.force(client);
    // SDK stop() clears its child reference before awaiting SIGTERM. Keep our
    // own handles until close; forceStop() alone cannot reach that child.
    for (const [child, owned] of this.children) this.killChild(child, owned);
  }

  private async awaitNativeClosure(): Promise<void> {
    await Promise.all(this.startups);
    await Promise.all(this.forced);
    await Promise.all([...this.children.values()].map(child => child.closed));
    await Promise.all(this.forced);
  }

  private closeServers(): Promise<void[]> {
    return Promise.all([...this.servers].map(([server, closing]) => {
      if (closing) return closing;
      const result = new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }).catch(error => { this.record('HTTP server close', error); });
      this.servers.set(server, result);
      return result;
    }));
  }

  private readonly abort = (): void => {
    if (this.finished) return;
    // Bounded labels only, never arguments, prompts, IDs or configuration.
    this.diagnostic(`Native fixture aborted: phase=${this.phase}; pending=${[...this.pending.values()].slice(-8).join(', ') || 'none'}`);
    this.terminate();
    void this.closeServers();
  };

  async finish(graceful: () => Promise<void>, dispose: () => Promise<void>): Promise<void> {
    try {
      try {
        if (!this.signal.aborted) {
          this.setPhase('graceful cleanup');
          await Promise.race([
            Promise.resolve().then(graceful).catch(error => {
              this.record('graceful cleanup', error);
              if (!this.terminating) this.terminate();
            }),
            this.terminationFailure.promise,
          ]);
        }
        this.setPhase('native termination');
        await Promise.race([this.awaitNativeClosure(), this.terminationFailure.promise]);
      } catch (error) {
        if (!this.terminationFailed) throw error;
      }
      await this.closeServers();
      if (!this.terminationFailed) {
        this.setPhase('fixture removal');
        try { await dispose(); }
        catch (error) { this.record('fixture removal', error); }
      }
    } finally {
      this.finished = true;
      this.signal.removeEventListener('abort', this.abort);
    }
    if (this.failures.length) throw new AggregateError(this.failures, 'Native fixture cleanup failed');
  }
}
