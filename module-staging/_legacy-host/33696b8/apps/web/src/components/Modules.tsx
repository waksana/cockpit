import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ModuleConfig, ModuleServiceStatus, type ModuleStatus, type ModuleSelection, type ModuleReleaseMetadata,
  type ModuleServiceJob, type ModuleUpdateOperation } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { useModalFocus } from '../lib/useModalFocus';
import { getModuleServiceOperation, selectedServiceRelease, serviceActionReason, serviceRecoveryReason, serviceJobLabels,
  serviceRecoveryAttemptReason, serviceAttemptCanReset, type ModuleServiceAttempt, type ServiceModuleId } from '../lib/moduleService';
import { moduleInstallDigestLabel, reconcileModuleUpdate } from '../lib/moduleUpdate';
import { getModuleApply } from '../lib/moduleMutation';
import { ModuleInstallControls, OutgoingModuleStatus, WechatUnbindControls } from './ModuleMutationControls';
import { ModuleInitializationControls } from './ModuleInitializationControls';
import { ConsumerLifecycleNotice, VersionProjects } from './SystemVersions';
import { ConsumerRuntime } from './ConsumerRuntime';
import { loadDeliveryStatus } from '../lib/deliveryStatus';
import './Modules.scss';

export function ModuleList({ onClose }: { onClose: () => void }) {
  const intent = useCockpit(state => state.moduleIntent);
  const read = useCallback(async (signal: AbortSignal) => {
    const [modules, updates] = await Promise.all([
      intent('modules/list', {}, signal), intent('modules/updates/status', {}, signal),
    ]);
    return { ...modules, ...updates };
  }, [intent]);
  const resource = useKeyedResource('modules', read);
  const action = useKeyedAction('modules');
  const [editing, setEditing] = useState<ModuleStatus['id']>();
  const [config, setConfig] = useState<ModuleConfig>();
  const [text, setText] = useState('');
  const [release, setRelease] = useState<ModuleReleaseMetadata>();
  const card = useRef<HTMLDivElement>(null), id = useId();
  useModalFocus(card);
  const busy = action.busy;
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.stopImmediatePropagation(); onClose(); }
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [onClose, busy]);
  const refreshAfter = async (work: () => Promise<unknown>) => { await work(); await resource.refresh(); };
  const edit = (moduleId: ModuleStatus['id']) => {
    void action.run(async () => {
      const current = await intent('modules/config/get', { moduleId });
      setConfig(current); setText(JSON.stringify(current.values, null, 2)); setEditing(moduleId);
    });
  };
  return createPortal(<div className="dialog-scrim" onPointerDown={() => { if (!busy) onClose(); }}>
    <div className="dialog-card module-dialog" role="dialog" aria-modal="true" aria-labelledby={id}
      tabIndex={-1} ref={card} onPointerDown={event => event.stopPropagation()}>
      <header><h3 id={id}>模块管理</h3><button className="dialog-btn" disabled={busy} onClick={onClose}>关闭</button></header>
      <p>模块代码、配置和数据独立于本体安装目录。安装不会自动接入既有会话，也不会开启自动安装。</p>
      <ModuleManagementVersions />
      <button type="button" className="dialog-btn" disabled={resource.pending || busy}
        onClick={() => { void resource.refresh(); }}>刷新安装与实际运行状态</button>
      <button type="button" className="dialog-btn" disabled={busy} onClick={() => {
        void action.run(async () => { setRelease(undefined); setRelease(await intent('modules/updates/check', {})); });
      }}>检查官方或已配置信任源的发行更新</button>
      {resource.status && <p role={resource.failed ? 'alert' : 'status'}>{resource.status}</p>}
      {action.error && <p role="alert">{action.error}；结果不明时先刷新，不要重复提交。</p>}
      {release && <section className="module-card">
        <h4>已验签的发行目录 · sequence {release.sequence}</h4>
        <p>检查不等于安装。仅在本机信任的发布者签名和来源范围内下载；不会自动应用到会话或运行服务。</p>
        {release.targets.map(target => <p key={`${target.moduleId}:${target.version}`}>
          {target.moduleId} {target.version} · {target.platform}/{target.arch} · <code>{target.sha256.slice(0, 12)}</code>
        </p>)}
      </section>}
      {resource.valid && resource.data?.operations.map(operation => <ModuleUpdateDetails key={operation.operationId}
        operation={operation} busy={busy} onReconcile={() => {
          void action.run(async () => {
            const result = await reconcileModuleUpdate(operation, message => window.confirm(message),
              body => intent('modules/updates/reconcile', body));
            if (result) await resource.refresh();
          });
        }} />)}
      {resource.valid && resource.data?.modules.map(module => <section key={module.id} className="module-card">
        <h4>{module.name}</h4><p>{module.description}</p>
        <ModuleVersionDetails module={module} />
        <div className="module-actions">
          <button className="dialog-btn" disabled={busy} onClick={() => edit(module.id)}>配置</button>
          {module.page && <a href={module.page}>打开模块页面</a>}
        </div>
        <ModuleInstallControls moduleId={module.id} disabled={busy}
          localRelease={module.localRelease} localSourceError={module.localSourceError}
          targets={release?.targets.filter(target => target.moduleId === module.id) ?? []}
          latest={resource.data?.operations.find(operation => operation.moduleId === module.id)}
          onRefresh={() => { void resource.refresh(); }} />
        {module.id === 'task' && <ModuleInitializationControls module={module} disabled={busy}
          onRefresh={() => { void resource.refresh(); }} />}
        {module.id !== 'assistant' && <ModuleServiceControls module={module} moduleId={module.id} disabled={busy} />}
        {module.roles.filter(role => role.boundSessionId).map(role => <p key={role.roleId}>
          绑定会话：<a href={`/session/${role.boundSessionId}`}>{role.boundSessionId}</a>
        </p>)}
        {module.id === 'wechat' && <WechatUnbindControls disabled={busy}
          bindings={module.roles.flatMap(role => role.boundSessionId ? [role.boundSessionId] : [])}
          onRefresh={() => { void resource.refresh(); }} />}
        {!!module.installed.length && <button className="dialog-btn" disabled={busy} onClick={() => {
          if (!window.confirm('卸载模块接入？保留配置和数据；仍被会话或服务使用时将拒绝卸载。')) return;
          void action.run(() => refreshAfter(() => intent('modules/uninstall', { moduleId: module.id, confirm: true })));
        }}>卸载并保留数据</button>}
      </section>)}
      {editing && config && <section className="module-config">
        <h4>{editing} 配置 · revision {config.revision}</h4>
        <p>仅配置服务地址、数据位置和凭据文件引用；不要填写 token 正文。修改不会搬迁数据或启动服务。</p>
        <textarea aria-label="模块配置 JSON" value={text} disabled={busy} onChange={event => setText(event.target.value)} />
        <button className="dialog-btn" disabled={busy} onClick={() => {
          void action.run(async () => {
            const next = ModuleConfig.parse({ ...config, values: JSON.parse(text) });
            const saved = await intent('modules/config/set', next);
            setConfig(saved); setText(JSON.stringify(saved.values, null, 2)); await resource.refresh();
          });
        }}>保存配置</button>
        <button className="dialog-btn" disabled={busy} onClick={() => setEditing(undefined)}>关闭配置</button>
      </section>}
    </div>
  </div>, document.body);
}

