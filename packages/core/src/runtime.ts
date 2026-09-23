import {
  CopilotClient, RuntimeConnection, approveAll,
  type CopilotClientOptions, type CopilotSession, type SessionConfig,
  type ResumeSessionConfig, type GetAuthStatusResponse,
} from '@github/copilot-sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import type { ModelOption } from '@cockpit/protocol';

export type RuntimeSession = CopilotSession;
export type RuntimeClient = Pick<CopilotClient,
  'start' | 'stop' | 'getStatus' | 'getAuthStatus' | 'listModels' | 'listSessions' |
  'createSession' | 'resumeSession' | 'deleteSession' | 'getSessionMetadata' | 'rpc'>;

export interface RuntimeOptions {
  clientOptions?: CopilotClientOptions;
  sessionConfig?: Partial<SessionConfig>;
  clientFactory?: (options: CopilotClientOptions) => RuntimeClient;
}

export function sessionModelOptions(values: readonly unknown[], catalog: readonly ModelOption[] = []): ModelOption[] {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return values.flatMap(value => {
    const model = record(value);
    if (typeof model.id !== 'string' || !model.id) throw new Error('Native session model inventory contains an invalid model ID');
    if (model.model_picker_enabled === false || record(model.policy).state === 'disabled') return [];
    const billing = record(model.billing);
    const pricesValue = billing.tokenPrices ?? billing.token_prices;
    const prices = record(pricesValue);
    const supports = record(record(model.capabilities).supports);
    const efforts = model.supportedReasoningEfforts !== undefined
      ? model.supportedReasoningEfforts : (supports.reasoningEffort === false ? [] : undefined);
    if (efforts !== undefined && (!Array.isArray(efforts) || !efforts.every(effort => typeof effort === 'string'))) {
      throw new Error(`Invalid reasoning metadata for native model ${model.id}`);
    }
    const fallback = catalog.find(entry => entry.modelId === model.id);
    const long = model.supportsLongContext;
    if (long !== undefined && typeof long !== 'boolean') throw new Error(`Invalid context metadata for native model ${model.id}`);
    const tiers = model.supportedContextTiers;
    if (tiers !== undefined && (!Array.isArray(tiers) || !tiers.every(tier => typeof tier === 'string'))) {
      throw new Error(`Invalid context tier metadata for native model ${model.id}`);
    }
    const defaultEffort = model.defaultReasoningEffort;
    if (defaultEffort !== undefined && typeof defaultEffort !== 'string') throw new Error(`Invalid default reasoning metadata for native model ${model.id}`);
    return [{
      modelId: model.id, name: typeof model.name === 'string' ? model.name : model.id,
      supportedReasoningEfforts: efforts ?? fallback?.supportedReasoningEfforts,
      defaultReasoningEffort: defaultEffort ?? fallback?.defaultReasoningEffort,
      supportsLongContext: long ?? (tiers !== undefined ? tiers.includes('long_context')
        : pricesValue !== undefined ? prices.longContext != null || prices.long_context != null : fallback?.supportsLongContext),
    }];
  });
}

/** One SDK-owned process. Only the native runtime decides automatic session cleanup. */
export class OfficialRuntime {
  private client?: RuntimeClient;
  private readonly live = new Map<string, RuntimeSession>();
  private readonly closed = new Set<string>();
  private readonly subscriptions = new Map<RuntimeSession, () => void>();
  private readonly bus = new EventEmitter();
  // Gates (SDK 1.0.13 contract):
  // - Client transitions (connect/stop) are exclusive: the SDK has one connection
  //   and stop() tears it down, so they wait for in-flight calls to drain and new
  //   calls wait for them. Everything else shares the connected client; JSON-RPC
  //   requests are multiplexed and safe to issue concurrently.
  // - Per-session gates order create/resume/attach/close/delete on one session ID:
  //   the SDK registry and this.live are keyed by ID, so each must observe the
  //   ownership change of the previous one (e.g. attach not_found vs. a resume).
  // - Different sessions' lifecycles need no mutual exclusion from the SDK client:
  //   its registries are keyed per session/registration. Engine.birth still
  //   serializes create/resume/fork globally as Engine admission policy.
  // Read-only probes (metadata, auth, list, models) take no gate beyond sharing.
  private transition?: Promise<void>;
  private inFlight = 0;
  private drained?: () => void;
  private readonly sessionGates = new Map<string, Promise<void>>();
  private failedStop?: Error;
  private fatalError?: Error;
  private stopping = false;
  private disconnecting?: Promise<void>;
  private childClosed?: Promise<void>;
  private readonly options: CopilotClientOptions;

