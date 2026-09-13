import { ModuleUpdateOperation, type IntentBody } from '@cockpit/protocol';

export function moduleInstallDigestLabel(source?: ModuleUpdateOperation['source']) {
  return source === 'local' ? '本机 inventory SHA256（不是归档哈希）' : '远端归档 SHA256';
}

export async function reconcileModuleUpdate(
  operation: ModuleUpdateOperation,
  confirm: (message: string) => boolean,
  reconcile: (body: IntentBody<'modules/updates/reconcile'>) => Promise<ModuleUpdateOperation>,
) {
  if (operation.state !== 'unknown') throw new Error('仅可核对结果未知的原安装操作。');
  if (!confirm(`核对 ${operation.moduleId}@${operation.version} 的原安装操作 ${operation.operationId}，${moduleInstallDigestLabel(operation.source)} ${operation.sha256}？仅检查并记录已验证结果；不下载、不安装、不改 selected、不重启，不自动恢复。现存锁会拒绝核对，不会偷锁；不一致仍保留 unknown。`)) return;
  const result = ModuleUpdateOperation.parse(await reconcile({
    moduleId: operation.moduleId, operationId: operation.operationId, confirm: true,
  }));
  if (result.moduleId !== operation.moduleId || result.operationId !== operation.operationId
    || result.version !== operation.version || result.sha256 !== operation.sha256 || result.source !== operation.source) {
    throw new Error('安装核对回执与原操作不匹配，未采纳；请读取原操作状态。');
  }
  return result;
}
