// MCP + Skills management pages (per-session surfaces). The global MCP/Skills/
// Trash pages live in components/ManageWorkspace.tsx (their own master-detail
// shell). These per-session pages (kebab → MCP/Skills) render this session's live
// MCP status / skills with a per-session enable toggle, in the info-panel slot.
// The connection/status of MCP is per-session (each session owns its McpHost);
// the server/skill *definitions* are global. See docs/cockpit-plan.md.

import { useCallback } from 'react';
import type { ChatSession } from '../net/types';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useSessionResource } from '../lib/useSessionResource';
import { Icon } from './Icon';
import { McpStatusPill } from './McpStatus';
import { PanelCloseButton, ResourceStatus, SessionResume } from './SessionPanelKit';

// ── Switch ─────────────────────────────────────────────────────────────────────
export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button" role="switch" aria-label={label} aria-checked={on} disabled={disabled}
      className={`switch${on ? ' is-on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="switch-knob" />
    </button>
  );
}

// ── Status badge: now shared via McpStatusPill (components/McpStatus.tsx) ────────

// ── Shared row ─────────────────────────────────────────────────────────────────
function ManageRow({ name, sub, badge, toggle }: {
  name: string; sub?: string; badge?: React.ReactNode; toggle: React.ReactNode;
}) {
  return (
    <div className="manage-row manage-session-row">
      <div className="manage-row-main">
        <div className="manage-row-name">{name}{badge}</div>
        {sub && <div className="manage-row-sub">{sub}</div>}
      </div>
      {toggle}
    </div>
  );
}

// ── Shell (header + scrollable body) ───────────────────────────────────────────
function ManageShell({ title, onClose, action, status, failed, empty, children, error }: {
  title: string; onClose: () => void; action?: React.ReactNode;
  status: string | null; failed?: boolean; empty?: string; children?: React.ReactNode;
  error?: string | null;
}) {
  return (
    <>
      <header className="manage-header">
        <PanelCloseButton onClose={onClose} />
        <span className="manage-title info-panel-title" title={title}>{title}</span>
        {action}
      </header>
      <div className="manage-body scrollable">
        <ResourceStatus status={status} failed={failed} />
        {error && <div className="manage-empty" role="alert">操作失败：{error}</div>}
        {children}
        {empty && <div className="manage-empty">{empty}</div>}
      </div>
    </>
  );
}

function RefreshBtn({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button className="btn-icon rp manage-action" type="button" aria-label="刷新" onClick={onClick} disabled={disabled}>
      <Icon name="reload" size={20} />
    </button>
  );
}

// ── Per-session MCP ────────────────────────────────────────────────────────────
type SessionManageProps = { session: ChatSession; onClose: () => void };

export function SessionMcp({ session, onClose }: SessionManageProps) {
  const sessionId = session.sessionId;
  const mcpSession = useCockpit((s) => s.mcpSession);
  const mcpToggleSession = useCockpit((s) => s.mcpToggleSession);
  const load = useCallback(() => mcpSession(sessionId), [mcpSession, sessionId]);
  const resource = useSessionResource(sessionId, `mcp:${sessionId}`, load, 0, ['mcp']);
  const action = useKeyedAction(`mcp:${sessionId}`);
  const disabled = !resource.valid || action.busy;
  const toggle = (name: string, on: boolean) => {
    void action.run(async () => {
      await mcpToggleSession(sessionId, name, on);
    });
  };

  return (
    <ManageShell title={`本会话 MCP · ${session.title}`} onClose={onClose}
      action={<RefreshBtn disabled={resource.requiresResume || !resource.connected || resource.pending || action.busy} onClick={() => { void resource.refresh(); }} />}
      status={resource.status} failed={resource.failed} error={action.error}
      empty={resource.valid && resource.data?.length === 0 ? '本会话没有可用的 MCP 服务器' : undefined}>
      <SessionResume sessionId={sessionId} required={resource.requiresResume} />
      {resource.valid && !action.error && !!resource.data?.length &&
        <p className="manage-scope">开关仅本会话有效；冷加载采用原生全局默认，不恢复临时开关。</p>}
      {resource.data?.map((s) => (
        <ManageRow key={s.name} name={s.name} sub={s.error || s.detail}
          badge={<McpStatusPill status={s.status} />}
          toggle={<Toggle label={`启用 ${s.name}`} disabled={disabled} on={s.enabled} onChange={(v) => toggle(s.name, v)} />} />
      ))}
    </ManageShell>
  );
}

// ── Per-session Skills ─────────────────────────────────────────────────────────
export function SessionSkills({ session, onClose }: SessionManageProps) {
  const sessionId = session.sessionId;
  const skillsSession = useCockpit((s) => s.skillsSession);
  const skillsToggleSession = useCockpit((s) => s.skillsToggleSession);
  const load = useCallback(() => skillsSession(sessionId), [skillsSession, sessionId]);
  const resource = useSessionResource(sessionId, `skills:${sessionId}`, load, 0, ['skills']);
  const action = useKeyedAction(`skills:${sessionId}`);
  const toggle = (name: string, enabled: boolean) => {
    void action.run(async () => {
      await skillsToggleSession(sessionId, name, enabled);
    });
  };

  return (
    <ManageShell title={`本会话 Skills · ${session.title}`} onClose={onClose}
      action={<RefreshBtn disabled={resource.requiresResume || !resource.connected || resource.pending || action.busy} onClick={() => { void resource.refresh(); }} />}
      status={resource.status} failed={resource.failed} error={action.error}
      empty={resource.valid && resource.data?.length === 0 ? '没有可用的 skill' : undefined}>
      <SessionResume sessionId={sessionId} required={resource.requiresResume} />
      {resource.valid && !action.error && !!resource.data?.length &&
        <p className="manage-scope">开关仅本会话临时有效；冷加载采用原生配置发现和全局禁用列表，不恢复临时开关。</p>}
      {resource.data?.map((s) => (
        <ManageRow key={s.name} name={s.name} sub={s.description}
          badge={s.source ? <span className="manage-tag">{s.source}</span> : undefined}
          toggle={<Toggle label={`启用 ${s.name}`} disabled={!resource.valid || action.busy}
            on={s.enabled} onChange={(v) => toggle(s.name, v)} />} />
      ))}
    </ManageShell>
  );
}