  constructor(private readonly config: RuntimeOptions = {}) {
    const connection = config.clientOptions?.connection ?? RuntimeConnection.forStdio();
    if (connection.kind === 'inprocess') throw new Error('Cockpit requires an out-of-process runtime, not FFI');
    this.options = {
      mode: 'copilot-cli', useLoggedInUser: true,
      ...config.clientOptions, connection,
      sessionIdleTimeoutSeconds: config.clientOptions?.sessionIdleTimeoutSeconds ?? 1800,
    };
  }

  get liveCount(): number { return this.live.size; }
  get failure(): Error | undefined { return this.fatalError; }
  onFatal(handler: (error: Error) => void): () => void {
    this.bus.on('fatal', handler);
    return () => { this.bus.off('fatal', handler); };
  }
  onSessionClosed(handler: (session: RuntimeSession) => void): () => void {
    this.bus.on('closed', handler);
    return () => { this.bus.off('closed', handler); };
  }
  get rpc(): CopilotClient['rpc'] {
    if (this.failure) throw this.failure;
    if (!this.client || this.failedStop) throw new Error('Runtime is not connected');
    return this.client.rpc;
  }

  private clientTransition<T>(work: () => Promise<T>): Promise<T> {
    const next = (this.transition ?? Promise.resolve()).then(async () => {
      while (this.inFlight) await new Promise<void>(resolve => { this.drained = resolve; });
      return this.untilFatal(work);
    });
    const tail = next.then(() => {}, () => {});
    this.transition = tail;
    void tail.then(() => { if (this.transition === tail) this.transition = undefined; });
    return next;
  }

