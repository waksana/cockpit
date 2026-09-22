import { useCallback, type ReactNode } from 'react';
import { Button } from '@cockpit/ui';
import type { ModuleSource } from '@cockpit/protocol';
import { useCockpit } from '../../net/store';
import { useSessionResource } from '../../lib/useSessionResource';
import { useToggleRequests } from '../../features/session-settings/useToggleRequests';
import { Notice, ResourceSwitch, ResumeSession } from './SettingsControls';

function Provenance({ module }: { module?: ModuleSource }) {
  return module ? <p className="next-settings-muted">配置来源：{module.name} ({module.id})
    {module.roles?.map(role => ` / ${role.name} (${role.id})`).join('')}。来源不代表连接或能力就绪。</p> : null;
}
function ResourcesFrame({ sessionId, title, resource, working, children }: {
  sessionId: string; title: string; working: boolean; children: ReactNode;
  resource: { status: string | null; failed: boolean; connected: boolean; requiresResume: boolean;
    closing: boolean; pending: boolean; usable: boolean; refresh: () => Promise<boolean> };
}) {
  return <section className="next-settings-section">
    <div className="next-settings-heading"><h2>{title}</h2>
      <Button variant="outline" disabled={!resource.connected || resource.closing || resource.requiresResume || resource.pending || working}
        onClick={() => { void resource.refresh(); }}>刷新</Button></div>
    {resource.status && <Notice error={resource.failed}>{resource.status}</Notice>}
    {resource.requiresResume && <ResumeSession sessionId={sessionId} onResumed={() => { void resource.refresh(); }} />}
    {!resource.requiresResume && !resource.usable && <p role="status">当前状态尚未确认；旧值不能用于修改。</p>}
    {children}
  </section>;
}
export function SessionMcpSettings({ sessionId }: { sessionId: string }) {
  const read = useCockpit(s => s.mcpSession);
  const mutate = useCockpit(s => s.mcpToggleSession);
  const nativeBusy = useCockpit(s => (s.sessions.find(row => row.sessionId === sessionId)?.activeMcpOperations ?? 0) > 0);
  const load = useCallback(() => read(sessionId), [read, sessionId]);
  const resource = useSessionResource(sessionId, `mcp:${sessionId}`, load, 0, ['mcp']);
  const action = useToggleRequests(sessionId, mutate, resource.refresh, true);
  const busy = action.pending || nativeBusy || !!resource.data?.some(row => row.status === 'pending');
  return <ResourcesFrame title="本会话 MCP" sessionId={sessionId} resource={resource} working={action.pending}>
    <p className="next-settings-muted">启用表示配置未禁用，并不表示已连接。停止状态可能包含原生策略隔离；不能据此推断允许重启。</p>
    {resource.valid && resource.data?.length === 0 && <Notice>本会话没有可用的 MCP 服务器。</Notice>}
    {resource.data?.map(row => <article key={row.name} className="next-settings-resource">
      <div className="next-settings-heading"><h3>{row.name}</h3>
        <span>连接：{resource.usable ? row.status : '未确认'}</span></div>
      <p>{row.detail}</p><Provenance module={row.module} />
      {row.module && <p className="next-settings-muted">角色配置来源无法核验后续同名原生配置替换。</p>}
      <ResourceSwitch identity={`mcp:${sessionId}:${row.name}`} label={`启用 ${row.name}`} enabled={row.enabled}
        disabled={!resource.usable || busy} nativeError={row.error} onChange={enabled => action.run(row.name, enabled)} />
      {row.operation && <details><summary>原生操作详情</summary><pre>{JSON.stringify(row.operation, null, 2)}</pre></details>}
    </article>)}
  </ResourcesFrame>;
}
export function SessionSkillSettings({ sessionId }: { sessionId: string }) {
  const read = useCockpit(s => s.skillsSession);
  const mutate = useCockpit(s => s.skillsToggleSession);
  const load = useCallback(() => read(sessionId), [read, sessionId]);
  const resource = useSessionResource(sessionId, `skills:${sessionId}`, load, 0, ['skills']);
  const action = useToggleRequests(sessionId, mutate, resource.refresh, false);
  return <ResourcesFrame title="本会话 Skills" sessionId={sessionId} resource={resource} working={action.pending}>
    {resource.valid && resource.data?.length === 0 && <Notice>未发现技能。</Notice>}
    {resource.data?.map(row => <article key={row.name} className="next-settings-resource">
      <h3>{row.name}</h3>{row.description && <p>{row.description}</p>}
      {row.source && <p className="next-settings-muted">{row.source}</p>}<Provenance module={row.module} />
      <ResourceSwitch identity={`skills:${sessionId}:${row.name}`} label={`启用 ${row.name}`} enabled={row.enabled}
        disabled={!resource.usable} onChange={enabled => action.run(row.name, enabled)} />
    </article>)}
  </ResourcesFrame>;
}
