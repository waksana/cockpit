import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ModuleCatalog, resolveCockpitUserRoot, type InstalledModule, type ModuleId } from './catalog.ts';
import { readLocalJson, readProtectedToken, validateAdapterConfig, type AdapterConfig } from './adapters.ts';
import { privateModuleDirectory, writeModuleRecord } from './private-files.ts';

export type ServiceModuleId = 'task' | 'wechat';
export type ModuleServiceAction = 'start' | 'stop' | 'apply';
export interface ModuleRunnerCommand {
  operationId: string;
  id: ServiceModuleId;
  action: ModuleServiceAction;
  version?: string;
  digest?: string;
  recoveryOf?: string;
  confirmRecovery?: true;
}
export interface ModuleRuntimeIdentity {
  moduleId: ServiceModuleId;
  moduleVersion: string;
  moduleDigest: string;
  instanceId: string;
}
export interface ModuleServicePin { id: ServiceModuleId; version: string; digest: string }
export function parseModuleServicePins(value: unknown): ModuleServicePin[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error('Restoration requires a bounded explicit service pin list');
  const seen = new Set<ServiceModuleId>();
  return value.map(item => {
    const raw = record(item);
    strict(raw, ['id', 'version', 'digest']);
    const id = serviceId(raw.id);
    if (seen.has(id)) throw new Error('Duplicate service restoration target');
    seen.add(id);
    return { id, version: version(raw.version), digest: digest(raw.digest) };
  });
}
export interface ModuleRunnerJob {
  schemaVersion: 1;
  command: ModuleRunnerCommand;
  phase: 'accepted' | 'running' | 'waiting' | 'done' | 'failed' | 'unknown';
  step: 'queued' | 'starting' | 'verifying' | 'draining' | 'waiting-exit' | 'complete';
  acceptedAt: string;
  updatedAt: string;
  reason?: string;
  result?: { state: 'running' | 'stopped'; identity?: ModuleRuntimeIdentity };
}
interface ServiceRecord {
  schemaVersion: 1;
  id: ServiceModuleId;
  state: 'starting' | 'running' | 'draining' | 'stopped' | 'failed' | 'unknown';
  operationId: string;
  identity?: ModuleRuntimeIdentity;
  serviceUrl?: string;
  pid?: number;
  reason?: string;
}
export interface ModuleRunnerStatus {
  id: ServiceModuleId;
  status: 'stopped' | 'starting' | 'running' | 'draining' | 'failed' | 'unknown';
  owned: boolean;
  recoveryRequired: boolean;
  canRecoverStop?: boolean;
  identity?: ModuleRuntimeIdentity;
  expectedIdentity?: ModuleRuntimeIdentity;
  pid?: number;
  expectedPid?: number;
  job?: ModuleRunnerJob;
  reason?: string;
}
export interface ModuleRunnerOptions {
  userRoot?: string;
  /** Trusted operator setting, never an IPC URL. Task must not silently connect to a guessed Cockpit port. */
  cockpitUrl?: string;
  /** Readiness deadline only: expiration records unknown and never kills the child. */
  startupTimeoutMs?: number;
  readinessIntervalMs?: number;
}
export interface ModuleLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
interface OwnedChild {
  child: ChildProcess;
  installed: InstalledModule;
  config: AdapterConfig;
  identity: ModuleRuntimeIdentity;
  exit: Promise<Exit>;
  exited?: Exit;
}
interface Exit { code: number | null; signal: NodeJS.Signals | null; error?: string }
type Request = { type: 'control'; command: ModuleRunnerCommand }
  | { type: 'status'; id: ServiceModuleId } | { type: 'job'; operationId: string };