  /** Runs on the connected client, concurrently with other shared calls. */
  private shared<T>(work: () => Promise<T>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.transition || !this.client) {
      return (async () => {
        while (this.transition) await this.transition;
        if (!this.client) await this.start();
        return this.shared(work);
      })();
    }
    this.inFlight++;
    return this.untilFatal(work).finally(() => {
      if (--this.inFlight === 0) { const drained = this.drained; this.drained = undefined; drained?.(); }
    });
  }

  private perSession<T>(id: string | undefined, work: () => Promise<T>): Promise<T> {
    if (id === undefined) return work();
    const next = (this.sessionGates.get(id) ?? Promise.resolve()).then(work);
    const tail = next.then(() => {}, () => {});
    this.sessionGates.set(id, tail);
    void tail.then(() => { if (this.sessionGates.get(id) === tail) this.sessionGates.delete(id); });
    return next;
  }

  private async untilFatal<T>(work: () => Promise<T>): Promise<T> {
    if (this.failure) throw this.failure;
    let unsubscribe = () => {};
    const fatal = new Promise<never>((_, reject) => { unsubscribe = this.onFatal(reject); });
    try { return await Promise.race([work(), fatal]); }
    finally { unsubscribe(); }
  }

  start(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.client && !this.transition && !this.failedStop) return Promise.resolve();
    return this.clientTransition(() => this.connect());
  }

  private async connect(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.failedStop) throw this.failedStop;
    if (this.client) return;
    const client = (this.config.clientFactory ?? (options => new CopilotClient(options)))(this.options);
    this.client = client;
    try {
      await this.startClient(client);
      const status = await client.getStatus();
      if (status.version !== '1.0.83' || status.protocolVersion !== 3) {
        throw new Error(`Unvalidated Copilot runtime ${status.version} (protocol ${status.protocolVersion}); expected 1.0.83 / 3`);
      }
    } catch (error) {
      try { await this.disconnectClient(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Runtime startup and cleanup failed', { cause: cleanup }); }
      throw error;
    }
  }

  private async startClient(client: RuntimeClient): Promise<void> {
    // SDK 1.0.13 exposes no process-exit subscription. Observe Node's public spawn
    // lifecycle, scoped to this startup so another client's child cannot fail us.
    const scope = new AsyncLocalStorage<boolean>();
    const spawning = channel('child_process');
    const observe = (message: unknown) => {
      if (!scope.getStore()) return;
      const child = (message as { process: ChildProcess }).process;
      child.once('spawn', () => {
        if (!child.spawnargs.includes('--headless') || !child.spawnargs.includes('--no-auto-update')) return;
        this.childClosed = new Promise(resolve => { child.once('close', () => resolve()); });
        child.once('exit', (code, signal) => {
          if (this.stopping || this.client !== client) return;
          this.fail(new Error(`Copilot runtime exited unexpectedly (${signal ?? code}); host restart required; delivery may be uncertain`));
        });
      });
    };
    spawning.subscribe(observe);
    try { await scope.run(true, () => this.untilFatal(() => client.start())); }
    finally { spawning.unsubscribe(observe); scope.disable(); }
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.live.clear();
    this.closed.clear();
    this.bus.emit('fatal', error);
  }

  models(): Promise<ModelOption[]> {
    return this.shared(async () => {
      // The SDK convenience listModels() caches its first result. Use the public
      // request instead; catalog enrichment must not become a native-state copy.
      const models = this.config.clientOptions?.onListModels
        ? await this.config.clientOptions.onListModels()
        : (await this.rpc.models.list({})).models;
      return sessionModelOptions(models);
    });
  }

  listSessions() {
    return this.shared(() => this.client!.listSessions());
  }

  getSessionMetadata(id: string) {
    return this.shared(() => this.client!.getSessionMetadata(id));
  }

  /** Public SDK auth status; BYOK does not require a GitHub login. */
  getAuthStatus(): Promise<GetAuthStatusResponse> {
    return this.shared(() => this.client!.getAuthStatus());
  }

  /** Permanently deletes persisted data only after Engine has safely closed ownership. */
  deleteSession(id: string): Promise<void> {
    return this.shared(() => this.perSession(id, async () => {
      if (this.live.has(id)) throw new Error('Cannot delete a live session; Engine must safely close it first');
      try { await this.client!.deleteSession(id); }
      catch (error) {
        // A previous deletion may have succeeded before preference cleanup (or
        // its acknowledgement) failed. Confirm absence through the public API.
        let remaining;
        try { remaining = await this.client!.getSessionMetadata(id); }
        catch (lookup) { throw new AggregateError([error, lookup], 'Native deletion failed; session absence could not be confirmed', { cause: lookup }); }
        if (remaining) throw error;
      }
    }));
  }

  private sessionOptions(config: SessionConfig | ResumeSessionConfig): SessionConfig {
    const base = this.config.sessionConfig;
    for (const name of Object.keys(config.mcpServers ?? {})) {
      if (base?.mcpServers && Object.hasOwn(base.mcpServers, name)) {
        throw new Error(`Conflicting MCP configuration: ${name}`);
      }
    }
    if (base?.systemMessage && config.systemMessage && base.systemMessage.mode !== 'append') {
      throw new Error('Role instructions cannot replace a custom base system message');
    }
    return {
      streaming: true, includeSubAgentStreamingEvents: true,
      enableFileChangeTracking: true, manageScheduleEnabled: true,
      ...this.config.sessionConfig, ...config,
      mcpServers: { ...base?.mcpServers, ...config.mcpServers },
      ...(base?.systemMessage && config.systemMessage && base.systemMessage.mode === 'append'
        && config.systemMessage.mode === 'append' ? { systemMessage: {
          mode: 'append' as const, content: `${base.systemMessage.content}\n\n${config.systemMessage.content}`,
        } } : {}),
      tools: [...this.config.sessionConfig?.tools ?? [], ...config.tools ?? []],
      skillDirectories: [...new Set([
        ...this.config.sessionConfig?.skillDirectories ?? [],
        ...config.skillDirectories ?? [],
      ])],
      // The product deliberately has no interactive permission policy.
      onPermissionRequest: approveAll,
    };
  }

  createSession(config: SessionConfig): Promise<RuntimeSession> {
    return this.shared(() => this.perSession(config.sessionId, async () => {
      if (config.sessionId && this.live.has(config.sessionId)) throw new Error('Session is already owned by this runtime');
      const session = await this.client!.createSession(this.sessionOptions(config));
      this.own(session);
      return session;
    }));
  }

  resumeSession(id: string, config: ResumeSessionConfig): Promise<RuntimeSession> {
    return this.shared(() => this.perSession(id, async () => {
      if (this.live.has(id)) throw new Error('Session is already owned by this runtime');
      const session = await this.client!.resumeSession(id, this.sessionOptions(config));
      this.own(session);
      return session;
    }));
  }

  private own(session: RuntimeSession): void {
    if (this.failure) throw this.failure;
    this.live.set(session.sessionId, session);
    this.subscriptions.set(session, session.on(event => {
      if (event.type === 'session.shutdown') {
        // Notifications are advisory: shutdown may precede removal, and some
        // native cleanup paths emit no shutdown event at all.
        void this.isSessionLive(session).catch(() => {});
      }
    }));
  }

  /** A passive native attach probe, not activity, resume, or an idle heartbeat. */
  isSessionLive(session: RuntimeSession): Promise<boolean> {
    return this.shared(() => this.perSession(session.sessionId, async () => {
      if (this.live.get(session.sessionId) !== session) return false;
      const result = await this.rpc.sessions.open({ kind: 'attach', sessionId: session.sessionId });
      if (result.status === 'not_found') {
        this.closed.add(session.sessionId);
        await this.release(session);
        return false;
      }
      if (result.status !== 'resumed') throw new Error(`Native attach did not confirm session liveness: ${result.status}`);
      return true;
    }));
  }

  private async release(session: RuntimeSession): Promise<void> {
    await session.disconnect();
    this.subscriptions.get(session)?.();
    this.subscriptions.delete(session);
    this.live.delete(session.sessionId);
    this.closed.delete(session.sessionId);
    this.bus.emit('closed', session);
  }

  closeSession(session: RuntimeSession): Promise<void> {
    return this.shared(() => this.perSession(session.sessionId, async () => {
      if (this.live.get(session.sessionId) !== session) throw new Error('Session is not owned by this runtime');
      // Keep ownership on either failure, allowing a retry without claiming release.
      if (!this.closed.has(session.sessionId)) {
        await this.rpc.sessions.close({ sessionId: session.sessionId });
        this.closed.add(session.sessionId);
      }
      await this.release(session);
    }));
  }

  stop(): Promise<void> {
    if (this.failure) return this.disconnectClient();
    return this.clientTransition(async () => {
      if (this.live.size) throw new Error('Runtime still owns live sessions; close only confirmed idle sessions before stopping');
      await this.disconnectClient();
    });
  }

  private disconnectClient(): Promise<void> {
    this.disconnecting ??= this.stopClient().finally(() => { this.disconnecting = undefined; });
    return this.disconnecting;
  }

  private async stopClient(): Promise<void> {
    if (this.failedStop) throw this.failedStop;
    if (!this.client) return;
    this.stopping = true;
    try {
      // Once a child has died, let its pipes close before SDK cleanup. There is
      // no live execution to inspect or close, and no mutation is ever replayed.
      if (this.failure) await this.childClosed;
      const errors = await this.client.stop();
      if (errors.length) throw new AggregateError(errors, 'Native runtime shutdown did not complete cleanly');
      this.client = undefined;
      this.closed.clear();
      this.childClosed = undefined;
    } catch (error) {
      this.failedStop = error instanceof Error ? error : new Error(String(error));
      throw this.failedStop;
    } finally {
      this.stopping = false;
    }
  }
}
