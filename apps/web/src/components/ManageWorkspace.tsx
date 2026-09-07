// Master-detail workspace for the global management sections (MCP / Skills /
// Trash). Mirrors the session Shell: the left pane lists the section's items, the
// right pane shows the selected item's detail. The URL is the source of truth —
//   /mcp · /mcp/:name      — MCP servers, then one server's (redacted) config
//   /skills · /skills/:name — skills, then one skill's meta + SKILL.md body
//   /trash · /trash/:id     — trashed sessions, then that session READ-ONLY
// Below the 925px dock line only one pane shows (list ↔ detail), like sessions.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useCockpit } from '../net/store';
import { useUp } from '../lib/nav';
import { Shell, MasterPane, DetailPane } from './Shell';
import { Icon } from './Icon';
import { MessageBody } from './MessageBody';
import { Thread } from './Thread';
import { Dialog, type DialogProps } from './Dialog';
import type { TrashEntry } from '../net/types';
import type { Flow, HookEntry, FlowScheduleEntry } from '@cockpit/protocol';

type Section = 'mcp' | 'skills' | 'trash' | 'flows' | 'workers';
const SECTION_TITLE: Record<Section, string> = { mcp: 'MCP 服务器', skills: 'Skills', trash: '垃圾桶', flows: '流程', workers: '自动会话' };

function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── A clickable list row (navigates to the item's detail) ───────────────────────
function NavRow({ name, sub, badge, active, onClick }: {
  name: string; sub?: string; badge?: React.ReactNode; active: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`manage-row is-clickable rp${active ? ' is-active' : ''}`} onClick={onClick}>
      <div className="manage-row-main">
        <div className="manage-row-name">{name}{badge}</div>
        {sub && <div className="manage-row-sub">{sub}</div>}
      </div>
    </button>
  );
}

function RefreshBtn({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn-icon rp manage-action" type="button" aria-label="刷新" onClick={onClick}>
      <Icon name="reload" size={20} />
    </button>
  );
}

function ListBody({ loading, empty, children }: { loading: boolean; empty: string; children?: React.ReactNode }) {
  if (loading) return <div className="manage-empty">加载中…</div>;
  if (!children || (Array.isArray(children) && children.length === 0)) return <div className="manage-empty">{empty}</div>;
  return <div className="manage-list">{children}</div>;
}

// ── MCP ─────────────────────────────────────────────────────────────────────────
function McpList({ selected, onSelect, nonce }: { selected: string | null; onSelect: (name: string) => void; nonce: number }) {
  const mcpGlobal = useCockpit((s) => s.mcpGlobal);
  const connState = useCockpit((s) => s.connState);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof mcpGlobal>> | null>(null);
  // Gate on an open connection: child effects fire before the store's client is
  // created, so a cold deep-link would otherwise fetch with no client and cache
  // an empty list. Re-runs when the connection opens or a refresh is requested.
  const load = useCallback(() => { if (connState !== 'open') return; mcpGlobal().then(setRows).catch(() => setRows([])); }, [mcpGlobal, connState]);
  useEffect(() => { load(); }, [load, nonce]);
  return (
    <ListBody loading={rows === null} empty="没有配置 MCP 服务器">
      {rows?.map((s) => (
        <NavRow key={s.name} name={s.name} sub={s.detail}
          badge={s.defaultOn ? <span className="manage-tag">默认</span> : undefined}
          active={selected === s.name} onClick={() => onSelect(s.name)} />
      ))}
    </ListBody>
  );
}