const ids: ServiceModuleId[] = ['task', 'wechat'];
const terminal = new Set<ModuleRunnerJob['phase']>(['done', 'failed', 'unknown']);
const maxMessage = 64 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function strict(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown runner request or record field');
}
function string(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid runner string');
  return value;
}
function operation(value: unknown): string {
  const result = string(value, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/.test(result)) throw new Error('Invalid runner operationId');
  return result;
}
function serviceId(value: unknown): ServiceModuleId {
  if (value !== 'task' && value !== 'wechat') throw new Error('Only Task and WeChat have managed services');
  return value;
}
function version(value: unknown): string {
  const result = string(value, 80);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(result)) throw new Error('Invalid module version');
  return result;
}
function digest(value: unknown): string {
  const result = string(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('Invalid module digest');
  return result;
}
function identity(value: unknown): ModuleRuntimeIdentity {
  const raw = record(value);
  strict(raw, ['moduleId', 'moduleVersion', 'moduleDigest', 'instanceId']);
  return { moduleId: serviceId(raw.moduleId), moduleVersion: version(raw.moduleVersion),
    moduleDigest: digest(raw.moduleDigest), instanceId: operation(raw.instanceId) };
}
function command(value: unknown): ModuleRunnerCommand {
  const raw = record(value);
  strict(raw, ['operationId', 'id', 'action', 'version', 'digest', 'recoveryOf', 'confirmRecovery']);
  if (raw.action !== 'start' && raw.action !== 'stop' && raw.action !== 'apply') throw new Error('Invalid module service action');
  if ((raw.recoveryOf !== undefined || raw.confirmRecovery !== undefined)
    && (raw.action !== 'stop' || raw.recoveryOf === undefined || raw.confirmRecovery !== true)) {
    throw new Error('Explicit recovery can only request a confirmed safe stop');
  }
  return { operationId: operation(raw.operationId), id: serviceId(raw.id), action: raw.action,
    ...(raw.version === undefined ? {} : { version: version(raw.version) }),
    ...(raw.digest === undefined ? {} : { digest: digest(raw.digest) }),
    ...(raw.recoveryOf === undefined ? {} : { recoveryOf: operation(raw.recoveryOf), confirmRecovery: true }) };
}
function parseJob(value: unknown): ModuleRunnerJob {
  const raw = record(value);
  strict(raw, ['schemaVersion', 'command', 'phase', 'step', 'acceptedAt', 'updatedAt', 'reason', 'result']);
  if (raw.schemaVersion !== 1 || !['accepted', 'running', 'waiting', 'done', 'failed', 'unknown'].includes(String(raw.phase))
    || !['queued', 'starting', 'verifying', 'draining', 'waiting-exit', 'complete'].includes(String(raw.step))) {
    throw new Error('Unsupported runner job schema or phase');
  }
  const result = raw.result === undefined ? undefined : record(raw.result);
  if (result) {
    strict(result, ['state', 'identity']);
    if (result.state !== 'running' && result.state !== 'stopped') throw new Error('Invalid runner job result');
  }
  return {
    schemaVersion: 1, command: command(raw.command), phase: raw.phase as ModuleRunnerJob['phase'],
    step: raw.step as ModuleRunnerJob['step'], acceptedAt: string(raw.acceptedAt, 40), updatedAt: string(raw.updatedAt, 40),
    ...(raw.reason === undefined ? {} : { reason: string(raw.reason) }),
    ...(result ? { result: { state: result.state as 'running' | 'stopped',
      ...(result.identity === undefined ? {} : { identity: identity(result.identity) }) } } : {}),
  };
}
function parseService(value: unknown): ServiceRecord {
  const raw = record(value);
  strict(raw, ['schemaVersion', 'id', 'state', 'operationId', 'identity', 'serviceUrl', 'pid', 'reason']);
  if (raw.schemaVersion !== 1 || !['starting', 'running', 'draining', 'stopped', 'failed', 'unknown'].includes(String(raw.state))) {
    throw new Error('Unsupported runner service record');
  }
  if (raw.pid !== undefined && (typeof raw.pid !== 'number' || !Number.isSafeInteger(raw.pid) || raw.pid <= 0)) throw new Error('Invalid child PID');
  const url = raw.serviceUrl === undefined ? undefined
    : validateAdapterConfig(serviceId(raw.id), { serviceUrl: string(raw.serviceUrl) }).serviceUrl;
  return { schemaVersion: 1, id: serviceId(raw.id), state: raw.state as ServiceRecord['state'], operationId: operation(raw.operationId),
    ...(raw.identity === undefined ? {} : { identity: identity(raw.identity) }),
    ...(url === undefined ? {} : { serviceUrl: url }),
    ...(raw.pid === undefined ? {} : { pid: raw.pid as number }),
    ...(raw.reason === undefined ? {} : { reason: string(raw.reason) }) };
}
function parseRequest(value: unknown): Request {
  const raw = record(value);
  if (raw.type === 'control') { strict(raw, ['type', 'command']); return { type: 'control', command: command(raw.command) }; }
  if (raw.type === 'status') { strict(raw, ['type', 'id']); return { type: 'status', id: serviceId(raw.id) }; }
  if (raw.type === 'job') { strict(raw, ['type', 'operationId']); return { type: 'job', operationId: operation(raw.operationId) }; }
  throw new Error('Unknown runner request');
}
function privateJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxMessage || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
      throw new Error('Runner records must be bounded private regular files');
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function detail(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unconfirmed module operation').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1800);
}
function uncertain(message: string): Error { return Object.assign(new Error(message), { runnerOutcomeUnknown: true }); }
function isUncertain(error: unknown): boolean { return error instanceof Error && 'runnerOutcomeUnknown' in error; }
function socketPath(root: string): string {
  const path = join(root, '.module-runner.sock');
  if (Buffer.byteLength(path) > 103) throw new Error('Cockpit user root is too long for a Linux Unix-domain socket');
  return path;
}
function sameIdentity(value: Record<string, unknown>, expected: ModuleRuntimeIdentity): boolean {
  return value.moduleVersion === expected.moduleVersion && value.moduleDigest === expected.moduleDigest
    && value.instanceId === expected.instanceId
    && (value.version === undefined || value.version === expected.moduleVersion)
    && (value.moduleApi === undefined || value.moduleApi === 1)
    && (value.moduleId === undefined || value.moduleId === expected.moduleId);
}
async function runtimeIdentity(installed: InstalledModule, config: AdapterConfig, expected: ModuleRuntimeIdentity, healthy: boolean): Promise<void> {
  if (!installed.manifest.service) throw new Error('Module has no service');
  const [version, health] = await Promise.all([
    readLocalJson(config, installed.manifest.service.versionPath),
    readLocalJson(config, installed.manifest.service.healthPath),
  ]);
  if (version.moduleApi !== 1 || !sameIdentity(version, expected) || !sameIdentity(health, expected)
    || typeof health.ok !== 'boolean' || (healthy && !health.ok)) {
    throw new Error('Module version/health do not confirm the expected healthy same-instance release identity');
  }
}
async function portOccupied(url: string): Promise<boolean> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(parsed.port) });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(uncertain('Module port availability is unconfirmed')); });
    socket.once('error', error => {
      if ('code' in error && error.code === 'ECONNREFUSED') resolve(false);
      else reject(uncertain('Module port availability is unconfirmed'));
    });
  });
}