export function ModuleManagementVersions() {
  const versions = useKeyedResource('module-management-system-versions', loadDeliveryStatus);
  const sessions = useCockpit(state => state.sessions);
  const [sessionId, setSessionId] = useState('');
  return <section aria-label="主程序与会话应用版本">
    <h4>主程序 / 系统版本</h4>
    <ConsumerLifecycleNotice />
    <ConsumerRuntime>
    {versions.status && <p role={versions.failed ? 'alert' : 'status'}>{versions.status}；旧结果不作当前版本。</p>}
    {versions.valid && versions.data && <VersionProjects status={versions.data} />}
    <button className="dialog-btn" disabled={!versions.connected || versions.pending}
      onClick={() => { void versions.refresh(); }}>刷新主程序实际版本</button>
    </ConsumerRuntime>
    <h4>会话应用版本</h4>
    <label>按需核对一个已有会话
      <select aria-label="核对模块应用版本的会话" value={sessionId} onChange={event => setSessionId(event.target.value)}>
        <option value="">请选择会话（不自动加载全部会话）</option>
        {sessionId && !sessions.some(session => session.sessionId === sessionId) &&
          <option value={sessionId}>{sessionId}（已不在当前会话列表）</option>}
        {sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.title || session.sessionId}</option>)}
      </select>
    </label>
    {sessionId && <SessionModuleVersions key={sessionId} sessionId={sessionId} />}
    <p>主程序版本复用系统权威版本接口；会话应用版本按选择只读核对。各模块的已安装、selected 与服务实际运行版本在下方分别显示，不互相代替。</p>
  </section>;
}

