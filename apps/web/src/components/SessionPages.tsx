// Per-session detail sub-pages opened from the kebab into the info-panel slot,
// using the same URL mechanism as the MCP/Skills pages (/session/:id/:panel). They
// hold the low-frequency, heavy detail moved out of the info panel so the panel
// stays a high-frequency glance (identity / model / todos / MCP status).
//
//   • Automation (/session/:id/automation) — schedules + hooks + flows (the butler
//     trigger layer: what fires this session, and what it can trigger).
//   • Context   (/session/:id/context)    — plan.md + changed files + instruction
//     sources + sub-agents (the session's working material and offspring).
//
// Each page self-fetches its data (mirroring SessionMcp/SessionSkills), so it loads
// only what it shows and resets cleanly on session switch.

import { useEffect, useState } from 'react';
import { useCockpit } from '../net/store';
import { Icon } from './Icon';
import { MessageBody } from './MessageBody';
import { CollapsibleSection, PanelPageShell } from './SessionPanelKit';
import type { ChatSession, SessionPlan, SessionPanels, PanelItem } from '../net/types';
import type { ScheduleEntry, HookEntry, Flow } from '@cockpit/protocol';

// ── Schedules ────────────────────────────────────────────────────────────────
// Format a schedule's cadence (interval | cron | one-shot) into a human label.
function cadenceOf(s: ScheduleEntry): string {
  if (s.intervalMs != null) {
    const ms = s.intervalMs;
    const d = Math.round(ms / 86400000), h = Math.round(ms / 3600000);
    const m = Math.round(ms / 60000), sec = Math.round(ms / 1000);
    const every = d >= 1 && ms % 86400000 === 0 ? `${d} 天`
      : h >= 1 && ms % 3600000 === 0 ? `${h} 小时`
      : m >= 1 && ms % 60000 === 0 ? `${m} 分钟`
      : `${sec} 秒`;
    return `每 ${every}`;
  }
  if (s.cron) return `cron ${s.cron}${s.tz ? `（${s.tz}）` : ''}`;
  if (s.at != null) return '一次性';
  return s.recurring ? '循环' : '一次性';
}

// Relative "next fire" label (e.g. 3 分钟后 / 即将触发). The `Date.now()` read lives
// inside this helper (not the component body) — a coarse hint recomputed each
// render; no client timer.
function nextFireOf(s: ScheduleEntry): string {
  const delta = s.nextRunAt - Date.now();
  if (delta <= 0) return '即将触发';
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `${sec} 秒后`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟后`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时后`;
  return `${Math.round(hr / 24)} 天后`;
}

// Is the schedule's next fire still in the future? Helper keeps the Date.now() read
// out of the component body (purity rule), matching Sidebar's relTime pattern.
function isUpcoming(s: ScheduleEntry): boolean {
  return s.recurring || s.nextRunAt > Date.now();
}

function ScheduleSection({ entries }: { entries: ScheduleEntry[] }) {
  return (
    <CollapsibleSection title="定时任务" count={entries.length} bodyClassName="info-panel-list">
      {entries.map((s) => (
        <div key={s.id} className="info-sched-row">
          <div className="info-sched-head">
            <span className="info-sched-cadence"><Icon name="schedule" size={14} /> {cadenceOf(s)}</span>
            <span className="info-sched-next">{isUpcoming(s) ? nextFireOf(s) : '已完成'}</span>
          </div>
          <span className="info-sched-prompt">{s.displayPrompt || s.prompt}</span>
        </div>
      ))}
    </CollapsibleSection>
  );
}

// ── Hooks ────────────────────────────────────────────────────────────────────
// A short, human label for the v1 event type.
const EVENT_LABEL: Record<string, string> = {
  'session.first-turn-complete': '首轮完成',
};

// Event hooks owned BY this session (the session is the butler — the receiver of
// these triggers). Each row: the event it reacts to, an optional filter, and its
// action (run a flow, or deliver a prompt). A hook is "fleet → this session": when
// the event fires anywhere (on a real, non-worker session), this session is driven.
function HookSection({ entries }: { entries: HookEntry[] }) {
  return (
    <CollapsibleSection title="事件钩子" count={entries.length} bodyClassName="info-panel-list">
      {entries.map((h) => {
        const filt = [
          h.filter?.cwdPrefix ? `目录 ${h.filter.cwdPrefix}` : '',
          h.filter?.sessionId ? `来源 ${h.filter.sessionId.slice(0, 8)}` : '',
        ].filter(Boolean).join(' · ');
        return (
          <div key={h.id} className="info-hook-row">
            <div className="info-hook-head">
              <span className="info-hook-event">{EVENT_LABEL[h.event] ?? h.event}</span>
              <span className="info-hook-action">{h.flowId ? `流程 ${h.flowId}` : '投递 prompt'}</span>
            </div>
            <span className="info-hook-sub">{filt || (h.flowId ? '触发即运行该流程' : (h.promptTemplate ?? ''))}</span>
          </div>
        );
      })}
    </CollapsibleSection>
  );
}