/** Local trusted launch construction, not an IPC command/argument passthrough. */
export function buildModuleLaunch(
  installed: InstalledModule, config: AdapterConfig, runtime: ModuleRuntimeIdentity, userRoot: string, cockpitUrl?: string,
): ModuleLaunch {
  const id = serviceId(installed.manifest.id);
  const validated = validateAdapterConfig(id, { ...config });
  if (validated.ownership !== 'managed' || !validated.activationEnabled || !validated.serviceUrl || !installed.manifest.service) {
    throw new Error('Managed activation, a loopback service URL and a declared service are required');
  }
  if (runtime.moduleId !== id || runtime.moduleVersion !== installed.manifest.version || runtime.moduleDigest !== installed.digest) {
    throw new Error('Launch identity does not match the verified release');
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    COCKPIT_USER_ROOT: userRoot, COCKPIT_MODULE_ID: id, COCKPIT_MODULE_VERSION: runtime.moduleVersion,
    COCKPIT_MODULE_DIGEST: runtime.moduleDigest, COCKPIT_MODULE_INSTANCE: runtime.instanceId,
    COCKPIT_MODULE_PORT: new URL(validated.serviceUrl).port,
  });
  const args = [join(installed.release, installed.manifest.service.entry), ...(installed.manifest.service.args ?? [])];
  if (id === 'task') {
    const host = cockpitUrl ?? process.env.COCKPIT_URL;
    if (!host) throw new Error('Managed Task requires an explicit runner cockpitUrl or COCKPIT_URL');
    const internalUrl = validateAdapterConfig('task', { serviceUrl: host }).serviceUrl;
    Object.assign(env, { WORK_PORT: env.COCKPIT_MODULE_PORT, WORK_DATA_DIR: validated.dataDirectory ?? join(userRoot, 'data', id),
      WORK_COCKPIT_MODULE_VERSION: runtime.moduleVersion, WORK_BASE_PATH: '/modules/task', COCKPIT_URL: internalUrl });
    if (process.env.COCKPIT_API_TOKEN) env.COCKPIT_API_TOKEN = process.env.COCKPIT_API_TOKEN;
    if (validated.managerCredentialFile) env.WORK_MODULE_MANAGER_CREDENTIAL = validated.managerCredentialFile;
    if (validated.credentialDirectory) env.WORK_CREDENTIAL_DIR = validated.credentialDirectory;
    if (validated.gatewayUrl) Object.assign(env, { WORK_MODULE_GATEWAY_URL: validated.gatewayUrl,
      COCKPIT_WEB_URL: validated.gatewayUrl, WORK_PUBLIC_URL: `${validated.gatewayUrl}/modules/task/` });
    if (process.env.WORK_GATEWAY_URL) env.WORK_GATEWAY_URL = validateAdapterConfig('task', { gatewayUrl: process.env.WORK_GATEWAY_URL }).gatewayUrl;
  } else {
    if (!validated.configFile) throw new Error('WeChat needs its explicit configFile reference');
    args.push('--config', validated.configFile);
  }
  return { executable: process.execPath, args, cwd: installed.release, env };
}

