import { ModuleServiceJob, ModuleServiceRequest, ModuleServiceStatus } from '@cockpit/protocol';
import type { IntentBody, ModuleStatus } from '@cockpit/protocol';
import { browserOperationLock, type BrowserOperationLock } from './browserOperationLock';
import { resourceError } from './keyedAsync';

type Request = IntentBody<'modules/service'>;
export type ServiceModuleId = Request['moduleId'];
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
interface RequestRecord { request: Request; terminal?: 'done' | 'failed' }
export interface ModuleServiceAttempt extends RequestRecord { recovery?: RequestRecord }
type Attempt = ModuleServiceAttempt;
interface Snapshot { attempt?: Attempt; job?: ModuleServiceJob; recoveryJob?: ModuleServiceJob; error?: string; busy: boolean; reading: boolean }
type Submit = (request: Request) => Promise<{ job: ModuleServiceJob }>;
type ReadJob = (operationId: string) => Promise<{ job: ModuleServiceJob | null }>;

export function selectedServiceRelease(module: ModuleStatus) {
  const matches = module.installed.filter(release => release.version === module.selectedVersion);
  return matches.length === 1 && /^[a-f0-9]{64}$/.test(matches[0].digest) ? matches[0] : undefined;
}

export function serviceActionReason(module: ModuleStatus, runner: ModuleServiceStatus | undefined, action: Request['action']): string | undefined {
  if (module.id === 'assistant') return '此模块没有独立服务。';
  if (module.service.ownership !== 'managed') return '不接管外部服务；仅可操作 Cockpit 管理的独立服务。';
  if (!module.service.runner || !runner) return '独立运行器尚未确认可用，请读取实际状态。';
  if (module.service.runner.id !== module.id || runner.id !== module.id) return '运行器模块标识不匹配。';
  if (runner.recoveryRequired) return '运行器要求恢复；普通操作被禁止，只能按明确授权安全恢复停止或由宿主核对。';
  if (runner.job && !['done', 'failed'].includes(runner.job.phase)) return '运行器仍有待确认作业，请读取原操作。';
  if (action !== 'stop' && !selectedServiceRelease(module)) return '当前选择没有唯一的已安装版本和有效 digest。';
  if (action === 'start') {
    if (runner.status !== 'stopped' || runner.owned || runner.identity || runner.pid) return '仅可从确认停止且没有存活进程的状态启动。';
    return undefined;
  }
  const identity = runner.identity, expected = runner.expectedIdentity;
  if (runner.status !== 'running' || !runner.owned || !identity || identity.moduleId !== module.id) {
    return '仅可安全停止或应用当前运行器实际拥有、身份已确认的运行服务。';
  }
  if ((expected && (identity.moduleId !== expected.moduleId || identity.moduleVersion !== expected.moduleVersion
    || identity.moduleDigest !== expected.moduleDigest || identity.instanceId !== expected.instanceId))
    || (runner.expectedPid !== undefined && runner.pid !== runner.expectedPid)) return '实际与预期进程身份不匹配，不能操作。';
  if (action === 'apply') {
    const selected = selectedServiceRelease(module);
    if (selected?.version === identity.moduleVersion && selected.digest === identity.moduleDigest) return '已在运行当前选择的版本和 digest。';
  }
  return undefined;
}

export function serviceRecoveryReason(module: ModuleStatus, runner: ModuleServiceStatus | undefined): string | undefined {
  if (module.service.ownership !== 'managed' || !module.service.runner || !runner
    || module.service.runner.id !== module.id || runner.id !== module.id) return '没有匹配的托管运行器。';
  if (runner.canRecoverStop !== true) return '运行器未授权安全恢复停止，须由宿主核对；不接管旧进程。';
  if (!runner.job || runner.job.command.id !== module.id) {
    return '没有已确认身份的原故障作业，请先读取运行器状态。';
  }
  return undefined;
}

export const serviceJobLabels: Record<ModuleServiceJob['phase'], string> = {
  accepted: '已受理（不是服务就绪）', running: '作业执行中（不是服务运行确认）',
  waiting: '安全等待中', done: '作业已完成', failed: '作业失败', unknown: '作业结果未知',
};

function requestOf(job: ModuleServiceJob): Request {
  const { id, ...command } = job.command;
  return ModuleServiceRequest.parse({ moduleId: id, ...command });
}
function sameRequest(left: Request, right: Request) {
  return left.moduleId === right.moduleId && left.operationId === right.operationId && left.action === right.action
    && left.version === right.version && left.digest === right.digest
    && left.recoveryOf === right.recoveryOf && left.confirmRecovery === right.confirmRecovery;
}

export function serviceRecoveryAttemptReason(runner: ModuleServiceStatus | undefined, attempt?: ModuleServiceAttempt): string | undefined {
  if (!runner?.job) return '请先读取运行器状态，核对原操作。';
  const original = requestOf(runner.job);
  const latest = attempt?.recovery ?? attempt;
  if (latest && !sameRequest(latest.request, original)) {
    return '已有不同原操作或保留的恢复操作；运行器作业必须与浏览器当前链节完全匹配。';
  }
  if (original.confirmRecovery && (latest?.terminal !== 'failed' || runner.job.phase !== 'failed')) {
    return '须显式读回当前恢复链节 failed 并修正原因后才能继续；未读回或 unknown 的恢复链节，本界面只允许读回，不推进或重发。';
  }
  return undefined;
}

