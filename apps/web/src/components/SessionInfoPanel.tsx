// Session info panel — Telegram right-column (#column-right) pattern, ported.
// Opened by tapping the chat topbar (general) or the TODO bar (→ todos); slides
// in from the inline-end. Full-screen on handhelds, fixed-width card on desktop.
// Holds only the high-frequency glance: identity (title/cwd/id/pin), the model
// picker (+ per-model reasoning effort & context tier), the TODO checklist, and an
// MCP status summary. The low-frequency heavy detail lives in the kebab sub-pages
// (Automation = schedules/hooks/flows; Context = plan.md/changed files/instruction
// sources/sub-agents) — see components/SessionPages.tsx.

import { useEffect, useState } from 'react';
import { useCockpit } from '../net/store';
import { Icon } from './Icon';
import { McpStatusPill } from './McpStatus';
import { Toggle } from './Manage';
import { CollapsibleSection } from './SessionPanelKit';
import { mcpStatusOf } from '../net/mcp-status';
import type { ChatSession, ModelOption, SessionPlan, TodoItem } from '../net/types';
import type { McpServerSession } from '@cockpit/protocol';

type ContextTier = 'default' | 'long_context';

const STATUS_ORDER: TodoItem['status'][] = ['in_progress', 'pending', 'blocked', 'done'];
const STATUS_LABEL: Record<TodoItem['status'], string> = {
  in_progress: '进行中', pending: '待办', blocked: '受阻', done: '已完成',
};
const EFFORT_LABEL: Record<string, string> = {
  none: '不思考', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
};

function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'done') return <span className="todo-item-ico" data-status="done"><Icon name="check" size={16} /></span>;
  if (status === 'blocked') return <span className="todo-item-ico" data-status="blocked"><Icon name="close" size={14} /></span>;
  if (status === 'in_progress') return <span className="todo-item-ico" data-status="in_progress"><Icon name="radiooff" size={12} /></span>;
  return <span className="todo-item-ico" data-status="pending"><Icon name="radiooff" size={12} /></span>;
}

// Model controls: picker + (conditional on the selected model's capabilities)
// reasoning effort and context tier. Effort shows only for models that list
// supportedReasoningEfforts; context tier only for models with a long_context
// price tier (supportsLongContext).
function ModelControls({ session, models, onSetModel }: {
  session: ChatSession;
  models: ModelOption[];
  onSetModel: (modelId: string, opts?: { reasoningEffort?: string; contextTier?: ContextTier }) => void;
}) {
  const list = (session.availableModels && session.availableModels.length > 0)
    ? session.availableModels : models;
  if (!list || list.length === 0) return null;

  const current = session.currentModelId ?? '';
  const currentModel = list.find((m) => m.modelId === current);
  const efforts = currentModel?.supportedReasoningEfforts ?? [];
  const supportsLong = !!currentModel?.supportsLongContext;
  const curEffort = session.currentReasoningEffort ?? currentModel?.defaultReasoningEffort ?? '';
  const curTier: ContextTier = session.currentContextTier ?? 'default';

  return (
    <section className="info-section">
      <div className="info-section-name">模型</div>
      <div className="info-section-content info-controls">
        <label className="info-control">
          <span className="info-control-label">模型</span>
          <select className="info-select" value={current} onChange={(e) => onSetModel(e.target.value)} aria-label="选择模型">
            {current === '' && <option value="" disabled>选择模型…</option>}
            {list.map((m) => <option key={m.modelId} value={m.modelId}>{m.name}</option>)}
          </select>
        </label>

        {efforts.length > 0 && (
          <label className="info-control">
            <span className="info-control-label">思考力度</span>
            <select className="info-select" value={curEffort}
              onChange={(e) => onSetModel(current, { reasoningEffort: e.target.value, contextTier: curTier })} aria-label="思考力度">
              {curEffort === '' && <option value="" disabled>力度…</option>}
              {efforts.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e] ?? e}</option>)}
            </select>
          </label>
        )}

        {supportsLong && (
          <label className="info-control">
            <span className="info-control-label">上下文长度</span>
            <select className="info-select" value={curTier}
              onChange={(e) => onSetModel(current, { reasoningEffort: curEffort || undefined, contextTier: e.target.value as ContextTier })} aria-label="上下文长度">
              <option value="default">标准上下文</option>
              <option value="long_context">长上下文</option>
            </select>
          </label>
        )}
      </div>
    </section>
  );
}