/** Separate process authority. Never starts during import or adopts a previous runner's children. */
export class ModuleSupervisor {
  readonly instanceId = randomUUID();
  readonly userRoot: string;
  readonly socketPath: string;
  private readonly catalog: ModuleCatalog;
  private readonly directory: string;
  private readonly jobs = new Map<string, ModuleRunnerJob>();
  private readonly services = new Map<ServiceModuleId, ServiceRecord>();
  private readonly children = new Map<ServiceModuleId, OwnedChild>();
  private readonly active = new Map<ServiceModuleId, Promise<void>>();
  private readonly sockets = new Set<Socket>();
  private server?: Server;
  private lockFd?: number;
  private closing = false;
  private closed = false;
  private fatal?: string;
  private constructor(private readonly options: ModuleRunnerOptions) {
    this.userRoot = resolveCockpitUserRoot(options.userRoot);
    this.socketPath = socketPath(this.userRoot);
    this.directory = join(this.userRoot, '.module-runner');
    this.catalog = new ModuleCatalog({ userRoot: this.userRoot });
    if (options.cockpitUrl !== undefined) validateAdapterConfig('task', { serviceUrl: options.cockpitUrl });
    for (const [name, value] of Object.entries({ startupTimeoutMs: options.startupTimeoutMs, readinessIntervalMs: options.readinessIntervalMs })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 300_000)) throw new Error(`Invalid ${name}`);
    }
  }
  static async start(options: ModuleRunnerOptions = {}): Promise<ModuleSupervisor> {
    const runner = new ModuleSupervisor(options);
    await runner.open();
    return runner;
  }
  private path(id: ServiceModuleId): string { return join(this.directory, 'services', `${id}.json`); }
  private jobPath(id: string): string { return join(this.directory, 'jobs', `${operation(id)}.json`); }
  private lockPath(): string { return join(this.userRoot, '.module-runner.lock'); }
  private saveJob(job: ModuleRunnerJob): void {
    this.jobs.set(job.command.operationId, job);
    writeModuleRecord(this.jobPath(job.command.operationId), job);
  }
  private saveService(service: ServiceRecord): void {
    this.services.set(service.id, service);
    writeModuleRecord(this.path(service.id), service);
  }
  private async open(): Promise<void> {
    if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24) {
      throw new Error('The independent module runner requires Linux x64 and Node 24');
    }
    privateModuleDirectory(this.userRoot);
    try {
      this.lockFd = openSync(this.lockPath(), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error('Module runner singleton lock exists; inspect the previous runner, never automatically steal its lock');
      }
      throw error;
    }
    try {
      writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid, instanceId: this.instanceId })); fsyncSync(this.lockFd);
      if (existsSync(this.socketPath)) throw new Error('Existing runner socket requires explicit inspection; it is not automatically removed');
      privateModuleDirectory(this.directory);
      privateModuleDirectory(join(this.directory, 'jobs'));
      privateModuleDirectory(join(this.directory, 'services'));
      const entries = readdirSync(join(this.directory, 'jobs'));
      if (entries.length > 10_000) throw new Error('Runner history limit reached; explicit archival is required');
      for (const entry of entries) {
        if (!entry.endsWith('.json')) throw new Error('Unexpected runner job file; inspect interrupted storage');
        const job = parseJob(privateJson(this.jobPath(entry.slice(0, -5))));
        if (job.command.operationId !== entry.slice(0, -5)) throw new Error('Runner job identity mismatch');
        if (!terminal.has(job.phase)) {
          job.phase = 'unknown'; job.reason = 'Runner was interrupted; no operation or child is automatically resumed';
          job.updatedAt = new Date().toISOString();
          this.saveJob(job);
        } else this.jobs.set(job.command.operationId, job);
      }
      for (const id of ids) {
        if (existsSync(this.path(id))) {
          const state = parseService(privateJson(this.path(id)));
          if (state.id !== id) throw new Error('Runner service identity mismatch');
          if (state.state !== 'stopped' && state.state !== 'failed') {
            state.state = 'unknown'; state.reason = 'Prior runner child is not owned or adopted; explicit recovery is required';
          }
          this.saveService(state);
        }
        const unfinished = [...this.jobs.values()].find(job => job.command.id === id && job.phase === 'unknown');
        if (unfinished && !this.services.has(id)) this.saveService({
          schemaVersion: 1, id, operationId: unfinished.command.operationId, state: 'unknown',
          reason: 'Interrupted durable operation has no confirmed child outcome',
        });
      }
      this.server = createServer(socket => this.connection(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(this.socketPath, () => { this.server!.off('error', reject); resolve(); });
      });
      chmodSync(this.socketPath, 0o600);
      this.server.on('error', error => { this.fatal = `Runner IPC failed: ${detail(error)}`; });
    } catch (error) {
      if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.releaseLock();
      throw error;
    }
  }
  private releaseLock(): void {
    if (this.lockFd !== undefined) {
      closeSync(this.lockFd); this.lockFd = undefined; unlinkSync(this.lockPath());
    }
  }
  private connection(socket: Socket): void {
    if (this.sockets.size >= 64) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setTimeout(10_000, () => socket.destroy());
    let buffer = Buffer.alloc(0), handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) { socket.destroy(); return; }
      if (buffer.length + chunk.length > maxMessage) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline === -1) return;
      handled = true;
      socket.setTimeout(30_000);
      void (async () => {
        if (buffer.subarray(newline + 1).length) throw new Error('One request per runner connection is required');
        const request = parseRequest(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
        const result = request.type === 'control' ? this.submit(request.command)
          : request.type === 'job' ? this.job(request.operationId) : await this.status(request.id);
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      })().catch(error => socket.end(`${JSON.stringify({ ok: false, error: detail(error) })}\n`));
    });
  }
  job(operationId: string): ModuleRunnerJob | null {
    return structuredClone(this.jobs.get(operation(operationId)) ?? null);
  }
  submit(input: ModuleRunnerCommand): ModuleRunnerJob {
    const request = command(input);
    const previous = this.jobs.get(request.operationId);
    if (previous) {
      if (JSON.stringify(previous.command) !== JSON.stringify(request)) throw new Error('Operation ID conflicts with a different runner command');
      return structuredClone(previous);
    }
    if (this.closed || this.closing || this.fatal) throw new Error(this.fatal ?? 'Module runner is closing');
    return this.accept(request);
  }
  private accept(request: ModuleRunnerCommand): ModuleRunnerJob {
    if (this.jobs.size >= 10_000) throw new Error('Runner history limit reached; explicit archival is required');
    if (this.active.has(request.id)) throw new Error('Module already has an active operation; inspect that operation rather than queue another');
    const previous = this.services.get(request.id);
    if (previous && (previous.state === 'unknown' || previous.state === 'failed')) {
      if (request.action !== 'stop' || request.recoveryOf !== previous.operationId || request.confirmRecovery !== true) {
        throw new Error('Module has an unresolved failed/unknown outcome; explicit recovery is required, not another start/apply');
      }
      const owned = this.children.get(request.id);
      if (!owned && previous.identity) throw new Error('The original child is not owned by this runner; host-side process reconciliation is required');
      if (owned?.exited && (owned.exited.code !== 0 || owned.exited.signal || owned.exited.error)) {
        throw new Error('Original child exit was not clean; host-side process reconciliation is required');
      }
    } else if (request.recoveryOf !== undefined) {
      throw new Error('Recovery no longer matches an unresolved service operation');
    }
    this.resolve(request);
    const now = new Date().toISOString();
    const job: ModuleRunnerJob = { schemaVersion: 1, command: request, phase: 'accepted', step: 'queued', acceptedAt: now, updatedAt: now };
    try { this.saveJob(job); } catch (error) {
      this.fatal = 'Could not durably accept the operation; inspect runner records before further control';
      throw error;
    }
    const task = Promise.resolve().then(() => this.execute(job)).catch(error => {
      this.fatal = `Runner persistence/outcome failure; inspect durable records: ${detail(error)}`;
    }).finally(() => this.active.delete(request.id));
    this.active.set(request.id, task);
    return structuredClone(job);
  }
  private resolve(request: ModuleRunnerCommand): { installed: InstalledModule; config: AdapterConfig } {
    const owned = this.children.get(request.id);
    if (request.action === 'stop' && owned) {
      const installed = this.catalog.getInstalled(request.id, owned.identity.moduleVersion);
      if (!installed || installed.digest !== owned.identity.moduleDigest) {
        throw uncertain('Running release files failed execution-boundary verification');
      }
      return { installed, config: owned.config };
    }
    const selected = this.catalog.getInstalled(request.id);
    if (!selected) throw new Error('Module must be installed, selected, and enabled');
    const installed = request.version === undefined ? selected : this.catalog.getInstalled(request.id, request.version);
    if (!installed || !installed.manifest.service) throw new Error('Requested immutable module service release is not installed');
    if (request.digest !== undefined && request.digest !== installed.digest) throw new Error('Requested module digest does not match installed bytes');
    const config = validateAdapterConfig(request.id, this.catalog.readConfig(request.id, installed.manifest.configVersion).values);
    if (config.ownership !== 'managed') throw new Error('Runner refuses external or unowned module services');
    if (!config.serviceUrl) throw new Error('Managed service requires an explicit loopback service URL');
    if (Number(new URL(config.serviceUrl).port) === 0) throw new Error('Managed service port must be fixed and nonzero');
    if (request.action !== 'stop' && !config.activationEnabled) throw new Error('Module activationEnabled is false; no startup is allowed');
    if (request.id === 'task') {
      if (!config.managerCredentialFile) throw new Error('Managed Task requires its protected module-manager credential reference for safe drain');
      readProtectedToken(config.managerCredentialFile);
    }
    if (owned && !owned.exited && owned.config.serviceUrl !== config.serviceUrl) {
      throw new Error('Service URL changed since launch; existing child must be explicitly reconciled before control');
    }
    return { installed, config };
  }
  private progress(job: ModuleRunnerJob, phase: ModuleRunnerJob['phase'], step: ModuleRunnerJob['step'], reason?: string): void {
    job.phase = phase; job.step = step; job.updatedAt = new Date().toISOString();
    if (reason) job.reason = reason; else delete job.reason;
    this.saveJob(job);
  }
  private async execute(job: ModuleRunnerJob): Promise<void> {
    const request = job.command;
    try {
      const { installed, config } = this.resolve(request);
      this.progress(job, 'running', request.action === 'stop' ? 'draining' : 'starting');
      const existing = this.children.get(request.id);
      if (request.action === 'stop') {
        if (existing && !existing.exited) await this.drain(existing, job);
        else {
          if (await portOccupied(config.serviceUrl!)) throw uncertain('Service endpoint is occupied by an unowned process; runner will not stop it');
          this.saveService({ schemaVersion: 1, id: request.id, operationId: request.operationId, state: 'stopped' });
        }
        job.result = { state: 'stopped' };
      } else {
        if (existing && !existing.exited) {
          if (request.action === 'start') {
            if (existing.identity.moduleVersion !== installed.manifest.version || existing.identity.moduleDigest !== installed.digest) {
              throw new Error('An owned different release is running; use explicit apply rather than start');
            }
            await runtimeIdentity(existing.installed, existing.config, existing.identity, true);
            job.result = { state: 'running', identity: existing.identity };
            this.progress(job, 'done', 'complete');
            return;
          }
          await this.drain(existing, job);
        }
        // Re-read selection/config and hash target again after an arbitrarily long drain.
        const current = this.resolve(request);
        if (current.installed.digest !== installed.digest || current.installed.manifest.version !== installed.manifest.version) {
          throw uncertain('Target selection changed while draining; no replacement child was started');
        }
        const launched = await this.launch(current.installed, current.config, job);
        job.result = { state: 'running', identity: launched.identity };
      }
      this.progress(job, 'done', 'complete');
    } catch (error) {
      const owned = this.children.get(request.id);
      const phase = isUncertain(error) || (owned && !owned.exited) ? 'unknown' : 'failed';
      const prior = this.services.get(request.id);
      delete job.result;
      job.phase = phase; job.reason = detail(error); job.updatedAt = new Date().toISOString();
      let persistenceError: unknown;
      try {
        this.saveService({ ...prior, schemaVersion: 1, id: request.id, operationId: request.operationId, state: phase, reason: detail(error) });
      } catch (failure) { persistenceError = failure; }
      try { this.saveJob(job); } catch (failure) { persistenceError = failure; }
      if (persistenceError) throw uncertain(`Could not persist the unconfirmed operation outcome: ${detail(persistenceError)}`);
    }
  }
  private async launch(installed: InstalledModule, config: AdapterConfig, job: ModuleRunnerJob): Promise<OwnedChild> {
    const id = serviceId(installed.manifest.id);
    if (await portOccupied(config.serviceUrl!)) throw uncertain('Service endpoint is already occupied; no external process will be adopted');
    const runtime: ModuleRuntimeIdentity = {
      moduleId: id, moduleVersion: installed.manifest.version, moduleDigest: installed.digest, instanceId: randomUUID(),
    };
    const spec = buildModuleLaunch(installed, config, runtime, this.userRoot, this.options.cockpitUrl);
    privateModuleDirectory(config.dataDirectory ?? this.catalog.dataDirectory(id));
    privateModuleDirectory(this.catalog.logsDirectory(id));
    this.progress(job, 'running', 'starting');
    this.saveService({ schemaVersion: 1, id, operationId: job.command.operationId, state: 'starting', identity: runtime, serviceUrl: config.serviceUrl });
    const logPath = join(this.catalog.logsDirectory(id), `${job.command.operationId}.log`);
    const log = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let child: ChildProcess;
    try { child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', log, log], shell: false }); }
    finally { closeSync(log); }
    let exited!: (exit: Exit) => void;
    const owned: OwnedChild = { child, installed, config, identity: runtime, exit: new Promise(resolve => { exited = resolve; }) };
    const finish = (result: Exit): void => {
      if (owned.exited) return;
      owned.exited = result; exited(result);
      const state = this.services.get(id);
      if (state?.state === 'running') {
        try {
          this.saveService({ ...state, state: 'failed', reason: `Owned child exited unexpectedly (${result.code ?? result.signal ?? result.error ?? 'unknown'})` });
        } catch (error) { this.fatal = `Cannot persist child exit: ${detail(error)}`; }
      }
    };
    child.once('error', error => finish({ code: null, signal: null, error: detail(error) }));
    child.once('exit', (code, signal) => finish({ code, signal }));
    this.children.set(id, owned);
    this.saveService({ schemaVersion: 1, id, operationId: job.command.operationId, state: 'starting', identity: runtime,
      serviceUrl: config.serviceUrl, ...(child.pid === undefined ? {} : { pid: child.pid }) });
    this.progress(job, 'running', 'verifying');
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    for (;;) {
      if (owned.exited) throw new Error(`Owned child exited before readiness (${owned.exited.code ?? owned.exited.signal ?? owned.exited.error ?? 'unknown'})`);
      try {
        await runtimeIdentity(installed, config, runtime, true);
        if (owned.exited) throw new Error('Owned child exited during readiness verification');
        this.saveService({ schemaVersion: 1, id, operationId: job.command.operationId, state: 'running',
          identity: runtime, serviceUrl: config.serviceUrl, pid: child.pid });
        return owned;
      } catch (error) {
        const finalExit = this.children.get(id)?.exited;
        if (finalExit) throw new Error(`Owned child exited during startup (${finalExit.code ?? finalExit.error ?? 'unknown'})`);
        if (Date.now() >= deadline) throw uncertain(`Readiness is unconfirmed; child was not killed or restarted: ${detail(error)}`);
        await Promise.race([sleep(this.options.readinessIntervalMs ?? 100), owned.exit]);
      }
    }
  }
  private async drain(owned: OwnedChild, job: ModuleRunnerJob): Promise<void> {
    if (owned.exited) throw uncertain('Owned child exited before drain; no drain was replayed');
    const installed = this.catalog.getInstalled(owned.identity.moduleId, owned.identity.moduleVersion);
    if (!installed || installed.digest !== owned.identity.moduleDigest) throw uncertain('Running release files failed execution-boundary verification');
    await runtimeIdentity(installed, owned.config, owned.identity, job.command.recoveryOf === undefined);
    this.progress(job, 'running', 'draining');
    this.saveService({ schemaVersion: 1, id: owned.identity.moduleId, operationId: job.command.operationId, state: 'draining',
      identity: owned.identity, serviceUrl: owned.config.serviceUrl, pid: owned.child.pid });
    try {
      const response = await readLocalJson(owned.config, installed.manifest.service!.drainPath, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(owned.identity.moduleId === 'task' && owned.config.managerCredentialFile
            ? { authorization: `Bearer ${readProtectedToken(owned.config.managerCredentialFile)}` } : {}) },
        body: JSON.stringify({ pending: true }),
      });
      if (!sameIdentity(response, owned.identity)) {
        if (['instanceId', 'moduleVersion', 'moduleDigest'].some(key => key in response)) {
          throw new Error('Drain acknowledgement identifies a different or incomplete module instance');
        }
        // An immediate clean exit may race the next read, so the drain acknowledgement itself carries identity.
        await runtimeIdentity(installed, owned.config, owned.identity, false);
      }
    } catch (error) {
      throw uncertain(`Drain outcome is unconfirmed; no retry, signal or replacement was issued: ${detail(error)}`);
    }
    this.progress(job, 'waiting', 'waiting-exit', 'Waiting for the owned child to finish its existing lifecycle drain; no force deadline');
    const result = await owned.exit;
    if (result.code !== 0 || result.signal || result.error) throw uncertain('Owned child drain exit was not clean; no replacement was started');
    this.saveService({ schemaVersion: 1, id: owned.identity.moduleId, operationId: job.command.operationId,
      state: 'stopped', identity: owned.identity, serviceUrl: owned.config.serviceUrl });
    this.children.delete(owned.identity.moduleId);
  }
  async status(id: ServiceModuleId): Promise<ModuleRunnerStatus> {
    serviceId(id);
    const state = this.services.get(id), owned = this.children.get(id);
    const latest = [...this.jobs.values()].reverse().find(value => value.command.id === id);
    const job = latest ? structuredClone(latest) : state ? this.job(state.operationId) : undefined;
    const base = { id, owned: Boolean(owned && !owned.exited), recoveryRequired: Boolean(this.fatal || state?.state === 'failed' || state?.state === 'unknown'),
      canRecoverStop: Boolean(!this.fatal && !this.active.has(id) && state && ['failed', 'unknown'].includes(state.state)
        && (owned ? !owned.exited || (owned.exited.code === 0 && !owned.exited.signal && !owned.exited.error) : !state.identity)),
      ...(owned && !owned.exited && owned.child.pid !== undefined ? { pid: owned.child.pid }
        : state?.pid === undefined ? {} : { expectedPid: state.pid }), ...(job ? { job } : {}) };
    if (this.fatal) return { ...base, status: 'unknown', reason: this.fatal };
    if (!state) {
      try {
        const installed = this.catalog.getInstalled(id);
        if (!installed) return { ...base, status: 'stopped', reason: 'No enabled managed release and no child owned by this runner' };
        const config = validateAdapterConfig(id, this.catalog.readConfig(id, installed.manifest.configVersion).values);
        if (config.serviceUrl && await portOccupied(config.serviceUrl)) return { ...base, status: 'unknown', reason: 'Service endpoint is occupied but no child is owned' };
        return { ...base, status: 'stopped', reason: 'No owned child; configured loopback endpoint has no listener' };
      } catch (error) { return { ...base, status: 'unknown', reason: detail(error) }; }
    }
    if (!owned || owned.exited) {
      const expected = { ...base, ...(state.identity ? { expectedIdentity: state.identity } : {}) };
      if (state.serviceUrl && state.identity) {
        try {
          if (await portOccupied(state.serviceUrl)) {
            const installed = this.catalog.getInstalled(id, state.identity.moduleVersion);
            if (!installed || installed.digest !== state.identity.moduleDigest) throw new Error('Historical release identity is unconfirmed');
            await runtimeIdentity(installed, { ownership: 'managed', activationEnabled: false, serviceUrl: state.serviceUrl }, state.identity, true);
            return { ...expected, status: 'running', identity: state.identity, recoveryRequired: true,
              reason: 'Upstream identity is live, but this runner does not own or adopt that process' };
          }
        } catch (error) { return { ...expected, status: 'unknown', reason: detail(error) }; }
      }
      return { ...expected, status: state.state === 'stopped' ? 'stopped' : state.state === 'failed' ? 'failed' : 'unknown',
        ...(state.reason ? { reason: state.reason } : {}) };
    }
    try {
      await runtimeIdentity(owned.installed, owned.config, owned.identity, state.state !== 'draining');
      return { ...base, status: state.state === 'draining' ? 'draining' : 'running', identity: owned.identity,
        ...(state.reason ? { reason: state.reason } : {}) };
    } catch (error) {
      if (state.state === 'running' && !owned.exited) {
        try { this.saveService({ ...state, state: 'unknown', reason: `Runtime health/identity became unconfirmed: ${detail(error)}` }); }
        catch (failure) { this.fatal = `Could not persist runtime health uncertainty: ${detail(failure)}`; }
      }
      return { ...base, recoveryRequired: base.recoveryRequired || (state.state === 'running' && !owned.exited),
        status: state.state === 'starting' ? 'starting' : 'unknown', reason: this.fatal ?? detail(error) };
    }
  }
  async restoreEnabled(operationId: string, raw: unknown, accepted: () => Promise<void>): Promise<ModuleServicePin[]> {
    operation(operationId);
    if (this.closed || this.closing || this.fatal || this.active.size) throw new Error(this.fatal ?? 'Runner has active lifecycle work');
    const pins = parseModuleServicePins(raw);
    this.closing = true;
    try {
      const recovered = new Set([...this.jobs.values()].filter(job => job.phase === 'done' && job.command.action === 'stop')
        .map(job => job.command.recoveryOf));
      const targets: ModuleRunnerCommand[] = [];
      for (const pin of pins) {
        const { id } = pin;
        if ([...this.jobs.values()].some(job => job.command.id === id && job.phase === 'unknown' && !recovered.has(job.command.operationId))) {
          throw new Error(`Module ${id} has an unresolved operation; startup never retries it`);
        }
        const request: ModuleRunnerCommand = { ...pin, action: 'start',
          operationId: `host-start-${createHash('sha256').update(`${operationId}:${id}`).digest('hex').slice(0, 48)}` };
        if (this.jobs.has(request.operationId)) throw new Error('Restoration job already exists; inspect it without replay');
        this.resolve(request);
        const state = await this.status(id);
        if (state.recoveryRequired || !['stopped', 'running'].includes(state.status)) throw new Error(`Module ${id} is not safe to restore`);
        if (state.owned && (state.identity?.moduleVersion !== pin.version || state.identity.moduleDigest !== pin.digest)) {
          throw new Error('An already-owned service differs from its captured release; explicit apply is required');
        }
        targets.push(request);
      }
      await accepted();
      for (const request of targets) {
        this.accept(request);
        await this.active.get(request.id);
        const job = this.jobs.get(request.operationId);
        if (job?.phase !== 'done' || job.result?.state !== 'running') {
          throw new Error(`Module restoration is unconfirmed: ${job?.reason ?? request.id}`);
        }
      }
      return pins;
    } finally { this.closing = false; }
  }
  async drainAndStop(operationId: string, accepted: () => Promise<void>): Promise<ModuleServicePin[]> {
    let services: ModuleServicePin[] = [];
    await this.close({ drain: true, operationId, accepted, capture: pins => { services = pins; } });
    return services;
  }
  /** No signals. A draining child may keep this promise pending indefinitely. */
  async close(options: { drain?: boolean; operationId?: string; accepted?: () => Promise<void>;
    capture?: (pins: ModuleServicePin[]) => void } = {}): Promise<void> {
    if (this.closed) return;
    if (this.closing) throw new Error('Runner shutdown is already in progress');
    if (!options.drain && (this.active.size || [...this.children.values()].some(child => !child.exited))) {
      throw new Error('Runner still owns active children/jobs; request ordinary graceful drain first');
    }
    this.closing = true;
    try {
      if (options.drain) {
        const lifecycleId = operation(options.operationId ?? randomUUID());
        await options.accepted?.();
        await Promise.all([...this.active.values()]);
        options.capture?.(ids.flatMap(id => {
          const owned = this.children.get(id);
          return owned && !owned.exited ? [{ id, version: owned.identity.moduleVersion, digest: owned.identity.moduleDigest }] : [];
        }));
        for (const id of ids) {
          const child = this.children.get(id);
          if (child && !child.exited) {
            const childOperation = `host-stop-${createHash('sha256').update(`${lifecycleId}:${id}`).digest('hex').slice(0, 48)}`;
            if (this.jobs.has(childOperation)) throw new Error('Host drain job already exists; inspect it without replay');
            this.accept({ id, action: 'stop', operationId: childOperation });
            await this.active.get(id);
            if (!child.exited) throw new Error('Child outcome remains unconfirmed; runner refuses to exit');
            if (this.jobs.get(childOperation)?.phase !== 'done') throw new Error('Owned child drain completion is not confirmed');
          }
        }
      }
      for (const socket of this.sockets) socket.destroy();
      if (this.server?.listening) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
      // Node removes its own Unix socket when closing the listening server.
      this.releaseLock();
      this.closed = true;
    } finally { this.closing = false; }
  }
}