function McpDetail({ name }: { name: string }) {
  const mcpGlobal = useCockpit((s) => s.mcpGlobal);
  const connState = useCockpit((s) => s.connState);
  const [row, setRow] = useState<Awaited<ReturnType<typeof mcpGlobal>>[number] | null | undefined>(undefined);
  useEffect(() => {
    if (connState !== 'open') return;
    mcpGlobal().then((rows) => setRow(rows.find((r) => r.name === name) ?? null)).catch(() => setRow(null));
  }, [mcpGlobal, name, connState]);
  if (row === undefined) return <div className="manage-detail-status">加载中…</div>;
  if (row === null) return <div className="detail-empty"><p>未找到该 MCP 服务器。</p></div>;
  return (
    <div className="manage-detail scrollable">
      <h2 className="manage-detail-title">{row.name}</h2>
      <div className="manage-detail-meta">{row.defaultOn ? '新会话默认开启' : '新会话默认关闭'} · 启用由每个会话单独控制</div>
      <div className="manage-detail-line">{row.detail}</div>
      {row.config && <pre className="manage-config">{JSON.stringify(row.config, null, 2)}</pre>}
    </div>
  );
}

// ── Skills ───────────────────────────────────────────────────────────────────────
function SkillsList({ selected, onSelect, nonce }: { selected: string | null; onSelect: (name: string) => void; nonce: number }) {
  const skillsGlobal = useCockpit((s) => s.skillsGlobal);
  const connState = useCockpit((s) => s.connState);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof skillsGlobal>> | null>(null);
  const load = useCallback(() => { if (connState !== 'open') return; skillsGlobal().then(setRows).catch(() => setRows([])); }, [skillsGlobal, connState]);
  useEffect(() => { load(); }, [load, nonce]);
  return (
    <ListBody loading={rows === null} empty="没有可用的 skill">
      {rows?.map((s) => (
        <NavRow key={s.name} name={s.name} sub={s.description}
          badge={s.source ? <span className="manage-tag">{s.source}</span> : undefined}
          active={selected === s.name} onClick={() => onSelect(s.name)} />
      ))}
    </ListBody>
  );
}

function SkillDetail({ name }: { name: string }) {
  const skillsRead = useCockpit((s) => s.skillsRead);
  const connState = useCockpit((s) => s.connState);
  const [d, setD] = useState<Awaited<ReturnType<typeof skillsRead>> | null | undefined>(undefined);
  useEffect(() => { if (connState !== 'open') return; skillsRead(name).then(setD).catch(() => setD(null)); }, [skillsRead, name, connState]);
  if (d === undefined) return <div className="manage-detail-status">加载中…</div>;
  if (d === null) return <div className="detail-empty"><p>未找到该 skill。</p></div>;
  const meta = [d.source, d.userInvocable ? '可手动调用' : null].filter(Boolean).join(' · ');
  return (
    <div className="manage-detail scrollable">
      <h2 className="manage-detail-title">{d.name}</h2>
      {meta && <div className="manage-detail-meta">{meta}</div>}
      {d.description && <p className="manage-detail-line">{d.description}</p>}
      {d.body ? <div className="manage-detail-body"><MessageBody body={d.body} /></div>
        : <div className="manage-empty">没有 SKILL.md 内容</div>}
    </div>
  );
}

// ── Trash ────────────────────────────────────────────────────────────────────────
function TrashList({ selected, onSelect, nonce }: { selected: string | null; onSelect: (id: string) => void; nonce: number }) {
  const trashList = useCockpit((s) => s.trashList);
  const connState = useCockpit((s) => s.connState);
  const [rows, setRows] = useState<TrashEntry[] | null>(null);
  const load = useCallback(() => { if (connState !== 'open') return; trashList().then(setRows).catch(() => setRows([])); }, [trashList, connState]);
  useEffect(() => { load(); }, [load, nonce]);
  return (
    <>
      {rows && rows.length > 0 && (
        <div className="trash-note">已删除的会话保留在这里、可恢复且可只读查看。彻底删除由维护者在提取经验后执行。</div>
      )}
      <ListBody loading={rows === null} empty="垃圾桶是空的">
        {rows?.map((t) => (
          <NavRow key={t.sessionId} name={t.title}
            sub={`${whenLabel(t.at)}${t.reason ? ` · ${t.reason}` : ''}${t.cwd ? ` · ${t.cwd}` : ''}`}
            active={selected === t.sessionId} onClick={() => onSelect(t.sessionId)} />
        ))}
      </ListBody>
    </>
  );
}

