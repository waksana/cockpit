import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { SessionDeletionPlan, SessionUnbindApproval } from '@cockpit/protocol';
import { ModuleCatalog, type ModuleId } from './catalog.ts';
import { validateAdapterConfig } from './adapters.ts';
import { privateModuleDirectory, writeModuleRecord } from './private-files.ts';

interface Target {
  moduleId: ModuleId;
  name: string;
  version: string;
  digest: string;
  entry: string;
  args: string[];
  configVersion: number;
  configRevision: number;
  configFile: string;
}
interface Snapshot {
  sessionId: string;
  planId: string;
  bindingRevision: number;
  targets: Target[];
}
interface Receipt {
  schemaVersion: 1;
  snapshot: Snapshot;
  operationId: string;
  state: NonNullable<SessionDeletionPlan['state']>;
  completedModules: ModuleId[];
  attemptId?: string;
  executorPid?: number;
  childPid?: number;
  error?: string;
}
class RemovalFailure extends Error {
  readonly moduleOutcomeUnknown: boolean;
  constructor(readonly code: string, unknown = false) {
    super(code);
    this.moduleOutcomeUnknown = unknown;
  }
}
const active = new Map<string, string>();
const children = new Map<string, number>();
const maxBytes = 64 * 1024;
const moduleIds: ModuleId[] = ['assistant', 'task', 'wechat'];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
}
function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  }
  return value;
}
function identifier(value: unknown): string {
  const result = text(value, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) throw new RemovalFailure('INVALID_SESSION_ID');
  return result;
}
function operationId(value: unknown): string {
  const result = text(value, 120);
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(result)) throw new RemovalFailure('INVALID_REMOVAL_OPERATION_ID');
  return result;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  return value;
}
function moduleId(value: unknown): ModuleId {
  if (value !== 'assistant' && value !== 'task' && value !== 'wechat') throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  return value;
}
function sha(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  return result;
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function planId(snapshot: Omit<Snapshot, 'planId'>): string { return hash({ schemaVersion: 1, ...snapshot }); }
function path(value: unknown): string {
  const result = text(value);
  if (!isAbsolute(result) || resolve(result) !== result) throw new RemovalFailure('INVALID_REMOVAL_CONFIG_REFERENCE');
  return result;
}
function parseTarget(value: unknown): Target {
  const raw = object(value);
  keys(raw, ['moduleId', 'name', 'version', 'digest', 'entry', 'args', 'configVersion', 'configRevision', 'configFile']);
  const entry = text(raw.entry, 1024);
  if (!/^[A-Za-z0-9_@.+/-]+\.(?:js|mjs|cjs)$/.test(entry)
    || entry.split('/').some(part => !part || part === '.' || part === '..')) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  if (!Array.isArray(raw.args) || raw.args.length > 64 || !raw.args.every(value => typeof value === 'string' && value.length <= 2048)) {
    throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  }
  return { moduleId: moduleId(raw.moduleId), name: text(raw.name, 200), version: text(raw.version, 80),
    digest: sha(raw.digest), entry, args: raw.args, configVersion: integer(raw.configVersion, 1),
    configRevision: integer(raw.configRevision), configFile: path(raw.configFile) };
}
function parseReceipt(value: unknown, sessionId: string): Receipt {
  const raw = object(value);
  keys(raw, ['schemaVersion', 'snapshot', 'operationId', 'state', 'completedModules', 'attemptId', 'executorPid', 'childPid', 'error']);
  if (raw.schemaVersion !== 1) throw new RemovalFailure('UNSUPPORTED_REMOVAL_SCHEMA');
  const stored = object(raw.snapshot);
  keys(stored, ['sessionId', 'planId', 'bindingRevision', 'targets']);
  if (stored.sessionId !== sessionId || !Array.isArray(stored.targets) || stored.targets.length > 3) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  const snapshot: Snapshot = { sessionId, planId: sha(stored.planId), bindingRevision: integer(stored.bindingRevision),
    targets: stored.targets.map(parseTarget) };
  const expected = planId({ sessionId, bindingRevision: snapshot.bindingRevision, targets: snapshot.targets });
  if (snapshot.planId !== expected || new Set(snapshot.targets.map(target => target.moduleId)).size !== snapshot.targets.length) {
    throw new RemovalFailure('REMOVAL_PLAN_INTEGRITY_MISMATCH');
  }
  const parsed = SessionDeletionPlan.safeParse({
    sessionId, planId: snapshot.planId,
    modules: snapshot.targets.map(({ moduleId, name, version }) => ({ moduleId, name, version })),
    operationId: operationId(raw.operationId), state: raw.state, completedModules: raw.completedModules, error: raw.error,
  });
  if (!parsed.success) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  const publicPlan = parsed.data;
  if (!publicPlan.state || !publicPlan.completedModules
    || new Set(publicPlan.completedModules).size !== publicPlan.completedModules.length
    || publicPlan.completedModules.some(id => !snapshot.targets.some(target => target.moduleId === id))
    || (['unbound', 'deleted'].includes(publicPlan.state) && publicPlan.completedModules.length !== snapshot.targets.length)) {
    throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  }
  const error = raw.error === undefined ? undefined : text(raw.error, 160);
  if (error && !/^[A-Z][A-Z0-9_: -]*$/.test(error)) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  const receipt: Receipt = {
    schemaVersion: 1, snapshot, operationId: operationId(raw.operationId), state: publicPlan.state,
    completedModules: publicPlan.completedModules,
    ...(raw.attemptId === undefined ? {} : { attemptId: identifier(raw.attemptId) }),
    ...(raw.executorPid === undefined ? {} : { executorPid: integer(raw.executorPid, 1) }),
    ...(raw.childPid === undefined ? {} : { childPid: integer(raw.childPid, 1) }),
    ...(error === undefined ? {} : { error }),
  };
  if (receipt.state === 'working' && (!receipt.attemptId || !receipt.executorPid)) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
  return receipt;
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (hasCode(error, 'ESRCH')) return false;
    throw new RemovalFailure('REMOVAL_EXECUTOR_UNCONFIRMED', true);
  }
}
function privateFile(file: string): void {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || stat.uid !== process.getuid?.() || realpathSync(file) !== file) throw new Error('Invalid reference');
  } catch { throw new RemovalFailure('INVALID_REMOVAL_CONFIG_REFERENCE'); }
}

