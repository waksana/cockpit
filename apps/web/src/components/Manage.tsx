// Per-session MCP and Skills use the same row presentation, not the same
// mutation policy: MCP writes are serialized by the native host.
import { useCallback, useState, type ReactNode } from 'react';
import type { ChatSession } from '../net/types';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useSessionResource } from '../lib/useSessionResource';
import { McpStatusPill } from './McpStatus';
import { PanelCloseButton } from './PanelPage';
import { RefreshButton } from './Button';
import { SessionResume } from './SessionResume';
import { PaneBody, PaneHeader } from './PaneHeader';
import { ModuleSourceBadge } from './ModuleLabel';
import type { ModuleSource } from '@cockpit/protocol';
import { ResourceError, ResourceProgress, ResourceRow, ResourceText } from './ResourceRow';
import { Toggle } from './UI';
import { ResourceStatus, StateNotice } from './StateNotice';
import { useToggleRequests } from '../features/session-settings/useToggleRequests';
import { skillSummary } from '../lib/resourcePresentation';

function SessionToggleRow({ identity, name, summary, module, status, enabled, disabled, disabledReason, nativeError, onChange }: {
  identity: string; name: string; summary?: string; status?: ReactNode; enabled: boolean;
  module?: ModuleSource;
  disabled: boolean; disabledReason?: string; nativeError?: string; onChange: (name: string, enabled: boolean) => Promise<void>;
}) {
  const action = useKeyedAction(identity);
  const [desired, setDesired] = useState(enabled);
  return <ResourceRow name={name} connection={Boolean(status)} title={disabled ? disabledReason : undefined}
    badge={module && <ModuleSourceBadge module={module}
      description={status ? '角色配置来源，不代表当前连接身份；无法核验后续同名配置替换' : undefined} />}
    summary={summary && <ResourceText key={summary} text={summary} label={`${name}摘要`} />}
    control={<Toggle label={`本会话启用 ${name}`} disabled={disabled || action.busy} busy={action.busy} on={enabled}
      onChange={next => {
        if (disabled || action.busy) return;
        setDesired(next);
        void action.run(() => onChange(name, next));
      }} />}
    status={action.busy ? <ResourceProgress>
      {status ? desired ? '连接中' : '断开中' : desired ? '启用中' : '停用中'}</ResourceProgress> : status}
    feedback={<>
      {nativeError && <ResourceError key={JSON.stringify([identity, 'native', nativeError])}
        error={nativeError} name={`${name}连接错误`} label="连接错误" />}
      {action.error && !action.busy && action.error !== nativeError
        && <ResourceError key={JSON.stringify([identity, 'action', action.error])} error={action.error} name={name}
          cause={action.errorCause} action={`${desired ? '启用' : '停用'} ${name}`} />}
    </>} />;
}

function ManageShell({ title, onClose, refresh, status, failed, pending, hasData, working, blocked, empty, children }: {
  title: string; onClose: () => void; refresh: () => void; status: string | null;
  failed: boolean; pending: boolean; hasData: boolean; working: boolean; blocked: boolean;
  empty?: ReactNode; children: ReactNode;
}) {
  return <>
    <PaneHeader leading={<PanelCloseButton onClose={onClose} />}
      title={<span className="pane-title" title={title}>{title}</span>}
      actions={<RefreshButton pending={hasData && pending && !working}
        disabled={blocked || pending || working} onClick={refresh} />} />
    <PaneBody className="manage-body">
      <ResourceStatus status={hasData && pending ? null : status} failed={failed}
        pending={pending} placement={hasData ? 'inline' : 'pane'} />
      {children}
      {empty && <StateNotice kind="empty" placement="pane">{empty}</StateNotice>}
    </PaneBody>
  </>;
}

type SessionManageProps = { session: ChatSession; onClose: () => void };

export function SessionMcp({ session, onClose }: SessionManageProps) {
  const sessionId = session.sessionId;
  const mcpSession = useCockpit(s => s.mcpSession);
  const mutate = useCockpit(s => s.mcpToggleSession);
  const nativeBusy = useCockpit(s => (s.sessions.find(row => row.sessionId === sessionId)?.activeMcpOperations ?? 0) > 0);
  const load = useCallback(() => mcpSession(sessionId), [mcpSession, sessionId]);
  const resource = useSessionResource(sessionId, `mcp:${sessionId}`, load, 0, ['mcp']);
  const action = useToggleRequests(sessionId, mutate, resource.refresh, true);
  const settling = resource.data?.some(server => server.status === 'pending') ?? false;
  const busy = action.pending || nativeBusy || settling;
  return <ManageShell title="本会话 MCP" onClose={onClose}
    refresh={() => { void resource.refresh(); }} status={resource.status} failed={resource.failed}
    pending={resource.pending} hasData={resource.data !== undefined} working={action.pending}
    blocked={resource.closing || resource.requiresResume || !resource.connected}
    empty={resource.valid && resource.data?.length === 0 ? '本会话没有可用的 MCP 服务器' : undefined}>
    <SessionResume sessionId={sessionId} required={resource.requiresResume} onResumed={() => { void resource.refresh(); }} />
    {resource.data?.map(server => <SessionToggleRow key={JSON.stringify([sessionId, server.name])}
      identity={JSON.stringify(['mcp', sessionId, server.name])} name={server.name}
      module={server.module} nativeError={server.error} status={<McpStatusPill status={server.status} appearance="text" />}
      enabled={server.enabled} disabled={!resource.usable || busy}
      disabledReason={busy ? 'MCP 正在切换或连接，请等待完成后再修改。' : undefined} onChange={action.run} />)}
  </ManageShell>;
}

export function SessionSkills({ session, onClose }: SessionManageProps) {
  const sessionId = session.sessionId;
  const skillsSession = useCockpit(s => s.skillsSession);
  const mutate = useCockpit(s => s.skillsToggleSession);
  const load = useCallback(() => skillsSession(sessionId), [skillsSession, sessionId]);
  const resource = useSessionResource(sessionId, `skills:${sessionId}`, load, 0, ['skills']);
  const action = useToggleRequests(sessionId, mutate, resource.refresh, false);
  return <ManageShell title="本会话 Skills" onClose={onClose}
    refresh={() => { void resource.refresh(); }} status={resource.status} failed={resource.failed}
    pending={resource.pending} hasData={resource.data !== undefined} working={action.pending}
    blocked={resource.closing || resource.requiresResume || !resource.connected}
    empty={resource.valid && resource.data?.length === 0 ? '未发现技能' : undefined}>
    <SessionResume sessionId={sessionId} required={resource.requiresResume} onResumed={() => { void resource.refresh(); }} />
    {resource.data?.map(skill => <SessionToggleRow key={JSON.stringify([sessionId, skill.name])}
      identity={JSON.stringify(['skills', sessionId, skill.name])} name={skill.name}
      summary={skillSummary(skill.source, skill.description)} module={skill.module}
      enabled={skill.enabled} disabled={!resource.usable} onChange={action.run} />)}
  </ManageShell>;
}
