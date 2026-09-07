// MCP + Skills management pages (per-session surfaces). The global MCP/Skills/
// Trash pages live in components/ManageWorkspace.tsx (their own master-detail
// shell). These per-session pages (kebab → MCP/Skills) render this session's live
// MCP status / skills with a per-session enable toggle, in the info-panel slot.
// The connection/status of MCP is per-session (each session owns its McpHost);
// the server/skill *definitions* are global. See docs/cockpit-plan.md.

import { useCallback, useEffect, useState } from 'react';
import { useCockpit } from '../net/store';
import { Icon } from './Icon';
import { McpStatusPill } from './McpStatus';

// ── Switch ─────────────────────────────────────────────────────────────────────
export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} disabled={disabled}
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
    <div className="manage-row">
      <div className="manage-row-main">
        <div className="manage-row-name">{name}{badge}</div>
        {sub && <div className="manage-row-sub">{sub}</div>}
      </div>
      {toggle}
    </div>
  );
}

// ── Shell (header + scrollable body) ───────────────────────────────────────────
function ManageShell({ title, onClose, action, loading, empty, children }: {
  title: string; onClose: () => void; action?: React.ReactNode;
  loading?: boolean; empty?: string; children?: React.ReactNode;
}) {
  return (
    <>
      <header className="manage-header">
        <button className="btn-icon rp" type="button" aria-label="关闭" onClick={onClose}>
          <Icon name="close" size={24} />
        </button>
        <span className="manage-title">{title}</span>
        {action}
      </header>
      <div className="manage-body scrollable">
        {loading ? <div className="manage-empty">加载中…</div>
          : !children || (Array.isArray(children) && children.length === 0)
            ? <div className="manage-empty">{empty}</div>
            : children}
      </div>
    </>
  );
}

function RefreshBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn-icon rp manage-action" type="button" aria-label="刷新" onClick={onClick}>
      <Icon name="reload" size={20} />
    </button>
  );
}

// ── Per-session MCP ────────────────────────────────────────────────────────────
export function SessionMcp({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const mcpSession = useCockpit((s) => s.mcpSession);
  const mcpToggleSession = useCockpit((s) => s.mcpToggleSession);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof mcpSession>> | null>(null);
  const load = useCallback(() => { mcpSession(sessionId).then(setRows).catch(() => setRows([])); }, [mcpSession, sessionId]);
  useEffect(() => { load(); }, [load]);

  const toggle = (name: string, on: boolean) => {
    setRows((r) => r?.map((x) => (x.name === name ? { ...x, enabled: on, status: on ? 'pending' : 'disabled' } : x)) ?? r);
    mcpToggleSession(sessionId, name, on).then(load).catch(load);
  };

  return (
    <ManageShell title="MCP 服务器" onClose={onClose} action={<RefreshBtn onClick={load} />}
      loading={rows === null} empty="没有配置 MCP 服务器">
      {rows?.map((s) => (
        <ManageRow key={s.name} name={s.name} sub={s.error || s.detail}
          badge={<McpStatusPill status={s.status} />}
          toggle={<Toggle on={s.enabled} onChange={(v) => toggle(s.name, v)} />} />
      ))}
    </ManageShell>
  );
}

// ── Per-session Skills ─────────────────────────────────────────────────────────
export function SessionSkills({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const skillsSession = useCockpit((s) => s.skillsSession);
  const skillsToggleSession = useCockpit((s) => s.skillsToggleSession);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof skillsSession>> | null>(null);
  const load = useCallback(() => { skillsSession(sessionId).then(setRows).catch(() => setRows([])); }, [skillsSession, sessionId]);
  useEffect(() => { load(); }, [load]);

  const toggle = (name: string, enabled: boolean) => {
    setRows((r) => r?.map((x) => (x.name === name ? { ...x, enabled } : x)) ?? r);
    skillsToggleSession(sessionId, name, enabled).then(load).catch(load);
  };

  return (
    <ManageShell title="Skills" onClose={onClose} action={<RefreshBtn onClick={load} />}
      loading={rows === null} empty="没有可用的 skill">
      {rows?.map((s) => (
        <ManageRow key={s.name} name={s.name} sub={s.description}
          badge={s.source ? <span className="manage-tag">{s.source}</span> : undefined}
          toggle={<Toggle on={s.enabled} onChange={(v) => toggle(s.name, v)} />} />
      ))}
    </ManageShell>
  );
}