export async function startModuleSupervisor(options: ModuleRunnerOptions = {}): Promise<ModuleSupervisor> {
  return ModuleSupervisor.start(options);
}
export class ModuleRunnerClient {
  readonly userRoot: string;
  readonly socketPath: string;
  constructor(options: { userRoot?: string; timeoutMs?: number } = {}) {
    this.userRoot = resolveCockpitUserRoot(options.userRoot); this.socketPath = socketPath(this.userRoot);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) throw new Error('Invalid runner IPC timeout');
  }
  private readonly timeoutMs: number;
  private async request(request: Request): Promise<unknown> {
    privateModuleDirectory(this.userRoot);
    const stat = lstatSync(this.socketPath);
    if (!stat.isSocket() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Runner IPC requires a private owner-only Unix socket');
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = Buffer.alloc(0), settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true; socket.destroy();
        reject(request.type === 'control'
          ? Object.assign(uncertain(`Runner receipt for ${request.command.operationId} is unconfirmed; inspect this operationId, never replay: ${detail(error)}`),
            { operationId: request.command.operationId }) : error);
      };
      socket.setTimeout(this.timeoutMs, () => fail(new Error('Runner IPC timeout')));
      socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.once('error', fail);
      socket.once('end', () => { if (!settled) fail(new Error('Runner closed before a complete receipt')); });
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (buffer.length + chunk.length > maxMessage) return fail(new Error('Runner IPC result exceeds limit'));
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        try {
          const response = record(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
          if (response.ok === false) {
            settled = true; socket.destroy(); reject(new Error(string(response.error))); return;
          }
          if (response.ok !== true) throw new Error('Invalid runner IPC response');
          settled = true; socket.destroy(); resolve(response.result);
        } catch (error) { fail(error); }
      });
    });
  }
  async submit(input: ModuleRunnerCommand): Promise<ModuleRunnerJob> {
    return parseJob(await this.request({ type: 'control', command: command(input) }));
  }
  async job(operationId: string): Promise<ModuleRunnerJob | null> {
    const result = await this.request({ type: 'job', operationId: operation(operationId) });
    return result === null ? null : parseJob(result);
  }
  async status(id: ServiceModuleId): Promise<ModuleRunnerStatus> {
    const raw = record(await this.request({ type: 'status', id: serviceId(id) }));
    strict(raw, ['id', 'status', 'owned', 'recoveryRequired', 'canRecoverStop', 'identity', 'expectedIdentity', 'pid', 'expectedPid', 'job', 'reason']);
    if (!['stopped', 'starting', 'running', 'draining', 'failed', 'unknown'].includes(String(raw.status))
      || typeof raw.owned !== 'boolean' || typeof raw.recoveryRequired !== 'boolean'
      || (raw.canRecoverStop !== undefined && typeof raw.canRecoverStop !== 'boolean')
      || [raw.pid, raw.expectedPid].some(value => value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0))) {
      throw new Error('Invalid runner status');
    }
    return { id: serviceId(raw.id), status: raw.status as ModuleRunnerStatus['status'], owned: raw.owned, recoveryRequired: raw.recoveryRequired,
      ...(raw.canRecoverStop === undefined ? {} : { canRecoverStop: raw.canRecoverStop }),
      ...(raw.identity === undefined ? {} : { identity: identity(raw.identity) }), ...(raw.pid === undefined ? {} : { pid: raw.pid as number }),
      ...(raw.expectedIdentity === undefined ? {} : { expectedIdentity: identity(raw.expectedIdentity) }),
      ...(raw.expectedPid === undefined ? {} : { expectedPid: raw.expectedPid as number }),
      ...(raw.job === undefined ? {} : { job: parseJob(raw.job) }), ...(raw.reason === undefined ? {} : { reason: string(raw.reason) }) };
  }
  /** Configuration is deliberately NOT sent over IPC; the independent runner rereads trusted disk configuration. */
  async control(id: ModuleId, action: ModuleServiceAction, installed: InstalledModule, _config?: AdapterConfig): Promise<ModuleRunnerJob> {
    return this.submit({ id: serviceId(id), action, operationId: randomUUID(),
      ...(action === 'stop' ? {} : { version: installed.manifest.version, digest: installed.digest }) });
  }
}
