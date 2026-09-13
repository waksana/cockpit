import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivateModuleJson } from './adapters.ts';
import { resolveCockpitUserRoot } from './catalog.ts';
import { privateModuleDirectory, writeModuleRecord } from './private-files.ts';
import { parseModuleServicePins, type ModuleServicePin } from './supervisor.ts';

type LifecycleState = 'captured' | 'restoring' | 'restored' | 'draining' | 'unknown';
interface LifecycleRecord {
  schemaVersion: 1;
  state: LifecycleState;
  generationId: string;
  operationId: string;
  services: ModuleServicePin[];
  updatedAt: string;
  error?: string;
}
export interface OwnedModuleLifecycleStatus {
  enabled: true;
  state: 'fresh' | LifecycleState;
  runnerReady: boolean;
  controlsRestored: boolean;
  operationId?: string;
  services: ModuleServicePin[];
  error?: string;
}
interface PendingLifecycle {
  responseType: 'module-runner-restore' | 'module-runner-drain';
  complete: 'restored' | 'stopped';
  operationId: string;
  acknowledge(): void;
  resolve(value: ModuleServicePin[]): void;
  reject(error: Error): void;
}
interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

function messageError(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1800);
}
function parseRecord(value: unknown): LifecycleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid owned module lifecycle record');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['schemaVersion', 'state', 'generationId', 'operationId', 'services', 'updatedAt', 'error'].includes(key))
    || raw.schemaVersion !== 1 || !['captured', 'restoring', 'restored', 'draining', 'unknown'].includes(String(raw.state))
    || typeof raw.generationId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.generationId)
    || typeof raw.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(raw.operationId)
    || typeof raw.updatedAt !== 'string' || raw.updatedAt.length > 40
    || (raw.error !== undefined && (typeof raw.error !== 'string' || !raw.error || raw.error.length > 1800))) {
    throw new Error('Invalid owned module lifecycle record');
  }
  return { schemaVersion: 1, state: raw.state as LifecycleState, generationId: raw.generationId,
    operationId: raw.operationId, services: parseModuleServicePins(raw.services), updatedAt: raw.updatedAt,
    ...(raw.error === undefined ? {} : { error: raw.error as string }) };
}

/**
 * Owns exactly one host-fenced module runner for this server process. It records
 * only captured module pins and lifecycle receipts; native runtime state is never copied.
 */
export class OwnedModuleLifecycle {
  readonly userRoot: string;
  private readonly recordPath: string;
  private readonly entry: string;
  private child?: ChildProcess;
  private generationId?: string;
  private runnerReady = false;
  private controlsRestored = false;
  private pending?: PendingLifecycle;
  private exit?: Promise<Exit>;
  private resolveExit?: (exit: Exit) => void;
  private expectedStop = false;
  private startCalled = false;
  private starting?: Promise<OwnedModuleLifecycleStatus>;

