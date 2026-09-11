import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { DeliveryStatus } from '@cockpit/protocol';
import { useModalFocus } from '../lib/useModalFocus';
import { deliveryStateLabels, waitingLabel } from '../lib/deliveryStatus';
import './SystemVersions.scss';

export function VersionProjects({ status }: { status: DeliveryStatus }) {
  return <>{status.projects.map(project => {
    const current = project.runtime;
    const request = project.pending ?? project.latest;
    return <section key={project.projectId} className="system-version-project">
      <h4>{project.name} <small>{project.environment}</small></h4>
      <p>当前进程：{current.available
        ? <><code>{current.version ?? '版本号未提供'} · {current.sha?.slice(0, 8) ?? 'SHA 未知'}</code> · {current.healthy ? '健康' : '健康未确认'}</>
        : <>不可用 / 未运行（{current.error ?? '未知'}）</>}</p>
      {current.instanceId && <p className="system-version-detail">实例 <code>{current.instanceId}</code></p>}
      {project.prepared && <p>准备好的版本：<code>{project.prepared.sha.slice(0, 8)}</code> · {project.prepared.intent === 'build-only' ? '仅构建，未启用' : '待生效'}</p>}
      {request && <p>交付：{deliveryStateLabels[request.state]} · <code>{request.sha.slice(0, 8)}</code>
        {request.failure && <> · {request.failure.code}</>}</p>}
      {waitingLabel(project.waitingReason) && <p role="status">{waitingLabel(project.waitingReason)}</p>}
      {current.lifecycle?.restartPending && !project.pending && <p>普通安全重启已请求；没有新的部署候选，不能据此宣称正在更新版本。</p>}
      <p className="system-version-detail">按需读取于 {new Date(project.observedAt).toLocaleString()}</p>
    </section>;
  })}</>;
}

export function SystemVersions({ status, error, loading, onRefresh, onClose }: {
  status: DeliveryStatus | null; error: string | null; loading: boolean; onRefresh: () => void; onClose: () => void;
}) {
  const card = useRef<HTMLDivElement>(null), id = useId();
  useModalFocus(card);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [onClose]);
  return createPortal(<div className="dialog-scrim" onPointerDown={onClose}>
    <div className="dialog-card system-versions" role="dialog" aria-modal="true" aria-labelledby={id}
      tabIndex={-1} ref={card} onPointerDown={event => event.stopPropagation()}>
      <header><h3 id={id}>系统 / 版本与更新</h3><button className="dialog-btn" onClick={onClose}>关闭</button></header>
      <button className="dialog-btn" onClick={onRefresh} disabled={loading}>{loading ? '读取中…' : '刷新实际状态'}</button>
      {error && <p role="alert">{error}；旧结果不作当前状态。</p>}
      {!error && status && <VersionProjects status={status} />}
      <details><summary>MCP 与 Skill 更新边界</summary>
        <p>MCP 未来启动入口随发布包更新。现有连接实际载入版本若未提供身份则未知；不能声称所有外部 MCP 已更新。
          Cockpit 的安全重启只影响其管理的连接，临时启用配置可能按原生全局默认重置。</p>
        <p>Skill 文件与引用刷新原生发现后供后续使用。已进入模型上下文的旧指令不会因文件刷新或服务重启被抹除；本页不推测每个 agent 的上下文版本。</p>
      </details>
      <p className="system-version-detail">进程 /version 与交付 runner 分别提供版本和更新状态；不把 main HEAD、restart 布尔值或旧结果当作运行版本。本页仅在打开和刷新时读取。</p>
    </div>
  </div>, document.body);
}