// Read-only, paginated transcript of a session — used for a TRASHED session and
// for a flow-spawned WORKER alike. Both render as a non-interactive Thread fed by
// the synthetic `preview` session (client.peek reads the session store directly,
// so it works whether or not the session is live). No global activeId mutation.
function SessionPreview({ sessionId }: { sessionId: string }) {
  const preview = useCockpit((s) => s.preview);
  const openPreview = useCockpit((s) => s.openPreview);
  const loadMorePreview = useCockpit((s) => s.loadMorePreview);
  const closePreview = useCockpit((s) => s.closePreview);
  const connState = useCockpit((s) => s.connState);
  useEffect(() => { if (connState === 'open') openPreview(sessionId); return () => closePreview(); }, [sessionId, connState, openPreview, closePreview]);
  if (!preview || preview.sessionId !== sessionId) return <div className="manage-detail-status">加载中…</div>;
  if (preview.error) return <div className="detail-empty"><p>无法读取该会话:{preview.error}</p></div>;
  return <Thread key={preview.sessionId} session={preview} readOnly onLoadMore={loadMorePreview} />;
}

// ── Workers (Flow-spawned auto sessions) ──────────────────────────────────────
// Flow-spawned worker sessions (SessionMeta.spawnedBy, R1 mark) are kept (F7), so
// they live on their own page instead of flooding the main list. Selecting one
// opens its transcript IN this page's detail pane (read-only, like trash) — NOT by
// navigating to the main /session workspace, which would swap the left pane back to
// the main session list. A pinned worker stays in the main list, so it's excluded
// here. Data is the store's session projection (no fetch — pure projection).
function WorkersList({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const sessions = useCockpit((s) => s.sessions);
  const workers = sessions
    .filter((s) => s.spawnedBy && !s.pinned)
    .sort((a, b) => b.lastActivity - a.lastActivity);
  return (
    <>
      {workers.length > 0 && (
        <div className="trash-note">流程自动生成的一次性 worker 会话，移出主列表收纳在这里。点开可查看它做了什么；不需要的可在其中删除。</div>
      )}
      <ListBody loading={false} empty="还没有自动生成的会话">
        {workers.map((w) => (
          <NavRow key={w.sessionId} name={w.title}
            sub={`${w.spawnedBy ? `来自 ${w.spawnedBy}` : ''}${w.cwd ? ` · ${w.cwd.split('/').filter(Boolean).pop()}` : ''}`}
            badge={w.status === 'running' ? <span className="manage-tag">运行中</span> : undefined}
            active={selected === w.sessionId} onClick={() => onSelect(w.sessionId)} />
        ))}
      </ListBody>
    </>
  );
}

// ── Flows ────────────────────────────────────────────────────────────────────────
// A one-line summary of a flow's action: spawn a born-configured worker, or prompt
// an existing session.
function flowActionSummary(f: Flow): string {
  return f.action.kind === 'spawn-session'
    ? `生成 worker · ${f.action.template.cwd}`
    : `投递 prompt → ${f.action.sessionId.slice(0, 8)}`;
}

const EVENT_LABEL: Record<string, string> = { 'session.first-turn-complete': '首轮完成' };

// A human description of one event-hook trigger pointing at a flow.
function hookTriggerLabel(h: HookEntry): string {
  const filt = [
    h.filter?.cwdPrefix ? `目录 ${h.filter.cwdPrefix}` : '',
    h.filter?.sessionId ? `来源 ${h.filter.sessionId.slice(0, 8)}` : '',
  ].filter(Boolean).join(' · ');
  return `事件 · ${EVENT_LABEL[h.event] ?? h.event}${h.once ? ' · 仅一次' : ''}${filt ? ` · ${filt}` : ''}`;
}

// A human cadence for one server-level flow schedule.
function flowScheduleCadence(s: FlowScheduleEntry): string {
  if (s.intervalMs != null) {
    const ms = s.intervalMs;
    const d = Math.round(ms / 86400000), h = Math.round(ms / 3600000), m = Math.round(ms / 60000), sec = Math.round(ms / 1000);
    const every = d >= 1 && ms % 86400000 === 0 ? `${d} 天`
      : h >= 1 && ms % 3600000 === 0 ? `${h} 小时`
      : m >= 1 && ms % 60000 === 0 ? `${m} 分钟` : `${sec} 秒`;
    return `定时 · 每 ${every}`;
  }
  if (s.cron) return `定时 · cron ${s.cron}${s.tz ? `（${s.tz}）` : ''}`;
  if (s.at != null) return `定时 · 一次性 ${new Date(s.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  return s.recurring ? '定时 · 循环' : '定时 · 一次性';
}

function FlowsList({ selected, onSelect, nonce }: { selected: string | null; onSelect: (id: string) => void; nonce: number }) {
  const flowList = useCockpit((s) => s.flowList);
  const hookList = useCockpit((s) => s.hookList);
  const flowScheduleList = useCockpit((s) => s.flowScheduleList);
  const connState = useCockpit((s) => s.connState);
  const [rows, setRows] = useState<Flow[] | null>(null);
  // Count triggers per flow (event hooks + schedules pointing at it) so each row
  // shows at a glance how it gets fired.
  const [triggerCount, setTriggerCount] = useState<Record<string, number>>({});
  const load = useCallback(() => {
    if (connState !== 'open') return;
    flowList().then(setRows).catch(() => setRows([]));
    Promise.all([hookList(), flowScheduleList()]).then(([hooks, scheds]) => {
      const counts: Record<string, number> = {};
      for (const h of hooks) if (h.flowId) counts[h.flowId] = (counts[h.flowId] ?? 0) + 1;
      for (const s of scheds) counts[s.flowId] = (counts[s.flowId] ?? 0) + 1;
      setTriggerCount(counts);
    }).catch(() => setTriggerCount({}));
  }, [flowList, hookList, flowScheduleList, connState]);
  useEffect(() => { load(); }, [load, nonce]);
  return (
    <>
      {rows && rows.length > 0 && (
        <div className="trash-note">流程定义来自 ~/.copilot/flows/*.json，由事件钩子或定时任务触发：可选 gate 脚本（成本闸门）+ 动作（生成 worker 或投递 prompt）。</div>
      )}
      <ListBody loading={rows === null} empty="还没有流程（~/.copilot/flows/*.json）">
        {rows?.map((f) => {
          const n = triggerCount[f.id] ?? 0;
          return (
            <NavRow key={f.id} name={f.name || f.id} sub={flowActionSummary(f)}
              badge={
                <>
                  {f.gate ? <span className="manage-tag">gate</span> : null}
                  <span className="manage-tag">{n > 0 ? `${n} 触发器` : '未绑定'}</span>
                </>
              }
              active={selected === f.id} onClick={() => onSelect(f.id)} />
          );
        })}
      </ListBody>
    </>
  );
}

function FlowDetail({ id }: { id: string }) {
  const flowList = useCockpit((s) => s.flowList);
  const hookList = useCockpit((s) => s.hookList);
  const flowScheduleList = useCockpit((s) => s.flowScheduleList);
  const connState = useCockpit((s) => s.connState);
  const [flow, setFlow] = useState<Flow | null | undefined>(undefined);
  const [hooks, setHooks] = useState<HookEntry[]>([]);
  const [scheds, setScheds] = useState<FlowScheduleEntry[]>([]);
  useEffect(() => {
    if (connState !== 'open') return;
    flowList().then((rows) => setFlow(rows.find((r) => r.id === id) ?? null)).catch(() => setFlow(null));
    hookList().then((rows) => setHooks(rows.filter((h) => h.flowId === id))).catch(() => setHooks([]));
    flowScheduleList().then((rows) => setScheds(rows.filter((s) => s.flowId === id))).catch(() => setScheds([]));
  }, [flowList, hookList, flowScheduleList, id, connState]);
  if (flow === undefined) return <div className="manage-detail-status">加载中…</div>;
  if (flow === null) return <div className="detail-empty"><p>未找到该流程。</p></div>;
  const tpl = flow.action.kind === 'spawn-session' ? flow.action.template : null;
  const triggerCount = hooks.length + scheds.length;
  return (
    <div className="manage-detail scrollable">
      <h2 className="manage-detail-title">{flow.name || flow.id}</h2>
      <div className="manage-detail-meta">{flow.id} · {flow.action.kind === 'spawn-session' ? '生成 worker' : '投递 prompt'}{flow.gate ? ' · 有 gate（成本闸门）' : ' · 无 gate'}</div>

      <div className="manage-detail-subhead">触发器（{triggerCount}）</div>
      {triggerCount === 0 ? (
        <div className="manage-detail-line manage-detail-hint">暂无触发器。用 cockpit_hook_add（事件）或 cockpit_flow_schedule_add（定时）把它绑到这个流程。也可在「流程」页手动运行。</div>
      ) : (
        <div className="flow-trigger-list">
          {hooks.map((h) => (
            <div key={h.id} className="flow-trigger-row">
              <span className="flow-trigger-kind" data-kind="event">事件</span>
              <span className="flow-trigger-text">{hookTriggerLabel(h).replace(/^事件 · /, '')}</span>
            </div>
          ))}
          {scheds.map((s) => (
            <div key={s.id} className="flow-trigger-row">
              <span className="flow-trigger-kind" data-kind="time">定时</span>
              <span className="flow-trigger-text">{flowScheduleCadence(s).replace(/^定时 · /, '')}{s.label ? ` · ${s.label}` : ''}</span>
            </div>
          ))}
        </div>
      )}

      {flow.gate && (
        <>
          <div className="manage-detail-subhead">Gate（成本闸门）</div>
          <div className="manage-detail-line">脚本 <code>{flow.gate.script}</code>{flow.gate.timeoutMs ? ` · 超时 ${flow.gate.timeoutMs} ms` : ''}</div>
          <div className="manage-detail-line manage-detail-hint">退出码 0 = 放行；非 0 / 超时 = 跳过（不花 agent）。stdout JSON 注入下游 prompt。</div>
        </>
      )}

      <div className="manage-detail-subhead">动作</div>
      {tpl ? (
        <>
          <div className="manage-detail-line">目录 <code>{tpl.cwd}</code></div>
          {tpl.title && <div className="manage-detail-line">worker 标题：{tpl.title}</div>}
          {tpl.skills && <div className="manage-detail-line">Skills（仅保留）：{tpl.skills.length ? tpl.skills.join('、') : '全部停用'}</div>}
          {tpl.mcps && <div className="manage-detail-line">MCP：{tpl.mcps.length ? tpl.mcps.join('、') : '全部关闭'}</div>}
          {tpl.model && <div className="manage-detail-line">模型 {tpl.model}</div>}
          {tpl.mode && <div className="manage-detail-line">模式 {tpl.mode}</div>}
          <div className="manage-detail-subhead">Prompt</div>
          <div className="manage-detail-line manage-detail-prompt">{tpl.prompt}</div>
        </>
      ) : flow.action.kind === 'prompt-existing' ? (
        <>
          <div className="manage-detail-line">目标会话 <code>{flow.action.sessionId}</code></div>
          <div className="manage-detail-subhead">Prompt</div>
          <div className="manage-detail-line manage-detail-prompt">{flow.action.prompt}</div>
        </>
      ) : null}
    </div>
  );
}

// ── Workspace ─────────────────────────────────────────────────────────────────────
export function ManageWorkspace() {
  const navigate = useNavigate();
  const up = useUp();
  const { pathname } = useLocation();
  const { item = null } = useParams();
  const preview = useCockpit((s) => s.preview);
  const sessions = useCockpit((s) => s.sessions);
  const restoreSession = useCockpit((s) => s.restoreSession);
  const deleteSession = useCockpit((s) => s.deleteSession);
  const mcpRefresh = useCockpit((s) => s.mcpRefresh);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [dialog, setDialog] = useState<DialogProps | null>(null);
  const section = (pathname.split('/')[1] || 'mcp') as Section;
  const mobileView: 'list' | 'detail' = item ? 'detail' : 'list';
  const select = (name: string) => navigate(`/${section}/${encodeURIComponent(name)}`);
  // Refresh re-fetches the list. For MCP it also hot-applies the global config to
  // every loaded session before reloading. It lives in the master header (as it
  // did before the master-detail refactor), not inside the list body.
  const doRefresh = useCallback(() => {
    if (section === 'mcp') mcpRefresh().finally(() => setRefreshNonce((n) => n + 1));
    else setRefreshNonce((n) => n + 1);
  }, [section, mcpRefresh]);

  const masterHeader = (
    <header className="manage-header">
      <button className="btn-icon rp" type="button" aria-label="返回会话列表" onClick={() => up('/')}>
        <Icon name="back" size={24} />
      </button>
      <span className="manage-title">{SECTION_TITLE[section]}</span>
      <RefreshBtn onClick={doRefresh} />
    </header>
  );

  // For workers the :item is a sessionId — show the worker's real title (from the
  // store projection), not the raw id. Trash uses the peeked preview title.
  const workerTitle = section === 'workers' && item ? (sessions.find((s) => s.sessionId === item)?.title ?? item) : item;
  const detailTitle = item == null ? ''
    : section === 'trash' ? (preview?.title ?? item)
      : section === 'workers' ? workerTitle
        : item;
  const askDeleteWorker = (id: string) => {
    const name = sessions.find((s) => s.sessionId === id)?.title?.trim() || '该会话';
    setDialog({
      title: '移入垃圾桶',
      message: `将「${name}」移入垃圾桶。会话数据会保留，可随时从垃圾桶恢复。`,
      confirmLabel: '移入垃圾桶',
      destructive: true,
      onConfirm: () => { deleteSession(id); setDialog(null); navigate('/workers', { replace: true }); },
      onCancel: () => setDialog(null),
    });
  };
  const detailHeader = item != null ? (
    <header className="chat-topbar">
      <button className="chat-back btn-icon rp lg:hidden" type="button" aria-label="返回" onClick={() => up()}>
        <Icon name="back" size={24} />
      </button>
      <span className="manage-title manage-detail-headtitle">{detailTitle}</span>
      {section === 'trash' && (
        <button type="button" className="trash-restore rp" onClick={() => { restoreSession(item).then(() => navigate(`/session/${item}`, { replace: true })); }}>
          恢复
        </button>
      )}
      {section === 'workers' && (
        <button type="button" className="trash-restore rp" onClick={() => askDeleteWorker(item)}>
          删除
        </button>
      )}
    </header>
  ) : undefined;

  return (
    <Shell ariaLabel="管理">
      <MasterPane ariaLabel={SECTION_TITLE[section]} mobileVisible={mobileView === 'list'} header={masterHeader}>
        {section === 'mcp' ? <McpList selected={item} onSelect={select} nonce={refreshNonce} />
          : section === 'skills' ? <SkillsList selected={item} onSelect={select} nonce={refreshNonce} />
            : section === 'flows' ? <FlowsList selected={item} onSelect={select} nonce={refreshNonce} />
              : section === 'workers' ? <WorkersList selected={item} onSelect={select} />
                : <TrashList selected={item} onSelect={select} nonce={refreshNonce} />}
      </MasterPane>

      <DetailPane ariaLabel="详情" mobileVisible={mobileView === 'detail'} header={detailHeader}>
        {item == null ? (
          <div className="detail-empty"><p>{section === 'workers' ? '选择一个自动会话以打开它。' : '选择左侧的一项查看详情。'}</p></div>
        ) : section === 'mcp' ? <McpDetail key={item} name={item} />
          : section === 'skills' ? <SkillDetail key={item} name={item} />
            : section === 'flows' ? <FlowDetail key={item} id={item} />
              : <SessionPreview key={item} sessionId={item} />}
      </DetailPane>
      {dialog && <Dialog {...dialog} />}
    </Shell>
  );
}