export function ModuleUpdateDetails({ operation, busy, onReconcile }: {
  operation: ModuleUpdateOperation; busy: boolean; onReconcile: () => void;
}) {
  return <div>
    <p role="status">{operation.moduleId}@{operation.version} 安装操作：{operation.state}
      {operation.error && ` · ${operation.error}`} · <code>{operation.operationId}</code></p>
    <p>{moduleInstallDigestLabel(operation.source)}：<code>{operation.sha256}</code></p>
    {operation.state === 'unknown' && <button className="dialog-btn" disabled={busy} onClick={onReconcile}>
      核对安装结果（不重试）
    </button>}
  </div>;
}

export function ModuleVersionDetails({ module }: { module: ModuleStatus }) {
  return <>
    <p>已安装：{module.installed.length ? module.installed.map(value => <span key={value.version}>
      {value.version} · digest <code>{value.digest}</code>；</span>) : '未安装'}</p>
    <p>新接入选择（selected）：{module.selectedVersion ?? '无'} · digest <code>{selectedServiceRelease(module)?.digest ?? '未确认'}</code></p>
    <p>安装或选择新版不切换运行版本；共享服务须另行安全应用，会话仍保留各自绑定版本。</p>
    {module.service.ownership !== 'none' && <p>实际服务报告：{module.service.ownership === 'external' ? '外部管理' : 'Cockpit 管理'} · {module.service.status}
      {module.service.version && ` · ${module.service.version}`} · digest <code>{module.service.digest ?? '未确认'}</code>
      {module.service.instanceId && ` · instance ${module.service.instanceId}`}
      {module.service.reason && ` · ${module.service.reason}`}</p>}
  </>;
}

export function ServiceJobDetails({ job }: { job: ModuleServiceJob }) {
  return <div role="status">
    <p>作业 ID：<code>{job.command.operationId}</code> · {job.command.action} · {serviceJobLabels[job.phase]} · {job.step}</p>
    {job.reason && <p>等待/结果原因：{job.reason}</p>}
    {job.command.version && <p>本次目标：{job.command.version} · digest <code>{job.command.digest}</code></p>}
    {job.command.recoveryOf && <p>本次仅恢复停止，原故障作业：<code>{job.command.recoveryOf}</code>；旧作业结果保留。</p>}
    {job.result && <p>作业结果报告：{job.result.state}；当前是否仍在运行须以实际状态读回为准。</p>}
  </div>;
}

export function ServiceRecoveryControl({ module, runner, attempt, blocked, onRecover }: {
  module: ModuleStatus; runner?: ModuleServiceStatus; attempt?: ModuleServiceAttempt; blocked: boolean; onRecover: () => void;
}) {
  if (serviceRecoveryReason(module, runner)) return null;
  const reason = serviceRecoveryAttemptReason(runner, attempt);
  return <>
    <button className="dialog-btn" disabled={blocked || !!reason} onClick={onRecover}>确认后安全排空/恢复停止</button>
    {reason && <p role="status">{reason}</p>}
  </>;
}