/** Optional module-owned unbind only. Native deletion and catalog binding cleanup remain the host's responsibility. */
export class ModuleSessionRemoval {
  private readonly settledListeners = new Set<() => void>();
  constructor(private readonly catalog: ModuleCatalog) {}
  activeCount(): number {
    const prefix = `${this.directory()}/`;
    return new Set([...active.keys(), ...children.keys()].filter(key => key.startsWith(prefix))).size;
  }
  onSettled(listener: () => void): () => void {
    this.settledListeners.add(listener);
    return () => { this.settledListeners.delete(listener); };
  }
  private settled(): void { for (const listener of this.settledListeners) listener(); }
  private directory(): string { return join(this.catalog.userRoot, 'session-deletions'); }
  private file(sessionId: string): string { return join(this.directory(), `${identifier(sessionId)}.json`); }
  private key(sessionId: string): string { return this.file(sessionId); }
  private read(sessionId: string): Receipt | undefined {
    const file = this.file(sessionId);
    try { lstatSync(file); } catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
    if (realpathSync(dirname(file)) !== dirname(file)) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > maxBytes) {
        throw new RemovalFailure('INVALID_REMOVAL_RECORD');
      }
      const data = readFileSync(fd);
      if (data.length > maxBytes) throw new RemovalFailure('INVALID_REMOVAL_RECORD');
      return parseReceipt(JSON.parse(data.toString('utf8')), sessionId);
    } finally { closeSync(fd); }
  }
  private locked<T>(sessionId: string, action: () => T): T {
    privateModuleDirectory(this.catalog.userRoot);
    privateModuleDirectory(this.directory());
    const lock = join(this.directory(), `${identifier(sessionId)}.lock`);
    let fd: number;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (hasCode(error, 'EEXIST')) throw new RemovalFailure('SESSION_REMOVAL_LOCKED_INSPECT_BEFORE_RETRY');
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd);
      return action();
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  private save(receipt: Receipt): void { writeModuleRecord(this.file(receipt.snapshot.sessionId), receipt); }
  private snapshot(sessionId: string): Snapshot {
    identifier(sessionId);
    const session = this.catalog.getSession(sessionId);
    const selected = [...session?.selections ?? [], ...session?.pendingSelections ?? []];
    const targets = new Map<ModuleId, Target>();
    for (const selection of selected) {
      if (targets.has(selection.moduleId)) continue;
      const installed = this.catalog.getInstalled(selection.moduleId, selection.version);
      if (!installed) throw new RemovalFailure('SELECTED_MODULE_RELEASE_MISSING');
      const unbind = installed.manifest.sessionLifecycle?.unbind;
      if (!unbind) continue;
      const config = this.catalog.readConfig(selection.moduleId, installed.manifest.configVersion);
      const values = validateAdapterConfig(selection.moduleId, config.values);
      if (!values.configFile) throw new RemovalFailure('MODULE_UNBIND_CONFIG_FILE_REQUIRED');
      targets.set(selection.moduleId, {
        moduleId: selection.moduleId, name: installed.manifest.name, version: installed.manifest.version,
        digest: installed.digest, entry: unbind.entry, args: unbind.args ?? [],
        configVersion: installed.manifest.configVersion, configRevision: config.revision, configFile: values.configFile,
      });
    }
    const payload = { sessionId, bindingRevision: session?.revision ?? 0,
      targets: moduleIds.flatMap(id => targets.has(id) ? [targets.get(id)!] : []) };
    return { ...payload, planId: planId(payload) };
  }
  private busy(receipt: Receipt): boolean {
    if (active.has(this.key(receipt.snapshot.sessionId)) || children.has(this.key(receipt.snapshot.sessionId))) return true;
    if (receipt.childPid && alive(receipt.childPid)) return true;
    return receipt.state === 'working' && receipt.executorPid !== undefined
      && receipt.executorPid !== process.pid && alive(receipt.executorPid);
  }
  private assertReferences(snapshot: Snapshot): void {
    if ((this.catalog.getSession(snapshot.sessionId)?.revision ?? 0) !== snapshot.bindingRevision) {
      throw new RemovalFailure('SESSION_REMOVAL_PLAN_CHANGED');
    }
    for (const target of snapshot.targets) {
      const config = this.catalog.readConfig(target.moduleId, target.configVersion);
      if (config.revision !== target.configRevision || config.values.configFile !== target.configFile) {
        throw new RemovalFailure('SESSION_REMOVAL_PLAN_CHANGED');
      }
    }
  }
  async plan(sessionId: string): Promise<SessionDeletionPlan> {
    const receipt = this.read(sessionId);
    const snapshot = receipt?.state === 'deleted' ? receipt.snapshot : this.snapshot(sessionId);
    const interrupted = receipt?.state === 'working' && !this.busy(receipt);
    return SessionDeletionPlan.parse({
      sessionId, planId: snapshot.planId,
      modules: snapshot.targets.map(({ moduleId, name, version }) => ({ moduleId, name, version })),
      ...(receipt ? { operationId: receipt.operationId, state: interrupted ? 'unknown' : receipt.state,
        completedModules: receipt.completedModules,
        ...(interrupted ? { error: 'INTERRUPTED_REMOVAL_REQUIRES_SAME_OPERATION' } : receipt.error ? { error: receipt.error } : {}) } : {}),
    });
  }
  assertReady(sessionId: string): void {
    const receipt = this.read(sessionId);
    if (receipt && receipt.state !== 'deleted') throw new RemovalFailure('SESSION_DELETION_INCOMPLETE_FINISH_EXISTING_OPERATION');
  }
  private current(sessionId: string, attemptId: string): Receipt {
    const receipt = this.read(sessionId);
    if (!receipt || receipt.attemptId !== attemptId || receipt.state !== 'working') throw new RemovalFailure('SESSION_REMOVAL_ATTEMPT_CONFLICT', true);
    return receipt;
  }
  async unbind(sessionId: string, approval?: SessionUnbindApproval): Promise<void> {
    identifier(sessionId);
    const prior = this.read(sessionId);
    if (prior?.state === 'deleted') {
      if (!approval) throw new RemovalFailure('SESSION_UNBIND_APPROVAL_REQUIRED');
      const accepted = SessionUnbindApproval.parse(approval);
      if (accepted.planId !== prior.snapshot.planId || accepted.operationId !== prior.operationId) throw new RemovalFailure('SESSION_REMOVAL_OPERATION_CONFLICT');
      return;
    }
    const snapshot = this.snapshot(sessionId);
    if (!snapshot.targets.length && !prior) {
      if (approval && SessionUnbindApproval.parse(approval).planId !== snapshot.planId) throw new RemovalFailure('SESSION_REMOVAL_PLAN_CHANGED');
      return;
    }
    if (!approval) throw new RemovalFailure('SESSION_UNBIND_APPROVAL_REQUIRED');
    const accepted = SessionUnbindApproval.parse(approval);
    if (snapshot.planId !== accepted.planId) throw new RemovalFailure('SESSION_REMOVAL_PLAN_CHANGED');
    const attemptId = randomUUID();
    const key = this.key(sessionId);
    let claimed = false;
    try {
      const complete = this.locked(sessionId, () => {
        const current = this.read(sessionId);
        if (current && (current.operationId !== accepted.operationId || current.snapshot.planId !== accepted.planId)) {
          throw new RemovalFailure('SESSION_REMOVAL_OPERATION_CONFLICT');
        }
        if (current && this.busy(current)) throw new RemovalFailure('SESSION_REMOVAL_ALREADY_WORKING');
        this.assertReferences(snapshot);
        if (current?.state === 'unbound' || current?.state === 'deleted') return true;
        const receipt: Receipt = {
          schemaVersion: 1, snapshot, operationId: accepted.operationId, state: 'working',
          completedModules: current?.completedModules ?? [], attemptId, executorPid: process.pid,
        };
        this.save(receipt);
        active.set(key, attemptId); claimed = true;
        return false;
      });
      if (complete) return;
      for (const target of snapshot.targets) {
        const receipt = this.current(sessionId, attemptId);
        if (receipt.completedModules.includes(target.moduleId)) continue;
        if (this.snapshot(sessionId).planId !== snapshot.planId) throw new RemovalFailure('SESSION_REMOVAL_PLAN_CHANGED');
        privateFile(target.configFile);
        const installed = this.catalog.getInstalled(target.moduleId, target.version);
        if (!installed || installed.digest !== target.digest) throw new RemovalFailure('MODULE_UNBIND_RELEASE_CHANGED');
        const moduleOperationId = `unbind-${hash({ operationId: accepted.operationId, sessionId, moduleId: target.moduleId, planId: snapshot.planId })}`;
        await this.invoke(sessionId, attemptId, installed.release, target, moduleOperationId);
        this.locked(sessionId, () => {
          const current = this.current(sessionId, attemptId);
          current.completedModules.push(target.moduleId);
          delete current.childPid;
          this.save(current);
        });
      }
      this.locked(sessionId, () => {
        const current = this.current(sessionId, attemptId);
        current.state = 'unbound';
        delete current.executorPid; delete current.childPid; delete current.attemptId; delete current.error;
        this.save(current);
      });
    } catch (error) {
      if (!claimed) throw error;
      const failure = error instanceof RemovalFailure ? error : new RemovalFailure('MODULE_UNBIND_OUTCOME_UNCONFIRMED', true);
      try {
        this.locked(sessionId, () => {
          const receipt = this.current(sessionId, attemptId);
          receipt.state = failure.moduleOutcomeUnknown ? 'unknown' : 'failed';
          receipt.error = failure.code;
          delete receipt.executorPid; delete receipt.attemptId;
          if (!children.has(key)) delete receipt.childPid;
          this.save(receipt);
        });
      } catch {
        throw new RemovalFailure('REMOVAL_RECEIPT_OUTCOME_UNCONFIRMED', true);
      }
      throw failure;
    } finally {
      if (active.get(key) === attemptId) {
        active.delete(key);
        this.settled();
      }
    }
  }
  private async invoke(sessionId: string, attemptId: string, release: string, target: Target, moduleOperationId: string): Promise<void> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['HOME', 'PATH', 'LANG'] as const) if (process.env[key] !== undefined) env[key] = process.env[key];
    return new Promise((done, reject) => {
      const child = spawn(process.execPath, [join(release, target.entry), ...target.args, '--config', target.configFile], {
        cwd: release, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const key = this.key(sessionId);
      let settled = false, output = Buffer.alloc(0);
      const finish = (error?: RemovalFailure): void => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else done();
      };
      const timer = setTimeout(() => finish(new RemovalFailure('MODULE_UNBIND_TIMEOUT_UNCONFIRMED', true)), 30_000);
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (output.length + chunk.length > maxBytes) { finish(new RemovalFailure('MODULE_UNBIND_OUTPUT_UNCONFIRMED', true)); return; }
        output = Buffer.concat([output, chunk]);
      });
      child.stdin.on('error', () => finish(new RemovalFailure('MODULE_UNBIND_TRANSPORT_UNCONFIRMED', true)));
      child.once('error', () => finish(new RemovalFailure('MODULE_UNBIND_TRANSPORT_UNCONFIRMED', true)));
      child.once('close', (code, signal) => {
        if (children.get(key) === child.pid) children.delete(key);
        this.settled();
        if (settled) return;
        try {
          if (signal) throw new RemovalFailure('MODULE_UNBIND_EXIT_UNCONFIRMED', true);
          const response = object(JSON.parse(output.toString('utf8')));
          if (code === 2 && response.ok === false) {
            keys(response, ['ok', 'error', 'operationId', 'sessionId', 'replayed']);
            if ((response.operationId !== undefined && response.operationId !== moduleOperationId)
              || (response.sessionId !== undefined && response.sessionId !== sessionId)
              || (response.replayed !== undefined && typeof response.replayed !== 'boolean')) {
              throw new Error('Unconfirmed hook failure identity');
            }
            const error = object(response.error);
            keys(error, ['code']);
            if (typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)) throw new Error('Invalid error code');
            finish(new RemovalFailure(`MODULE_UNBIND_FAILED: ${error.code}`, /UNKNOWN|UNCONFIRMED/.test(error.code)));
            return;
          }
          keys(response, ['ok', 'operationId', 'sessionId', 'unbound', 'replayed']);
          if (code !== 0 || response.ok !== true || response.operationId !== moduleOperationId
            || response.sessionId !== sessionId || response.unbound !== true || typeof response.replayed !== 'boolean') {
            throw new Error('Unconfirmed hook response');
          }
          finish();
        } catch { finish(new RemovalFailure('MODULE_UNBIND_RESPONSE_UNCONFIRMED', true)); }
      });
      child.once('spawn', () => {
        if (settled) { child.stdin.end(); return; }
        if (child.pid === undefined) { finish(new RemovalFailure('MODULE_UNBIND_TRANSPORT_UNCONFIRMED', true)); return; }
        children.set(key, child.pid);
        try {
          this.locked(sessionId, () => {
            const current = this.current(sessionId, attemptId);
            current.childPid = child.pid;
            this.save(current);
          });
          child.stdin.end(JSON.stringify({ operation: 'session-unbind', operationId: moduleOperationId, sessionId }));
        } catch {
          child.stdin.end();
          finish(new RemovalFailure('REMOVAL_RECEIPT_OUTCOME_UNCONFIRMED', true));
        }
      });
    });
  }
  async removed(sessionId: string): Promise<void> {
    const prior = this.read(sessionId);
    if (!prior) {
      if (this.snapshot(sessionId).targets.length) throw new RemovalFailure('SESSION_UNBIND_REQUIRED_BEFORE_REMOVED');
      return;
    }
    this.locked(sessionId, () => {
      const receipt = this.read(sessionId);
      if (!receipt || receipt.state === 'deleted') return;
      if (receipt.state !== 'unbound' || this.busy(receipt)) throw new RemovalFailure('SESSION_UNBIND_REQUIRED_BEFORE_REMOVED');
      receipt.state = 'deleted';
      this.save(receipt);
    });
  }
}