  constructor(private readonly options: {
    userRoot?: string;
    cockpitUrl: string;
    startupTimeoutMs?: number;
    acknowledgementTimeoutMs?: number;
  }) {
    this.userRoot = resolveCockpitUserRoot(options.userRoot);
    this.recordPath = join(this.userRoot, '.module-runner', 'owned-host-lifecycle.json');
    this.entry = fileURLToPath(new URL('./supervisor-entry.ts', import.meta.url));
    for (const [name, value] of Object.entries({
      startupTimeoutMs: options.startupTimeoutMs,
      acknowledgementTimeoutMs: options.acknowledgementTimeoutMs,
    })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 300_000)) {
        throw new Error(`Invalid ${name}`);
      }
    }
    new URL(options.cockpitUrl);
  }

  private read(): LifecycleRecord | undefined {
    return existsSync(this.recordPath) ? parseRecord(readPrivateModuleJson(this.recordPath)) : undefined;
  }
  private save(record: Omit<LifecycleRecord, 'schemaVersion' | 'updatedAt'>): LifecycleRecord {
    const value: LifecycleRecord = { schemaVersion: 1, ...record, updatedAt: new Date().toISOString() };
    writeModuleRecord(this.recordPath, value);
    return value;
  }
  private unknown(operationId: string, services: ModuleServicePin[], cause: unknown): void {
    const generationId = this.generationId ?? randomUUID();
    const error = messageError(cause);
    this.controlsRestored = false;
    this.save({ state: 'unknown', generationId, operationId, services, error });
  }
  status(): OwnedModuleLifecycleStatus {
    const record = this.read();
    return {
      enabled: true, state: record?.state ?? 'fresh', runnerReady: this.runnerReady,
      controlsRestored: this.controlsRestored, services: record?.services ?? [],
      ...(record ? { operationId: record.operationId } : {}),
      ...(record?.error ? { error: record.error } : {}),
    };
  }
  canReadRunner(): boolean { return this.runnerReady && Boolean(this.child); }

  private spawn(): Promise<void> {
    privateModuleDirectory(this.userRoot);
    const child = spawn(process.execPath, ['--import', 'tsx', this.entry,
      '--user-root', this.userRoot, '--cockpit-url', this.options.cockpitUrl, '--host-owned', 'true'], {
      cwd: dirname(dirname(this.entry)), stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { ...process.env, COCKPIT_USER_ROOT: this.userRoot },
    });
    this.child = child;
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timeout = setTimeout(() => readyReject(new Error('Owned module runner readiness is unknown; it was not killed or replaced')),
      this.options.startupTimeoutMs ?? 30_000);
    const finishExit = (exit: Exit): void => {
      if (this.child !== child) return;
      this.child = undefined;
      this.runnerReady = false;
      this.controlsRestored = false;
      const operationId = this.read()?.operationId ?? `host-exit-${randomUUID()}`;
      if (!this.expectedStop || exit.code !== 0 || exit.signal !== null || exit.error) {
        this.unknown(operationId, this.read()?.services ?? [], exit.error ?? 'Owned module runner exited unexpectedly; no automatic replacement or replay');
      }
      readyReject(new Error('Owned module runner exited before readiness'));
      this.pending?.reject(new Error('Owned module runner exited before a terminal lifecycle receipt'));
      this.pending = undefined;
      this.resolveExit?.(exit);
    };
    child.once('error', error => finishExit({ code: null, signal: null, error: error.message }));
    child.once('exit', (code, signal) => finishExit({ code, signal }));
    child.on('message', value => {
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid owned module runner IPC message');
        const raw = value as Record<string, unknown>;
        if (raw.type === 'module-runner-ready') {
          if (this.runnerReady || raw.apiVersion !== 1 || raw.lifecycleApi !== 1 || raw.pid !== child.pid
            || raw.socket !== join(this.userRoot, '.module-runner.sock')
            || Object.keys(raw).some(key => !['type', 'apiVersion', 'lifecycleApi', 'pid', 'socket'].includes(key))) {
            throw new Error('Owned module runner readiness identity/API mismatch');
          }
          this.runnerReady = true;
          readyResolve();
          return;
        }
        const pending = this.pending;
        if (!pending || raw.type !== pending.responseType || raw.operationId !== pending.operationId || raw.pid !== child.pid
          || !['accepted', pending.complete, 'refused', 'unknown'].includes(String(raw.state))
          || Object.keys(raw).some(key => !['type', 'operationId', 'pid', 'state', 'services', 'error'].includes(key))
          || (['refused', 'unknown'].includes(String(raw.state)) && (typeof raw.error !== 'string' || !raw.error))) {
          throw new Error('Owned module runner lifecycle receipt mismatch');
        }
        if (raw.state === 'accepted') {
          if (raw.services !== undefined || raw.error !== undefined) throw new Error('Accepted lifecycle receipt has terminal fields');
          pending.acknowledge();
          return;
        }
        if (raw.state === pending.complete) pending.resolve(parseModuleServicePins(raw.services));
        else pending.reject(new Error(raw.error as string));
        this.pending = undefined;
      } catch (error) {
        const operationId = this.pending?.operationId ?? this.read()?.operationId ?? `host-ipc-${randomUUID()}`;
        this.unknown(operationId, this.read()?.services ?? [], error);
        this.pending?.reject(error instanceof Error ? error : new Error(messageError(error)));
        this.pending = undefined;
      }
    });
    return ready.finally(() => clearTimeout(timeout));
  }

  private async request(type: 'restore-enabled' | 'drain-and-stop', operationId: string,
    services?: ModuleServicePin[]): Promise<ModuleServicePin[]> {
    const child = this.child;
    if (!child || !this.runnerReady || !child.connected || this.pending) {
      throw new Error('Owned module runner is not ready for a new lifecycle request');
    }
    const restoring = type === 'restore-enabled';
    return new Promise<ModuleServicePin[]>((resolve, reject) => {
      let acknowledged = false;
      const timer = setTimeout(() => {
        if (acknowledged) return;
        this.pending = undefined;
        reject(new Error('Owned module runner lifecycle acknowledgement is unknown; no retry or signal was sent'));
      }, this.options.acknowledgementTimeoutMs ?? 10_000);
      const settle = <T>(callback: (value: T) => void, value: T): void => {
        clearTimeout(timer);
        callback(value);
      };
      this.pending = {
        responseType: restoring ? 'module-runner-restore' : 'module-runner-drain',
        complete: restoring ? 'restored' : 'stopped', operationId,
        acknowledge: () => { acknowledged = true; clearTimeout(timer); },
        resolve: value => settle(resolve, value),
        reject: error => settle(reject, error),
      };
      child.send({ type, operationId, ...(restoring ? { services } : {}) }, error => {
        if (!error) return;
        this.pending = undefined;
        settle(reject, error);
      });
    });
  }

  startAfterReady(): Promise<OwnedModuleLifecycleStatus> {
    if (this.startCalled) throw new Error('Owned module runner startup is single-use');
    this.startCalled = true;
    this.starting = this.start();
    return this.starting;
  }

  private async start(): Promise<OwnedModuleLifecycleStatus> {
    const previous = this.read();
    const resumable = !previous || previous.state === 'captured';
    const services = previous?.services ?? [];
    const operationId = `host-restore-${randomUUID()}`;
    this.generationId = randomUUID();
    if (resumable) this.save({ state: 'restoring', generationId: this.generationId, operationId, services });
    else this.unknown(operationId, services,
      `Prior owned lifecycle is ${previous.state}; unknown restoration or child exit is never automatically replayed`);
    try {
      await this.spawn();
      if (!resumable) return this.status();
      const restored = await this.request('restore-enabled', operationId, services);
      if (JSON.stringify(restored) !== JSON.stringify(services)) {
        throw new Error('Restored module pins differ from the exact captured lifecycle plan');
      }
      this.controlsRestored = true;
      this.save({ state: 'restored', generationId: this.generationId, operationId, services: restored });
    } catch (error) {
      this.unknown(operationId, services, error);
    }
    return this.status();
  }

  async prepareExit(): Promise<void> {
    if (this.starting) await this.starting;
    const before = this.read();
    if (!before || !this.child || !this.runnerReady || !this.exit || !this.generationId) {
      throw new Error('Owned module runner exit cannot be confirmed');
    }
    const restorable = before.state === 'restored' && this.controlsRestored;
    const operationId = `host-drain-${randomUUID()}`;
    this.controlsRestored = false;
    this.save({ state: 'draining', generationId: this.generationId, operationId, services: before.services });
    try {
      const services = await this.request('drain-and-stop', operationId);
      this.expectedStop = true;
      const exit = await this.exit;
      if (exit.code !== 0 || exit.signal !== null || exit.error) throw new Error('Owned module runner did not exit cleanly after terminal drain receipt');
      if (restorable) this.save({ state: 'captured', generationId: this.generationId, operationId, services });
      else this.unknown(operationId, services, 'A previously unknown lifecycle was drained; its partial restoration is not automatically resumed');
    } catch (error) {
      this.unknown(operationId, before.services, error);
      throw error;
    }
  }
}