export function ModuleServiceControls({ module, moduleId, disabled = false }: {
  module: ModuleStatus; moduleId: ServiceModuleId; disabled?: boolean;
}) {
  const intent = useCockpit(state => state.moduleIntent);
  const [operation] = useState(() => getModuleServiceOperation(moduleId));
  const recoveryView = useRef<object | null>(null);
  useEffect(() => {
    recoveryView.current = {};
    return () => { recoveryView.current = null; };
  }, [moduleId]);
  const outgoing = useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
  const load = useCallback(async (signal: AbortSignal) => {
    const result = ModuleServiceStatus.parse(await intent('modules/service/status', { moduleId }, signal));
    if (result.id !== moduleId) throw new Error('运行器状态属于其他模块，未采纳。');
    return result;
  }, [intent, moduleId]);
  const resource = useKeyedResource(`module-service-status:${moduleId}`, load, 0, module.service.ownership === 'managed');
  const action = useKeyedAction(`module-service-command:${moduleId}`);
  const readAction = useKeyedAction(`module-service-read:${moduleId}`);
  const runner = resource.valid ? resource.data : undefined;
  const attempt = outgoing.attempt;
  const recovery = attempt?.recovery;
  const canNewOperation = serviceAttemptCanReset(attempt);
  const read = () => {
    void readAction.run(() => operation.read(operationId => intent('modules/service/job', { operationId }), runner?.job),
      () => { void resource.refresh(); });
  };
  const send = (command: 'start' | 'stop' | 'apply') => {
    if (!runner) return;
    void action.run(() => operation.send(module, runner, command, body => intent('modules/service', body)),
      () => { void resource.refresh(); });
  };
  return <section aria-label={`${module.name} 独立服务控制`}>
    <p>服务操作由独立运行器受理。受理、执行中和等待均不代表服务已运行；安全停止只请求排空并等待退出，不强停。</p>
    {module.service.ownership !== 'managed' && <p>此服务不是 Cockpit 托管；不接管外部进程。</p>}
    {resource.status && <p role={resource.failed ? 'alert' : 'status'}>{resource.status}</p>}
    {runner && <>
      <p>独立运行器实际状态：{runner.status} · 当前进程 owned：{runner.owned ? '是' : '否'}
        {runner.pid && ` · PID ${runner.pid}`}{runner.expectedPid && ` · 历史/预期 PID ${runner.expectedPid}`}</p>
      {runner.identity && <p>本次实际核对身份：{runner.identity.moduleVersion} · digest <code>{runner.identity.moduleDigest}</code>
        {' · instance '}{runner.identity.instanceId}</p>}
      {runner.expectedIdentity && <p>历史/预期身份（不是实际运行证明）：{runner.expectedIdentity.moduleVersion}
        {' · digest '}<code>{runner.expectedIdentity.moduleDigest}</code>{' · instance '}{runner.expectedIdentity.instanceId}</p>}
      {runner.recoveryRequired && <p role="alert">{runner.canRecoverStop === true
        ? '普通启动/应用仍被禁止；运行器仅允许经明确确认的安全恢复停止，不替换实例或强停。'
        : '须宿主核对原进程；当前运行器不允许安全恢复，不提供自动接管或强停。'}</p>}
      {runner.reason && <p>运行器原因：{runner.reason}</p>}
      {runner.job && <><p>运行器当前作业：</p><ServiceJobDetails job={runner.job} /></>}
    </>}
    {outgoing.error && <p role="alert">{outgoing.error}</p>}
    {action.error && <p role="alert">{action.error}</p>}
    {readAction.error && <p role="alert">{readAction.error}</p>}
    {attempt && <div>
      <p>浏览器保留的原操作：<code>{attempt.request.operationId}</code> · {attempt.request.action}
        {attempt.request.version && ` · ${attempt.request.version}`} {attempt.request.digest && <code>{attempt.request.digest}</code>}</p>
      {attempt.request.recoveryOf && <p>GUI 当前恢复链节关联此前作业：<code>{attempt.request.recoveryOf}</code>；此前历史保留在后台，不表示已恢复。</p>}
      {outgoing.job ? <><p>最近一次原操作回执（不是当前进程状态）：</p><ServiceJobDetails job={outgoing.job} /></>
        : <p>结果待确认；关闭或刷新不会换 ID 重发。</p>}
      {attempt.terminal ? <p>已明确读回原作业终态：{attempt.terminal}。{recovery ? '还须核对恢复停止的独立结果。'
        : canNewOperation ? '可以显式开始新操作，不自动重试。' : '不能开启普通新操作；仅在运行器授权且再次明确确认后推进安全停止恢复。'}</p>
        : <p>请读取原 ID；结果未知或尚无回执时不能替换操作。</p>}
    </div>}
    {recovery && <div>
      <p>保留的恢复停止 ID：<code>{recovery.request.operationId}</code> · 原故障 ID：<code>{recovery.request.recoveryOf}</code></p>
      {outgoing.recoveryJob ? <ServiceJobDetails job={outgoing.recoveryJob} />
        : <p>恢复停止结果待确认；只读这个恢复 ID，不再次发送恢复请求。</p>}
      {recovery.terminal && <p>已明确读回恢复终态：{recovery.terminal}；旧故障作业结果不变。</p>}
    </div>}
    <div className="module-actions">
      <button className="dialog-btn" disabled={module.service.ownership !== 'managed' || !resource.connected || resource.pending}
        onClick={() => { void resource.refresh(); }}>读取实际服务状态</button>
      <button className="dialog-btn" disabled={!resource.connected || outgoing.reading || readAction.busy || (!attempt && !runner?.job)}
        onClick={read}>读取原作业状态（不重发）</button>
      {recovery && <button className="dialog-btn" disabled={!resource.connected || outgoing.reading || readAction.busy}
        onClick={() => { void readAction.run(() => operation.readRecovery(operationId => intent('modules/service/job', { operationId })),
          () => { void resource.refresh(); }); }}>读取恢复停止作业（不重发）</button>}
      {canNewOperation && <button className="dialog-btn" disabled={outgoing.busy || outgoing.reading || readAction.busy}
        onClick={() => { void readAction.run(() => operation.newOperation()); }}>原作业已确认，开始新的服务操作</button>}
      <ServiceRecoveryControl module={module} runner={runner} attempt={attempt}
        blocked={disabled || !resource.connected || resource.pending || outgoing.busy || outgoing.reading || action.busy}
        onRecover={() => {
          if (!runner) return;
          const view = recoveryView.current;
          const generation = useCockpit.getState().connectionGeneration;
          void action.run(async () => {
            const latest = await intent('modules/service/status', { moduleId });
            await operation.recover(module, latest, message => {
              const connection = useCockpit.getState();
              if (!view || recoveryView.current !== view || connection.connState !== 'open'
                || connection.connectionGeneration !== generation) throw new Error('恢复确认界面已关闭或连接已改变；尚未发送。');
              return window.confirm(message);
            },
              body => intent('modules/service', body));
          }, () => { void resource.refresh(); });
        }} />
    </div>
    <div className="module-actions">{(['start', 'stop', 'apply'] as const).map(command => {
      const reason = serviceActionReason(module, runner, command);
      const label = command === 'start' ? '启动所选已安装版本' : command === 'stop' ? '安全停止' : '安全应用所选已安装版本';
      return <div key={command}>
        <button className="dialog-btn" disabled={disabled || !resource.valid || action.busy || outgoing.busy || !!attempt || !!reason}
          onClick={() => send(command)}>{label}</button>
        {reason && <small>{reason}</small>}
      </div>;
    })}</div>
  </section>;
}

