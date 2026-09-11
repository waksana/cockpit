import { useCallback, useState, useSyncExternalStore } from 'react';
import { ModuleInitializationRequest, type ModuleConfig, type ModuleStatus } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { getModuleInitialization, moduleInitializationReason } from '../lib/moduleInitialization';
import { selectedServiceRelease } from '../lib/moduleService';
import { OutgoingModuleStatus } from './ModuleMutationControls';

export function TaskInitializationReferences({ config }: { config: ModuleConfig }) {
  return <div>
    <p>Task 当前配置 revision {config.revision}；这里只显示文件引用，不读取凭据正文。</p>
    {['serviceUrl', 'gatewayUrl', 'dataDirectory', 'credentialDirectory', 'managerCredentialFile', 'viewerCredentialFile']
      .map(key => typeof config.values[key] === 'string' ? <p key={key}>{key}：<code>{config.values[key]}</code></p> : null)}
  </div>;
}

export function ModuleInitializationControls({ module, disabled, onRefresh }: {
  module: ModuleStatus; disabled: boolean; onRefresh: () => void;
}) {
  const intent = useCockpit(state => state.moduleIntent);
  const [operation] = useState(getModuleInitialization);
  const snapshot = useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
  const [gatewayUrl, setGatewayUrl] = useState(() => globalThis.location?.origin ?? '');
  const load = useCallback(async (signal: AbortSignal) => {
    const config = await intent('modules/config/get', { moduleId: 'task' }, signal);
    if (config.moduleId !== 'task') throw new Error('配置回执模块标识不匹配，未采纳。');
    return config;
  }, [intent]);
  const config = useKeyedResource('task-initialization-config', load, 0,
    module.id === 'task' && (module.supportsInitialization === true || !!snapshot.attempt));
  const action = useKeyedAction('task-config-initialize'), reader = useKeyedAction('task-config-initialize-read');
  if (module.id !== 'task' || (module.supportsInitialization !== true && !snapshot.attempt)) return null;
  const reason = moduleInitializationReason(module, config.valid ? config.data : undefined);
  const release = selectedServiceRelease(module), attempt = snapshot.attempt;
  const gateway = attempt?.request.gatewayUrl ?? gatewayUrl;
  const validGateway = ModuleInitializationRequest.shape.gatewayUrl.safeParse(gateway).success;
  const refreshed = () => { void config.refresh(); onRefresh(); };
  const configured = config.valid && config.data && (config.data.revision !== 0 || Object.keys(config.data.values).length > 0);
  return <section aria-label="全新 Task 配置初始化">
    <h5>全新 Task 配置初始化</h5>
    {config.status && <p role={config.failed ? 'alert' : 'status'}>{config.status}</p>}
    {reason && <p>{reason}</p>}
    <OutgoingModuleStatus operationId={attempt?.request.operationId}
      message={snapshot.message ?? (attempt?.confirmed ? `原初始化已读回：${attempt.confirmed}；仍保留原 ID，不重新签发。` : undefined)}
      error={snapshot.error} />
    {action.error && <p role="alert">{action.error}</p>}
    {reader.error && <p role="alert">{reader.error}</p>}
    <p>固定初始化版本：{attempt?.request.version ?? release?.version ?? '未选择'} · digest <code>{attempt?.request.digest ?? release?.digest ?? '未确认'}</code></p>
    {!configured && module.supportsInitialization === true && <label>公开 HTTPS 网关源
      <input aria-label="Task 初始化 HTTPS 网关源" value={gateway} disabled={!!attempt || action.busy || snapshot.sending}
        onChange={event => setGatewayUrl(event.target.value)} placeholder="https://cockpit.example" />
    </label>}
    {attempt && <p>原请求网关：<code>{attempt.request.gatewayUrl}</code></p>}
    {!configured && !validGateway && <p role="alert">必须填写规范 HTTPS origin，可含非默认端口；不能含路径、尾部斜杠、账号、查询或片段。</p>}
    {!configured && module.supportsInitialization === true && <button className="dialog-btn"
      disabled={disabled || !action.connected || action.busy || snapshot.sending || !!attempt || !!reason || !validGateway}
      onClick={() => {
        void action.run(() => operation.initialize(module, config.valid ? config.data : undefined, gateway,
          message => window.confirm(message), async body => (await intent('modules/config/initialize', body)).operation), refreshed);
      }}>初始化全新 Task 配置</button>}
    {attempt && <button className="dialog-btn" disabled={!reader.connected || snapshot.reading || reader.busy}
      onClick={() => { void reader.run(() => operation.read(async request =>
        (await intent('modules/config/initialization', { operationId: request.operationId })).operation), refreshed); }}>
      只读核对原初始化 ID（不重新签发）
    </button>}
    {config.valid && config.data && <TaskInitializationReferences config={config.data} />}
    {snapshot.result?.phase === 'succeeded' && <p role="status">初始化已报告成功；不代表服务已启动。请核对刷新后的配置与模块状态，再明确点击“启动所选已安装版本”。</p>}
    <p>仅新空 data/task 创建私有 manager 和只读 viewer；已有配置/数据保持不动且拒绝接管。
      不启动服务、不新建 caller/session、不发消息。关闭或刷新保留原操作；preparing/unknown/failed 不作为重新初始化的许可。</p>
  </section>;
}