// ── Flows ────────────────────────────────────────────────────────────────────
// Flows defined on the box (~/.copilot/flows/*.json) — the reusable TRIGGER → FLOW
// → ACTION middle layer. Read-mostly and engine-global (not per-session), shown so
// the butler's available flows are visible. Each row: the flow id/name, whether it
// has a cost gate, and its action shape.
function FlowSection({ flows }: { flows: Flow[] }) {
  return (
    <CollapsibleSection title="流程" count={flows.length} bodyClassName="info-panel-list">
      {flows.map((f) => (
        <div key={f.id} className="info-hook-row">
          <div className="info-hook-head">
            <span className="info-hook-event">{f.name || f.id}</span>
            <span className="info-hook-action">{f.action.kind === 'spawn-session' ? '生成 worker' : '投递 prompt'}</span>
          </div>
          <span className="info-hook-sub">
            {f.gate ? '有 gate（成本闸门）· ' : '无 gate · '}
            {f.action.kind === 'spawn-session' ? `目录 ${f.action.template.cwd}` : `目标 ${f.action.sessionId.slice(0, 8)}`}
          </span>
        </div>
      ))}
    </CollapsibleSection>
  );
}

// A collapsible read-mostly panel section (sub-agents / instruction sources).
function PanelSection({ name, items }: { name: string; items: PanelItem[] }) {
  return (
    <CollapsibleSection title={name} count={items.length} bodyClassName="info-panel-list">
      {items.map((it, i) => (
        <div key={`${it.label}-${i}`} className="info-panel-row" data-enabled={it.enabled === false ? 'false' : 'true'}>
          <span className="info-panel-row-label">{it.label}</span>
          {it.sublabel && <span className="info-panel-row-sub">{it.sublabel}</span>}
          {it.enabled === false && <span className="info-panel-row-off">已停用</span>}
        </div>
      ))}
    </CollapsibleSection>
  );
}

// ── Automation page ──────────────────────────────────────────────────────────
export function SessionAutomation({ session, onClose }: { session: ChatSession; onClose: () => void }) {
  const scheduleList = useCockpit((s) => s.scheduleList);
  const hookList = useCockpit((s) => s.hookList);
  const flowList = useCockpit((s) => s.flowList);
  const [schedules, setSchedules] = useState<ScheduleEntry[] | null>(null);
  const [hooks, setHooks] = useState<HookEntry[] | null>(null);
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const sid = session.sessionId;

  useEffect(() => {
    let alive = true;
    scheduleList(sid).then((r) => { if (alive) setSchedules(r); }).catch(() => { if (alive) setSchedules([]); });
    hookList(sid).then((r) => { if (alive) setHooks(r); }).catch(() => { if (alive) setHooks([]); });
    flowList().then((r) => { if (alive) setFlows(r); }).catch(() => { if (alive) setFlows([]); });
    return () => { alive = false; };
  }, [sid, scheduleList, hookList, flowList]);

  const loading = schedules === null || hooks === null || flows === null;
  const isEmpty = !loading && !schedules!.length && !hooks!.length && !flows!.length;

  return (
    <PanelPageShell title="自动化" onClose={onClose} loading={loading} empty={isEmpty ? '本会话还没有自动化' : undefined}>
      {schedules && schedules.length > 0 && <ScheduleSection entries={schedules} />}
      {hooks && hooks.length > 0 && <HookSection entries={hooks} />}
      {flows && flows.length > 0 && <FlowSection flows={flows} />}
    </PanelPageShell>
  );
}

// ── Context page ─────────────────────────────────────────────────────────────
export function SessionContext({ session, onClose }: { session: ChatSession; onClose: () => void }) {
  const getPlan = useCockpit((s) => s.getPlan);
  const getPanels = useCockpit((s) => s.getPanels);
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [panels, setPanels] = useState<SessionPanels | null>(null);
  const [loading, setLoading] = useState(true);
  const sid = session.sessionId;

  useEffect(() => {
    let alive = true;
    // Reset load state on open/session change (intentional prop sync — data below
    // is fetched fresh for the new session), mirroring SessionInfoPanel.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setLoading(true);
    getPlan(sid).then((d) => { if (alive) { setPlan(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    getPanels(sid).then((p) => { if (alive) setPanels(p); }).catch(() => { /* optional */ });
    return () => { alive = false; };
  }, [sid, getPlan, getPanels]);

  const changedFiles = plan?.changedFiles ?? [];
  const tasks = panels?.tasks ?? [];
  const instructionSources = panels?.instructionSources ?? [];
  // Show changed-file paths relative to the session cwd when possible.
  const relPath = (p: string) => {
    const base = session.cwd.endsWith('/') ? session.cwd : `${session.cwd}/`;
    return p.startsWith(base) ? p.slice(base.length) : p;
  };

  const isEmpty = !loading && !plan?.planMarkdown && !changedFiles.length
    && !tasks.length && !instructionSources.length;

  return (
    <PanelPageShell title="上下文" onClose={onClose} loading={loading} empty={isEmpty ? '本会话还没有上下文' : undefined}>
      {plan?.planMarkdown && (
        <CollapsibleSection title="计划（plan.md）" bodyClassName="info-plan">
          <MessageBody body={plan.planMarkdown} />
        </CollapsibleSection>
      )}
      {changedFiles.length > 0 && (
        <CollapsibleSection title="改动文件" count={changedFiles.length} bodyClassName="info-files">
          {changedFiles.map((f) => (
            <div key={f.path} className="info-file" data-op={f.operation} title={f.path}>
              <span className="info-file-op" aria-hidden="true">{f.operation === 'create' ? '+' : '~'}</span>
              <span className="info-file-path">{relPath(f.path)}</span>
            </div>
          ))}
        </CollapsibleSection>
      )}
      {instructionSources.length > 0 && <PanelSection name="指令文件" items={instructionSources} />}
      {tasks.length > 0 && <PanelSection name="子代理" items={tasks} />}
    </PanelPageShell>
  );
}
