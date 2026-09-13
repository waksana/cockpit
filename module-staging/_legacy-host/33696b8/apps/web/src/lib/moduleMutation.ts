import { Intents, ModuleUnbindOperation, ModuleUpdateOperation, SessionModules } from '@cockpit/protocol';
import type { IntentBody, ModuleSelection, ModuleStatus } from '@cockpit/protocol';
import { browserOperationLock, type BrowserOperationLock } from './browserOperationLock';
import { resourceError } from './keyedAsync';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
interface Request { operationId: string }
interface Proof { confirmed?: 'succeeded' | 'failed'; continuable?: boolean; message: string }
interface Attempt<R> { request: R; revision: number; confirmed?: 'succeeded' | 'failed'; continuable?: boolean }
interface Snapshot<R, S> { attempt?: Attempt<R>; result?: S; message?: string; error?: string; sending: boolean; reading: boolean }
interface Policy<R, S> {
  request(value: unknown): R;
  result(value: unknown): S;
  inspect(request: R, result: S): Proof;
  acknowledgePost?: boolean;
}

// One durable outgoing request per scope. Locks protect only claims/receipts;
// network calls are outside the lock and old response generations cannot win.
export class ModuleMutation<R extends Request, S> {
  private state: Snapshot<R, S> = { sending: false, reading: false };
  private listeners = new Set<() => void>();
  private readonly key: string;
  private readonly policy: Policy<R, S>;
  private readonly storage?: Storage;
  private readonly newId: () => string;
  private readonly lock: BrowserOperationLock;
  constructor(key: string, policy: Policy<R, S>, storage?: Storage,
    newId: () => string = () => crypto.randomUUID(), lock?: BrowserOperationLock) {
    this.key = key; this.policy = policy; this.storage = storage; this.newId = newId;
    this.lock = lock ?? (claim => browserOperationLock(key, claim));
    try { this.state.attempt = this.stored(); }
    catch (error) { this.state.error = resourceError(error); }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<Snapshot<R, S>>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private stored(): Attempt<R> | undefined {
    if (!this.storage) throw new Error('无法持久保存出站操作；未发送，请恢复浏览器存储。');
    const raw = this.storage.getItem(this.key);
    if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) throw new Error('出站记录无效，不能替换原操作。');
    if (!('request' in value)) return;
    if (!('revision' in value) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new Error('出站操作代次无效。');
    }
    const confirmed = 'confirmed' in value ? value.confirmed : undefined;
    const continuable = 'continuable' in value ? value.continuable : undefined;
    if ((confirmed !== undefined && confirmed !== 'succeeded' && confirmed !== 'failed')
      || (continuable !== undefined && typeof continuable !== 'boolean')) throw new Error('出站确认记录无效。');
    return { request: this.policy.request(value.request), revision: value.revision,
      ...(confirmed ? { confirmed } : {}), ...(continuable !== undefined ? { continuable } : {}) };
  }
  private adopt(attempt?: Attempt<R>) {
    const same = attempt?.request.operationId === this.state.attempt?.request.operationId
      && attempt?.revision === this.state.attempt?.revision;
    this.update({ attempt, ...(same ? {} : { result: undefined, message: undefined }) });
  }
  private save(attempt?: Attempt<R>) {
    if (!this.storage) throw new Error('无法持久保存出站操作；未发送。');
    this.storage.setItem(this.key, JSON.stringify({ version: 1, ...attempt }));
    this.adopt(attempt);
  }
  private matches(a: Attempt<R> | undefined, b: Attempt<R>) {
    return a?.revision === b.revision && JSON.stringify(a.request) === JSON.stringify(b.request);
  }
  private async observe(attempt: Attempt<R>, value: unknown, read: boolean) {
    const result = this.policy.result(value), proof = this.policy.inspect(attempt.request, result);
    await this.lock(() => {
      const current = this.stored();
      if (!current || !this.matches(current, attempt)) { this.adopt(current); return; }
      if (current.confirmed && !read) { this.adopt(current); return; }
      if (current.confirmed && this.policy.acknowledgePost && proof.confirmed !== current.confirmed) {
        throw new Error('原操作读回与已确认终态冲突；保留原回执，不采纳矛盾结果。');
      }
      this.save({ ...current,
        confirmed: read || this.policy.acknowledgePost ? proof.confirmed : current.confirmed,
        continuable: read && proof.continuable === true });
      this.update({ result, message: proof.message, error: undefined });
    });
  }
  start = async (make: (id: string) => R, submit: (request: R) => Promise<S>) => {
    if (this.state.sending) throw new Error('出站操作仍在处理。');
    this.update({ sending: true, error: undefined });
    try {
      const attempt = await this.lock(() => {
        const current = this.stored();
        if (current) { this.adopt(current); throw new Error('已有原出站操作，不能换 ID 重发；请先只读核对。'); }
        const attempt = { request: this.policy.request(make(this.newId())), revision: 0 };
        this.save(attempt);
        return attempt;
      });
      await this.observe(attempt, await submit(attempt.request), false);
    } catch (error) { this.update({ error: resourceError(error) }); throw error; }
    finally { this.update({ sending: false }); }
  };
  read = async (load: (request: R) => Promise<S>, observed?: R) => {
    if (this.state.reading) throw new Error('正在读取原操作。');
    this.update({ reading: true, error: undefined });
    try {
      const attempt = await this.lock(() => {
        let current = this.stored();
        if (!current && observed) current = { request: this.policy.request(observed), revision: 0 };
        if (!current) throw new Error('没有可读回的原操作。');
        this.save({ ...current, continuable: false });
        return current;
      });
      await this.observe(attempt, await load(attempt.request), true);
    } catch (error) { this.update({ error: resourceError(error) }); throw error; }
    finally { this.update({ reading: false }); }
  };
  resume = async (confirm: () => boolean, submit: (request: R) => Promise<S>) => {
    if (this.state.sending) throw new Error('原操作仍在提交中。');
    this.update({ sending: true, error: undefined });
    try {
      if (!confirm()) return;
      const attempt = await this.lock(() => {
        const current = this.stored();
        this.adopt(current);
        if (!current?.continuable || current.confirmed) throw new Error('须先只读核对同一原操作的可继续状态；不会重放未确认请求。');
        const next = { request: current.request, revision: current.revision + 1, continuable: false };
        this.save(next);
        return next;
      });
      await this.observe(attempt, await submit(attempt.request), false);
    } catch (error) { this.update({ error: resourceError(error) }); throw error; }
    finally { this.update({ sending: false }); }
  };
  newOperation = async () => {
    if (this.state.sending || this.state.reading) throw new Error('原操作仍在处理。');
    try {
      await this.lock(() => {
        const current = this.stored();
        this.adopt(current);
        if (!current?.confirmed) throw new Error('未确认原操作终态，不能另起新操作。');
        this.save();
        this.update({ error: undefined });
      });
    } catch (error) { this.update({ error: resourceError(error) }); throw error; }
  };
}