export function SessionModuleVersions({ sessionId }: { sessionId: string }) {
  const intent = useCockpit(state => state.moduleIntent);
  const read = useCallback(async (signal: AbortSignal) => {
    const [bound, available] = await Promise.all([
      intent('session/modules/get', { sessionId }, signal), intent('modules/list', {}, signal),
    ]);
    return { bound: bound.modules, available: available.modules };
  }, [intent, sessionId]);
  const resource = useKeyedResource(`session-modules:${sessionId}`, read);
  const action = useKeyedAction(`session-modules:${sessionId}`);
  const reader = useKeyedAction(`session-modules-read:${sessionId}`);
  const operation = useMemo(() => getModuleApply(sessionId), [sessionId]);
  const outgoing = useSyncExternalStore(operation.subscribe, operation.getSnapshot, operation.getSnapshot);
  const attempt = outgoing.attempt;
  const binding = resource.valid ? resource.data?.bound : undefined;
  const candidate = binding?.selections.map(selection => ({
    ...selection,
    version: resource.data?.available.find(module => module.id === selection.moduleId)?.selectedVersion ?? selection.version,
  }));
  const changed = candidate?.some((selection, index) => selection.version !== binding?.selections[index]?.version);
  const readOriginal = () => operation.read(
    async request => (await intent('session/modules/get', { sessionId: request.sessionId })).modules,
    binding ? { sessionId, operationId: binding.operationId, selections: binding.pendingSelections ?? binding.selections } : undefined);
  const apply = (selections: ModuleSelection[]) => {
    void action.run(() => operation.start(operationId => ({ sessionId, selections, operationId }),
      async body => (await intent('session/modules/apply', body)).modules), () => { void resource.refresh(); });
  };
  return <section className="session-module-versions">
    <h4>本会话模块</h4>
    {resource.status && <p role={resource.failed ? 'alert' : 'status'}>{resource.status}</p>}
    {action.error && <p role="alert">{action.error}</p>}
    {reader.error && <p role="alert">{reader.error}</p>}
    <OutgoingModuleStatus operationId={attempt?.request.operationId}
      message={outgoing.message ?? (attempt?.confirmed ? '原应用已按 ID 与实际选择确认成功。' : undefined)} error={outgoing.error} />
    {attempt && <p>原请求固定选择：{attempt.request.selections.map(selection => `${selection.moduleId}/${selection.roleId}@${selection.version}`).join('、')}</p>}
    {(attempt || binding) && <button className="dialog-btn" disabled={!reader.connected || reader.busy || outgoing.reading}
      onClick={() => { void reader.run(readOriginal); }}>核对原接入 operationId 与实际选择（只读）</button>}
    {attempt?.confirmed && <button className="dialog-btn" disabled={outgoing.sending || outgoing.reading}
      onClick={() => {
        if (!window.confirm('已按原 ID 和实际选择确认应用成功。明确允许下一次应用？不会自动提交。')) return;
        void action.run(() => operation.newOperation());
      }}>原应用已确认，允许新的显式应用</button>}
    {binding ? <>
      <p>接入状态：{binding.phase}{binding.error && ` · ${binding.error}`}</p>
      {binding.nativePresent === false && <p role="alert">这是保留的模块操作记录；原生会话尚未确认存在。不要自动创建替代会话。</p>}
      {binding.selections.map(selection => <p key={selection.moduleId}>{selection.moduleId} / {selection.roleId} · 已应用 {selection.version}</p>)}
      {binding.pendingSelections && <p>尚未完成：{binding.pendingSelections.map(selection => `${selection.moduleId}@${selection.version}`).join('、')}。先核对部分结果，不自动重放。</p>}
      {binding.pendingSelections && ['failed', 'unknown'].includes(binding.phase) && <button className="dialog-btn"
        disabled={action.busy || outgoing.sending || outgoing.reading} onClick={() => {
          void action.run(async () => {
            await readOriginal();
            await operation.resume(() => window.confirm('只读已核对原操作 ID 和待应用选择。确认仅继续这个保留操作？不创建替代会话、不换 ID；未知凭据/微信结果仍可能拒绝继续。'),
              async body => (await intent('session/modules/apply', body)).modules);
          }, () => { void resource.refresh(); });
        }}>核对后继续保留的操作</button>}
      {binding.phase === 'applied' && changed && candidate && <button className="dialog-btn"
        disabled={action.busy || outgoing.sending || !!attempt} onClick={() => apply(candidate)}>
        在安全空闲时应用已安装新版
      </button>}
      <p>冷加载恢复绑定版本。应用新版不会清除旧上下文、重跑首次问卷或任务；共享服务运行版本另见模块管理。</p>
    </> : resource.valid && <p>未接入角色模块。</p>}
    <button className="dialog-btn" disabled={resource.pending || action.busy} onClick={() => { void resource.refresh(); }}>刷新模块版本</button>
  </section>;
}
