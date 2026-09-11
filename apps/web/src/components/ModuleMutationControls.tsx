import { useState, useSyncExternalStore } from 'react';
import type { ModuleReleaseMetadata, ModuleStatus, ModuleUpdateOperation } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { getModuleInstall, getWechatUnbind, type ModuleInstallRequest } from '../lib/moduleMutation';
import { moduleInstallDigestLabel, reconcileModuleUpdate } from '../lib/moduleUpdate';

export function OutgoingModuleStatus({ operationId, message, error }: { operationId?: string; message?: string; error?: string }) {
  return <>
    {operationId && <p role="status">保留的原操作：<code>{operationId}</code> · {message ?? '结果待确认；关闭或刷新不会换 ID 重发。'}</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}

export function ModuleInstallControls({ moduleId, targets, localRelease, localSourceError, latest, disabled, onRefresh }: {
  moduleId: ModuleStatus['id']; targets: ModuleReleaseMetadata['targets']; latest?: ModuleUpdateOperation;
  localRelease?: ModuleStatus['localRelease']; localSourceError?: string;
  disabled: boolean; onRefresh: () => void;
}) {
  const intent = useCockpit(state => state.moduleIntent);
  const [operation] = useState(() => getModuleInstall(moduleId));
  const snapshot = useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
  const action = useKeyedAction(`module-install:${moduleId}`), reader = useKeyedAction(`module-install-read:${moduleId}`);
  const attempt = snapshot.attempt, result = snapshot.result;
  const observed = latest ? { moduleId: latest.moduleId, operationId: latest.operationId,
    version: latest.version, sha256: latest.sha256, ...(latest.source ? { source: latest.source } : {}) } : undefined;
  const read = () => operation.read(async request => (await intent('modules/updates/get', { operationId: request.operationId })).operation, observed);
  const latestPending = latest && !['succeeded', 'failed'].includes(latest.state);
  const submit = (request: ModuleInstallRequest) => request.source === 'local'
    ? intent('modules/install/local', { moduleId: request.moduleId, operationId: request.operationId,
      version: request.version, digest: request.sha256 })
    : intent('modules/updates/install', { moduleId: request.moduleId, operationId: request.operationId,
      version: request.version, sha256: request.sha256 });
  return <section aria-label={`${moduleId} 安装出站操作`}>
    <p>随附/本机版本仅使用服务端 allowlist 来源，不接受客户端路径，也不表示远端发行签名。
      远端版本使用已验签归档。两者共用每模块的固定操作 ID 与只读读回，不自动安装、接入会话或启动服务。</p>
    <OutgoingModuleStatus operationId={attempt?.request.operationId}
      message={snapshot.message ?? (attempt?.confirmed ? `原安装已只读确认：${attempt.confirmed}` : undefined)} error={snapshot.error} />
    {attempt && <p>固定版本：{attempt.request.version} · {moduleInstallDigestLabel(attempt.request.source)} <code>{attempt.request.sha256}</code></p>}
    {action.error && <p role="alert">{action.error}</p>}
    {reader.error && <p role="alert">{reader.error}</p>}
    {(attempt || latest) && <button className="dialog-btn" disabled={!reader.connected || snapshot.reading || reader.busy}
      onClick={() => { void reader.run(read, onRefresh); }}>读取原安装 ID（不重新安装）</button>}
    {result?.state === 'unknown' && <button className="dialog-btn" disabled={action.busy || snapshot.sending || snapshot.reading}
      onClick={() => {
        void action.run(async () => {
          const checked = await reconcileModuleUpdate(result, message => window.confirm(message),
            body => intent('modules/updates/reconcile', body));
          if (checked) await read();
        }, onRefresh);
      }}>核对安装结果（不重试）</button>}
    {attempt?.confirmed && <button className="dialog-btn" disabled={snapshot.sending || snapshot.reading}
      onClick={() => {
        if (!window.confirm(`原安装已按原 ID 读回为 ${attempt.confirmed}。明确另起安装操作？不会重放旧请求或自动安装。`)) return;
        void action.run(() => operation.newOperation());
      }}>终态已核对，明确另起安装操作</button>}
    {localSourceError && <p role="alert">本机可信来源不可用：{localSourceError}；不回退无 ID 安装接口。</p>}
    {localRelease && <p>
      随附/本机可信版本：{localRelease.version} · {moduleInstallDigestLabel('local')} <code>{localRelease.digest}</code>
      <button className="dialog-btn" disabled={disabled || !action.connected || action.busy || snapshot.sending || !!attempt || !!latestPending || !!localSourceError}
        onClick={() => {
          if (!window.confirm(`安装服务端 allowlist 的 ${moduleId}@${localRelease.version}，本机 inventory SHA256 ${localRelease.digest}？不接收路径、不表示远端发行签名，不自动接入会话或启动服务。结果未知只读取原 ID，不换 ID 重装。`)) return;
          void action.run(() => operation.start(operationId => ({ moduleId, operationId, version: localRelease.version,
            sha256: localRelease.digest, source: 'local' }), submit), onRefresh);
        }}>安装随附/本机可信版本</button>
    </p>}
    {targets.map(target => <p key={`${target.version}:${target.sha256}`}>
      {target.version} · 归档 <code>{target.sha256}</code>
      <button className="dialog-btn" disabled={disabled || !action.connected || action.busy || snapshot.sending || !!attempt || !!latestPending}
        onClick={() => {
          void action.run(() => operation.start(operationId => ({
            moduleId, version: target.version, sha256: target.sha256, operationId,
          }), submit), onRefresh);
        }}>下载并安装此归档</button>
    </p>)}
  </section>;
}

export function WechatUnbindControls({ bindings, disabled, onRefresh }: { bindings: string[]; disabled: boolean; onRefresh: () => void }) {
  const intent = useCockpit(state => state.moduleIntent);
  const [operation] = useState(getWechatUnbind);
  const snapshot = useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
  const action = useKeyedAction('wechat-manual-unbind');
  const reader = useKeyedAction('wechat-manual-unbind-read');
  const attempt = snapshot.attempt;
  return <section aria-label="微信解绑出站操作">
    <OutgoingModuleStatus operationId={attempt?.request.operationId}
      message={snapshot.message ?? (attempt?.confirmed ? `原解绑终态已确认：${attempt.confirmed}。` : undefined)} error={snapshot.error} />
    {attempt && <p>原目标会话：<code>{attempt.request.sessionId}</code></p>}
    {action.error && <p role="alert">{action.error}</p>}
    {reader.error && <p role="alert">原解绑读回失败：{reader.error}</p>}
    {attempt && <button className="dialog-btn" disabled={!reader.connected || reader.busy || snapshot.reading}
      onClick={() => { void reader.run(() => operation.read(async request =>
        (await intent('modules/wechat/unbind/get', { operationId: request.operationId })).operation), onRefresh); }}>
      只读核对原解绑操作（不再次解绑）
    </button>}
    {attempt && !attempt.confirmed && <p role="alert">解绑结果未确认；按原 operationId 和 sessionId 核对历史。
      working、unknown、无记录或读回失败均保留原操作；绑定消失不是原操作成功证明。
      不会再次 POST 解绑来查询，也不会换 ID 重发。</p>}
    {attempt?.confirmed && <button className="dialog-btn" disabled={snapshot.sending || snapshot.reading || action.busy || reader.busy}
      onClick={() => {
        if (!window.confirm(`原解绑终态已确认为 ${attempt.confirmed}。明确允许针对当前绑定另起操作？不会重放原请求，也不会自动解绑后续绑定；仍需再次明确选择目标。`)) return;
        void action.run(() => operation.newOperation());
      }}>原解绑终态已确认，允许新的显式解绑</button>}
    {[...new Set(bindings)].map(sessionId => <button key={sessionId} className="dialog-btn"
      disabled={disabled || !action.connected || action.busy || snapshot.sending || !!attempt}
      onClick={() => {
        if (!window.confirm(`解除微信路由绑定 ${sessionId}？不会删除会话、数据或重发消息；结果未知将保留原 ID，不能重新提交。`)) return;
        void action.run(() => operation.start(operationId => ({ sessionId, operationId, confirm: true }),
          body => intent('modules/wechat/unbind', body)), onRefresh);
      }}>解绑 {sessionId}</button>)}
  </section>;
}