function sameSelections(left: ModuleSelection[], right: ModuleSelection[]) {
  const sorted = (values: ModuleSelection[]) => values.map(({ moduleId, roleId, version }) => ({ moduleId, roleId, version }))
    .sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}
export function createModuleApply(sessionId: string, storage?: Storage, newId?: () => string, lock?: BrowserOperationLock) {
  return new ModuleMutation<IntentBody<'session/modules/apply'>, SessionModules | null>(`cockpit:module-apply:${sessionId}:v1`, {
    request(value) {
      const request = Intents['session/modules/apply'].body.parse(value);
      if (request.sessionId !== sessionId || request.selections.some(item => !item.version)) throw new Error('必须固定本会话模块及精确版本。');
      return request;
    },
    result: value => SessionModules.nullable().parse(value),
    inspect(request, result) {
      if (!result || result.sessionId !== request.sessionId || result.operationId !== request.operationId) {
        throw new Error('当前模块记录不是原操作；不能据此确认或重放。');
      }
      const target = result.phase === 'applied' ? result.selections : result.pendingSelections;
      if (!target || !sameSelections(request.selections, target)) throw new Error('原操作的实际/待应用模块选择不匹配，不能确认。');
      return { confirmed: result.phase === 'applied' && result.nativePresent !== false ? 'succeeded' : undefined,
        continuable: ['failed', 'unknown'].includes(result.phase) && result.nativePresent !== false,
        message: `原操作 ${result.phase}${result.error ? `：${result.error}` : ''}${result.nativePresent === false ? '；原生会话尚未确认存在' : ''}` };
    },
  }, storage, newId, lock);
}
export type ModuleInstallRequest = IntentBody<'modules/updates/install'> & Pick<ModuleUpdateOperation, 'source'>;
const InstallRequest = Intents['modules/updates/install'].body.extend({ source: ModuleUpdateOperation.shape.source }).strict();
export function createModuleInstall(moduleId: ModuleStatus['id'], storage?: Storage, newId?: () => string, lock?: BrowserOperationLock) {
  return new ModuleMutation<ModuleInstallRequest, ModuleUpdateOperation | null>(`cockpit:module-install:${moduleId}:v1`, {
    request(value) {
      const request = InstallRequest.parse(value);
      if (request.moduleId !== moduleId) throw new Error('安装模块标识不匹配。');
      if (request.source === 'local') Intents['modules/install/local'].body.parse({
        moduleId, operationId: request.operationId, version: request.version, digest: request.sha256,
      });
      return request;
    },
    result: value => ModuleUpdateOperation.nullable().parse(value),
    inspect(request, result) {
      if (!result || result.operationId !== request.operationId || result.moduleId !== request.moduleId
        || result.version !== request.version || result.sha256 !== request.sha256 || result.source !== request.source) {
        throw new Error('未读到匹配原 ID/归档或本机 inventory 来源的安装结果，不能重新安装。');
      }
      return { confirmed: result.state === 'succeeded' || result.state === 'failed' ? result.state : undefined,
        message: `原安装 ${result.state}${result.error ? `：${result.error}` : ''}` };
    },
  }, storage, newId, lock);
}
export function createWechatUnbind(storage?: Storage, newId?: () => string, lock?: BrowserOperationLock) {
  type UnbindRequest = IntentBody<'modules/wechat/unbind'>;
  const operation = new ModuleMutation<UnbindRequest, ModuleUnbindOperation | null>('cockpit:wechat-unbind:v1', {
    request: value => Intents['modules/wechat/unbind'].body.parse(value),
    result: value => ModuleUnbindOperation.nullable().parse(value),
    inspect(request, result) {
      if (!result || result.operationId !== request.operationId || result.sessionId !== request.sessionId) {
        throw new Error('未读到匹配原 operationId 和 sessionId 的解绑结果；绑定消失不能证明成功，不会换 ID 重发。');
      }
      return { confirmed: result.state === 'succeeded' || result.state === 'failed' ? result.state : undefined,
        message: `原解绑 ${result.state}${result.error ? `：${result.error}` : ''}；不代表后续没有新的绑定，不自动解绑或重试。` };
    },
    acknowledgePost: true,
  }, storage, newId, lock);
  return {
    getSnapshot: operation.getSnapshot,
    subscribe: operation.subscribe,
    read: operation.read,
    newOperation: operation.newOperation,
    start: (make: (id: string) => UnbindRequest, submit: (request: UnbindRequest) => Promise<{ ok: true }>) =>
      operation.start(make, async request => {
        Intents['modules/wechat/unbind'].result.parse(await submit(request));
        return { operationId: request.operationId, sessionId: request.sessionId, state: 'succeeded' };
      }),
  };
}

function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage; }
  catch { return undefined; } // The durable-write guard surfaces failure before any send.
}
const applies = new Map<string, ReturnType<typeof createModuleApply>>();
const installs = new Map<string, ReturnType<typeof createModuleInstall>>();
let unbind: ReturnType<typeof createWechatUnbind> | undefined;
export function getModuleApply(sessionId: string) {
  let operation = applies.get(sessionId);
  if (!operation) { operation = createModuleApply(sessionId, browserStorage()); applies.set(sessionId, operation); }
  return operation;
}
export function getModuleInstall(moduleId: ModuleStatus['id']) {
  let operation = installs.get(moduleId);
  if (!operation) { operation = createModuleInstall(moduleId, browserStorage()); installs.set(moduleId, operation); }
  return operation;
}
export function getWechatUnbind() {
  unbind ??= createWechatUnbind(browserStorage());
  return unbind;
}