export function serviceAttemptCanReset(attempt?: ModuleServiceAttempt): boolean {
  const latest = attempt?.recovery ?? attempt;
  return latest?.request.confirmRecovery ? latest.terminal === 'done' : !!latest?.terminal;
}

// Only the outgoing request and its explicitly read terminal acknowledgement
// survive reload. Actual runner/process state always comes from passive APIs.
export class ModuleServiceOperation {
  private snapshot: Snapshot = { busy: false, reading: false };
  private readonly key: string;
  private readonly storage?: Storage;
  private readonly lock: BrowserOperationLock;
  private readonly newId: () => string;
  private readonly moduleId: ServiceModuleId;
  private listeners = new Set<() => void>();

  constructor(moduleId: ServiceModuleId, storage?: Storage, newId: () => string = () => crypto.randomUUID(), lock?: BrowserOperationLock) {
    this.moduleId = moduleId;
    this.key = `cockpit:module-service:${moduleId}:v1`;
    this.storage = storage;
    this.newId = newId;
    this.lock = lock ?? (claim => browserOperationLock(this.key, claim));
    try { this.snapshot.attempt = this.stored(); }
    catch (error) { this.snapshot.error = resourceError(error); }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  private stored(): Attempt | undefined {
    if (!this.storage) throw new Error('无法持久保存服务操作；尚未发送，请恢复浏览器存储。');
    const raw = this.storage.getItem(this.key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) throw new Error('服务操作记录无效；不能替换原操作。');
    if (!('request' in value)) return undefined;
    const original = this.record(value);
    if (!('recovery' in value)) return original;
    const recovery = this.record(value.recovery);
    if (recovery.request.action !== 'stop' || recovery.request.confirmRecovery !== true
      || recovery.request.recoveryOf !== original.request.operationId
      || recovery.request.operationId === original.request.operationId) throw new Error('恢复停止记录与原故障操作不匹配。');
    return { ...original, recovery };
  }
  private record(value: unknown): RequestRecord {
    if (!value || typeof value !== 'object' || !('request' in value)) throw new Error('服务操作记录无效。');
    const request = ModuleServiceRequest.parse(value.request);
    if (request.moduleId !== this.moduleId) throw new Error('持久服务操作的模块标识不匹配。');
    const terminal = 'terminal' in value ? value.terminal : undefined;
    if (terminal !== undefined && terminal !== 'done' && terminal !== 'failed') throw new Error('服务操作确认信息无效。');
    return { request, ...(terminal ? { terminal } : {}) };
  }
  private save(attempt?: Attempt) {
    if (!this.storage) throw new Error('无法持久保存服务操作；尚未发送。');
    this.storage.setItem(this.key, JSON.stringify({ version: 1, ...attempt }));
    this.update({ attempt });
  }
  private adopt(attempt: Attempt | undefined) {
    const same = attempt?.request.operationId === this.snapshot.attempt?.request.operationId;
    const sameRecovery = attempt?.recovery?.request.operationId === this.snapshot.attempt?.recovery?.request.operationId;
    this.update({ attempt, ...(same ? {} : { job: undefined }), ...(same && sameRecovery ? {} : { recoveryJob: undefined }) });
  }
  private async receipt(request: Request, value: unknown, explicitRead: boolean) {
    const job = ModuleServiceJob.parse(value);
    if (!sameRequest(request, requestOf(job))) throw new Error('服务作业回执与原请求不匹配，未采纳。');
    return this.lock(() => {
      const current = this.stored();
      const isRecovery = current?.recovery !== undefined && sameRequest(current.recovery.request, request);
      const target = isRecovery ? current.recovery : current;
      if (!current || !target || !sameRequest(target.request, request)) { this.adopt(current); return; }
      if (target.terminal && job.phase !== target.terminal) throw new Error('服务作业读回与已确认终态冲突；不能重试。');
      const terminal = explicitRead && (job.phase === 'done' || job.phase === 'failed') ? job.phase : target.terminal;
      const updated = { request, ...(terminal ? { terminal } : {}) };
      this.save(isRecovery ? { ...current, recovery: updated } : { ...current, ...updated });
      this.update({ ...(isRecovery ? { recoveryJob: job } : { job }), error: undefined });
    });
  }
  send = async (module: ModuleStatus, runner: ModuleServiceStatus, action: Request['action'], submit: Submit) => {
    if (this.snapshot.busy) throw new Error('已有本地服务操作正在处理，请勿重复提交。');
    this.update({ busy: true, error: undefined });
    try {
      if (module.id !== this.moduleId) throw new Error('服务操作模块标识不匹配。');
      const reason = serviceActionReason(module, ModuleServiceStatus.parse(runner), action);
      if (reason) throw new Error(reason);
      const request = await this.lock(() => {
        const current = this.stored();
        if (current) { this.adopt(current); throw new Error('已有保留的服务操作；请读取原 ID，不能换 ID 重发。'); }
        const selected = selectedServiceRelease(module);
        const request = ModuleServiceRequest.parse({ moduleId: this.moduleId, action, operationId: this.newId(),
          ...(action === 'stop' ? {} : { version: selected?.version, digest: selected?.digest }) });
        this.save({ request });
        this.update({ job: undefined });
        return request;
      });
      await this.receipt(request, (await submit(request)).job, false);
    } catch (error) { this.update({ error: resourceError(error) }); throw error; }
    finally { this.update({ busy: false }); }
  };
  recover = async (module: ModuleStatus, runner: ModuleServiceStatus, confirm: (message: string) => boolean, submit: Submit) => {
    if (this.snapshot.busy) throw new Error('服务操作仍在处理，请读取原 ID。');
    this.update({ busy: true, error: undefined });
    try {
      if (module.id !== this.moduleId) throw new Error('恢复停止模块不匹配。');
      const status = ModuleServiceStatus.parse(runner);
      const reason = serviceRecoveryReason(module, status);
      if (reason) throw new Error(reason);
      const original = requestOf(ModuleServiceJob.parse(status.job));
      const currentAttempt = () => {
        const current = this.stored();
        this.adopt(current);
        const reason = serviceRecoveryAttemptReason(status, current);
        if (reason) throw new Error(reason);
        return current;
      };
      await this.lock(currentAttempt);
      if (!confirm(`${original.confirmRecovery ? '已明确读回上一恢复 failed。确认已修正失败原因，并以该失败恢复为 recoveryOf 创建新的安全停止链节？此前作业及失败结果保留在后台，仅推进 GUI 焦点。' : ''}确认仅安全排空/恢复停止 ${module.name}，原故障操作 ${original.operationId}？只处理当前运行器持有的同一实例，或确认尚未启动的空状态；不启动替代、不回滚数据、不清除旧作业、不强停、不重发业务。恢复结果未知时只读取本次恢复 ID，不自动重试。`)) return;
      const request = await this.lock(() => {
        const current = currentAttempt();
        const request = ModuleServiceRequest.parse({ moduleId: this.moduleId, action: 'stop', operationId: this.newId(),
          recoveryOf: original.operationId, confirmRecovery: true });
        if (request.operationId === original.operationId || request.operationId === original.recoveryOf) {
          throw new Error('恢复操作必须使用不同于此前链节的独立 ID。');
        }
        this.save({ ...(current?.recovery ?? current ?? { request: original }), recovery: { request } });
        this.update({ job: status.job, recoveryJob: undefined });
        return request;
      });
      await this.receipt(request, (await submit(request)).job, false);
    } catch (error) { this.update({ error: resourceError(error) }); throw error; }
    finally { this.update({ busy: false }); }
  };
  read = (read: ReadJob, observed?: ModuleServiceJob) => this.readAttempt(read, observed, false);
  readRecovery = (read: ReadJob) => this.readAttempt(read, undefined, true);
  private readAttempt = async (read: ReadJob, observed: ModuleServiceJob | undefined, recovery: boolean) => {
    if (this.snapshot.reading) throw new Error('已有原服务操作读回正在处理。');
    this.update({ reading: true, error: undefined });
    try {
      const request = await this.lock(() => {
        let current = this.stored();
        if (!current && observed && !recovery) {
          const request = requestOf(ModuleServiceJob.parse(observed));
          if (request.moduleId !== this.moduleId) throw new Error('运行器作业属于其他模块。');
          current = { request };
          this.save(current);
        }
        this.adopt(current);
        const target = recovery ? current?.recovery : current;
        if (!target) throw new Error('没有可读回的原服务操作。');
        return target.request;
      });
      const { job } = await read(request.operationId);
      if (!job) throw new Error('尚无原操作回执；不能据此认定未执行，也不会换 ID 重发。');
      await this.receipt(request, job, true);
    } catch (error) { this.update({ error: resourceError(error) }); throw error; }
    finally { this.update({ reading: false }); }
  };
  newOperation = async () => {
    if (this.snapshot.busy) throw new Error('原操作仍在处理。');
    try {
      await this.lock(() => {
        const current = this.stored();
        this.adopt(current);
        if (!serviceAttemptCanReset(current)) {
          throw new Error('必须先读回确认原操作已完成或失败；有恢复操作时须确认恢复停止 done，未知结果不能替换。');
        }
        this.save();
        this.update({ job: undefined, recoveryJob: undefined, error: undefined });
      });
    } catch (error) { this.update({ error: resourceError(error) }); throw error; }
  };
}

const operations = new Map<ServiceModuleId, ModuleServiceOperation>();
export function getModuleServiceOperation(moduleId: ServiceModuleId) {
  let operation = operations.get(moduleId);
  if (!operation) {
    let storage: Storage | undefined;
    try { storage = globalThis.localStorage; }
    catch { /* The controller surfaces unavailable durable storage and cannot send. */ }
    operation = new ModuleServiceOperation(moduleId, storage);
    operations.set(moduleId, operation);
  }
  return operation;
}
