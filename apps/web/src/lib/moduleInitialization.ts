import { ModuleConfig, ModuleInitializationOperation, ModuleInitializationRequest } from '@cockpit/protocol';
import type { ModuleStatus } from '@cockpit/protocol';
import { ModuleMutation } from './moduleMutation';
import { selectedServiceRelease } from './moduleService';
import type { BrowserOperationLock } from './browserOperationLock';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export function moduleInitializationReason(module: ModuleStatus, config?: ModuleConfig): string | undefined {
  if (module.id !== 'task' || module.supportsInitialization !== true) return '当前选择未声明 Task 初始化能力，不调用初始化 hook。';
  if (!selectedServiceRelease(module)) return '须选择唯一已安装版本及其完整 digest。';
  if (!config || config.moduleId !== 'task') return '须先读取 Task 的权威配置，不能把读取失败当成空配置。';
  if (config.revision !== 0 || Object.keys(config.values).length) return '已有配置或外部部署引用：仅继续配置引用，不初始化、不搬迁、不接管。';
  if (!['unknown', 'stopped'].includes(module.service.status) || module.service.version || module.service.instanceId
    || module.service.digest || module.service.runner?.owned || module.service.runner?.identity
    || module.service.runner?.expectedIdentity || module.service.runner?.pid || module.service.runner?.expectedPid
    || module.service.runner?.recoveryRequired) return '已有运行实例或待恢复状态；不能作为全新 Task 初始化。';
  return undefined;
}

export function createModuleInitialization(storage?: Storage, newId?: () => string, lock?: BrowserOperationLock) {
  const operation = new ModuleMutation<ModuleInitializationRequest, ModuleInitializationOperation | null>(
    'cockpit:module-initialization:task:v1', {
      request: value => ModuleInitializationRequest.parse(value),
      result: value => ModuleInitializationOperation.nullable().parse(value),
      inspect(request, result) {
        if (!result || result.moduleId !== request.moduleId || result.operationId !== request.operationId
          || result.version !== request.version || result.digest !== request.digest || result.gatewayUrl !== request.gatewayUrl) {
          throw new Error('未读到匹配原 ID、版本、digest 和网关的初始化结果；不能再次初始化或签发凭据。');
        }
        if ((result.config && result.config.moduleId !== 'task') || (result.phase === 'succeeded' && !result.config)) {
          throw new Error('初始化配置回执不完整或模块不匹配；不能确认成功。');
        }
        return { confirmed: result.phase === 'succeeded' || result.phase === 'failed' ? result.phase : undefined,
          message: `原初始化 ${result.phase}${result.reason ? `：${result.reason}` : ''}；不会自动启动服务或再次初始化。` };
      },
    }, storage, newId, lock);
  return {
    getSnapshot: operation.getSnapshot,
    subscribe: operation.subscribe,
    read: operation.read,
    async initialize(module: ModuleStatus, config: ModuleConfig | undefined, gatewayUrl: string,
      confirm: (message: string) => boolean, submit: (request: ModuleInitializationRequest) => Promise<ModuleInitializationOperation>) {
      const reason = moduleInitializationReason(module, config ? ModuleConfig.parse(config) : undefined);
      if (reason) throw new Error(reason);
      const release = selectedServiceRelease(module);
      if (!release) throw new Error('所选安装版本尚未确认。');
      const gateway = ModuleInitializationRequest.shape.gatewayUrl.parse(gatewayUrl);
      if (!confirm(`确认初始化全新 Task 配置：${release.version}，digest ${release.digest}，网关 ${gateway}？仅在新空 data/task 创建私有 manager 和只读 viewer；保留已有配置/数据且拒绝接管。不启动服务、不新建 caller/session、不发消息。提交后固定原操作 ID，超时或结果未知仅只读核对，不换 ID 重签凭据。`)) return;
      await operation.start(operationId => ({ moduleId: 'task', operationId, version: release.version,
        digest: release.digest, gatewayUrl: gateway, confirm: true }), submit);
    },
  };
}

let initialization: ReturnType<typeof createModuleInitialization> | undefined;
export function getModuleInitialization() {
  if (!initialization) {
    let storage: Storage | undefined;
    try { storage = globalThis.localStorage; }
    catch { /* The outgoing controller refuses sending without durable storage. */ }
    initialization = createModuleInitialization(storage);
  }
  return initialization;
}
