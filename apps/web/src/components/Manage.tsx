// Per-session MCP and Skills use the same row presentation, not the same
// mutation policy: MCP writes are serialized by the native host.
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatSession } from '../net/types';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useSessionResource } from '../lib/useSessionResource';
import { McpStatusPill } from './McpStatus';
import { PanelCloseButton, RefreshButton, ResourceStatus, SessionResume } from './SessionPanelKit';
import { useClippedText } from '../lib/useClippedText';
import { PaneHeader } from './PaneHeader';
import { Icon } from './Icon';

export function Toggle({ on, onChange, disabled, label, busy }: {
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; busy?: boolean;
}) {
  return <button type="button" role="switch" aria-label={label} aria-checked={on}
    aria-busy={busy || undefined} disabled={disabled} className={`switch ck-button${on ? ' is-on' : ''}`}
    onClick={() => onChange(!on)}><span className="switch-knob" /></button>;
}

// The text itself is the disclosure target: discovering overflow never adds a row.
function RowText({ text, label, lines = 1 }: { text: string; label: string; lines?: 1 | 2 }) {
  const id = useId();
  const { ref, clipped } = useClippedText(text, lines);
  const [expanded, setExpanded] = useState(false);
  const content = <span ref={ref} id={id} className="manage-row-text" data-lines={lines}
    data-expanded={expanded || undefined}>{text}</span>;
  return clipped || expanded
    ? <button type="button" className="manage-text-disclosure ck-button"
      aria-label={`${expanded ? '收起' : '展开'}${label}`} aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(!expanded)}>{content}</button>
    : content;
}

function RowError({ error, name }: { error: string; name: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return <>
    <div className="manage-row-status" role="status">
      <button type="button" className="manage-error-disclosure ck-button"
        aria-label={`${expanded ? '收起' : '展开'}${name}错误详情`} aria-expanded={expanded} aria-controls={id}
        title={expanded ? '收起错误详情' : '查看错误详情'}
        onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '失败'}</button>
    </div>
    <div id={id} className="manage-row-error" hidden={!expanded}>未确认：{error}</div>
  </>;
}

function SessionToggleRow({ identity, name, description, source = '', status, enabled, disabled, disabledReason, nativeError, onChange }: {
  identity: string; name: string; description?: string; source?: string; status?: ReactNode; enabled: boolean;
  disabled: boolean; disabledReason?: string; nativeError?: string; onChange: (name: string, enabled: boolean) => Promise<void>;
}) {
  const action = useKeyedAction(identity);
  const [desired, setDesired] = useState(enabled);
  const error = action.error ?? nativeError;
  const progress = <><Icon name="loading" className="spinner" size={10} />
    {status ? desired ? '连接中' : '断开中' : desired ? '启用中' : '停用中'}</>;
  const identityText = <>
    <div className="manage-row-name"><RowText key={name} text={name} label={`${name}名称`} /></div>
    <div className="manage-row-source"><RowText key={source} text={source} label={`${name}来源`} /></div>
  </>;
  return <div className="manage-row manage-session-row" data-mcp={status ? true : undefined}
    data-resource-name={name} title={disabled ? disabledReason : undefined}>
    {status ? <div className="manage-mcp-identity">{identityText}</div> : identityText}
    <Toggle label={`启用 ${name}`} disabled={disabled || action.busy} busy={action.busy} on={enabled}
      onChange={next => {
        if (disabled || action.busy) return;
        setDesired(next);
        void action.run(() => onChange(name, next));
      }} />
    {error && !action.busy
      ? <RowError key={JSON.stringify([identity, error])} error={error} name={name} />
      : <div className="manage-row-status" role="status">
        {action.busy ? <span className="mcp-status mcp-operation-status" data-tone="pending">{progress}</span>
          : status ?? <span className="mcp-status" data-tone="off">{enabled ? '已启用' : '已关闭'}</span>}
      </div>}
    <div className="manage-row-main">
      {!status && <div className="manage-row-description"><RowText key={description ?? ''} text={description ?? ''}
        lines={2} label={`${name}说明`} /></div>}
    </div>
  </div>;
}

// Only in-flight UI ownership is retained here. Values always come from the
// resource readback; leaving the page must not let a late mutation start a read.
function useToggleRequests(
  sessionId: string, mutate: (sessionId: string, name: string, enabled: boolean) => Promise<void>,
  refresh: () => Promise<boolean>, exclusive: boolean,
) {
  const [pending, setPending] = useState<{ sessionId: string; generation: number; count: number } | null>(null);
  const owner = useRef<{ names: Set<string>; active: boolean }>({ names: new Set(), active: false });
  const generation = useCockpit(s => s.connectionGeneration);
  useLayoutEffect(() => {
    const current = { names: new Set<string>(), active: true };
    owner.current = current;
    return () => { current.active = false; };
  }, [sessionId, generation]);
  const run = useCallback(async (name: string, enabled: boolean) => {
    const current = owner.current;
    const state = useCockpit.getState();
    const session = state.sessions.find(s => s.sessionId === sessionId);
    if (!current.active || state.connState !== 'open' || !session?.loaded || session.closing) {
      throw new Error('会话当前不可操作，请先核对连接与加载状态');
    }
    if (current.names.has(name) || (exclusive && (current.names.size || (session.activeMcpOperations ?? 0) > 0))) {
      throw new Error('已有切换操作正在处理，请等待完成');
    }
    current.names.add(name);
    setPending({ sessionId, generation, count: current.names.size });
    let refreshed = false;
    try {
      try { await mutate(sessionId, name, enabled); }
      finally {
        if (current.active && owner.current === current) refreshed = await refresh();
      }
      if (current.active && !refreshed) throw new Error('操作已返回，但未能读取最新状态；请刷新核对，不要直接重试');
    } finally {
      current.names.delete(name);
      if (current.active && owner.current === current) setPending({ sessionId, generation, count: current.names.size });
    }
  }, [sessionId, generation, mutate, refresh, exclusive]);
  return { run, pending: pending?.sessionId === sessionId && pending.generation === generation && pending.count > 0 };
}

function ManageShell({ title, onClose, refresh, status, failed, pending, hasData, working, blocked, empty, children }: {
  title: string; onClose: () => void; refresh: () => void; status: string | null;
  failed: boolean; pending: boolean; hasData: boolean; working: boolean; blocked: boolean;
  empty?: ReactNode; children: ReactNode;
}) {
  return <>
    <PaneHeader leading={<PanelCloseButton onClose={onClose} />}
      title={<span className="manage-title info-panel-title" title={title}>{title}</span>}
      actions={<RefreshButton pending={hasData && pending && !working}
        disabled={blocked || pending || working} onClick={refresh} />} />
    <div className="manage-body scrollable">
      <ResourceStatus status={hasData && pending ? null : status} failed={failed}
        pending={pending} placement={hasData ? 'inline' : 'pane'} />
      {children}
      {empty && <div className="manage-empty">{empty}</div>}
    </div>
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
      source={server.detail} nativeError={server.error} status={<McpStatusPill status={server.status} />}
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
      description={skill.description} source={skill.source}
      enabled={skill.enabled} disabled={!resource.usable} onChange={action.run} />)}
  </ManageShell>;
}