// MCP servers — a read-mostly status section. Connection state is per-session, so
// this surfaces each server's live status (已连接/连接中/失败/待授权/未就绪/已关闭/未加载)
// with a reason line (server error, else a static hint) when it isn't connected.
// Authoritative data comes from the same `mcp/session` source as the management
// page; toggling still lives on the kebab → MCP page.
function McpSection({ servers }: { servers: McpServerSession[] }) {
  return (
    <CollapsibleSection title="MCP 服务器" count={servers.length} bodyClassName="info-panel-list">
      {servers.map((s) => {
        const reason = s.error || mcpStatusOf(s.status).hint;
        return (
          <div key={s.name} className="info-mcp-row" data-enabled={s.enabled ? 'true' : 'false'}>
            <div className="info-mcp-head">
              <span className="info-panel-row-label">{s.name}</span>
              <McpStatusPill status={s.status} />
            </div>
            {reason && <span className="info-mcp-reason">{reason}</span>}
          </div>
        );
      })}
    </CollapsibleSection>
  );
}

export function SessionInfoPanel({ session, models, open, onClose, onSetModel }: {
  session: ChatSession;
  models: ModelOption[];
  open: boolean;
  onClose: () => void;
  onSetModel: (modelId: string, opts?: { reasoningEffort?: string; contextTier?: ContextTier }) => void;
}) {
  const getPlan = useCockpit((s) => s.getPlan);
  const mcpSession = useCockpit((s) => s.mcpSession);
  const pinSession = useCockpit((s) => s.pinSession);
  const [data, setData] = useState<SessionPlan | null>(null);
  const [mcp, setMcp] = useState<McpServerSession[] | null>(null);
  const [loading, setLoading] = useState(false);
  const sid = session.sessionId;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    // Reset the panel's load state when it opens or the session changes (intentional
    // prop sync — the data below is fetched fresh for the new session).
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setData(null);
    setMcp(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // getPlan intentionally materializes an unloaded session. Read MCP state only
    // after that settles so a parallel fast `unloaded` result cannot overwrite the
    // live status from the newly-loaded session.
    getPlan(sid)
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); })
      .finally(() => {
        if (!alive) return;
        mcpSession(sid).then((rows) => { if (alive) setMcp(rows); }).catch(() => { /* optional */ });
      });
    return () => { alive = false; };
  }, [open, sid, getPlan, mcpSession]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const todos = data?.todos ?? [];
  const grouped = STATUS_ORDER
    .map((st) => ({ st, items: todos.filter((t) => t.status === st) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <div className="info-panel-scrim" data-open={open ? 'true' : 'false'} onClick={onClose} aria-hidden="true" />
      <aside className="info-panel" data-open={open ? 'true' : 'false'} aria-label="会话信息" aria-hidden={!open}>
        <header className="info-panel-header">
          <button className="btn-icon rp" type="button" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={24} />
          </button>
          <span className="info-panel-title">会话信息</span>
        </header>

        <div className="info-panel-body scrollable">
          <section className="info-section">
            <div className="info-section-name">{session.title}</div>
            <div className="info-section-content info-meta-cwd">{session.cwd}</div>
            <div className="info-section-content info-meta-id"><span className="info-meta-id-label">ID</span>{session.sessionId}</div>
          </section>

          <section className="info-section">
            <div className="info-section-content info-option-row">
              <div className="info-option-text">
                <span className="info-option-label">置顶</span>
                <span className="info-option-hint">置顶到列表顶部，跨设备同步（仅标记；常驻内存由是否有定时任务自动决定）</span>
              </div>
              <Toggle on={!!session.pinned} onChange={(v) => pinSession(session.sessionId, v)} />
            </div>
          </section>

          <ModelControls session={session} models={models} onSetModel={onSetModel} />

          <section className="info-section">
            <div className="info-section-name">
              任务清单
              {data && <span className="info-section-name-right">{todos.filter((t) => t.status === 'done').length}/{todos.length}</span>}
            </div>
            <div className="info-section-content">
              {loading && <div className="info-loading"><span className="spinner" /> 加载中…</div>}
              {!loading && todos.length === 0 && <div className="info-empty">本会话还没有任务</div>}
              {grouped.map((g) => (
                <div key={g.st} className="todo-group">
                  <div className="todo-group-label">{STATUS_LABEL[g.st]}（{g.items.length}）</div>
                  {g.items.map((t) => (
                    <div key={t.id} className="todo-item" data-status={t.status}>
                      <TodoStatusIcon status={t.status} />
                      <div className="todo-item-body">
                        <div className="todo-item-title">{t.title}</div>
                        {t.description && <div className="todo-item-desc">{t.description}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>

          {mcp && mcp.length > 0 && <McpSection servers={mcp} />}
        </div>
      </aside>
    </>
  );
}
