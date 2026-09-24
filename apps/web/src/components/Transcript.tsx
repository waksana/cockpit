// Transcript rendering: messages, process groups and sub-agent cards. Reading
// position belongs to the Thread scroll owner, never to these rows.

import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageBody } from './MessageBody';
import { MessageContent } from './MessageContent';
import { AnsweredAskCard, AnsweredElicitationCard, AnsweredPlanCard } from './PendingDecision';
import { elicitationRecordId, useElicitationRecords } from '../lib/decisionRecords';
import { hasMessageContent } from '../lib/messageContent';
import { Icon } from './Icon';
import type { ChatMessage } from '../net/types';
import { READING_ACTIVITY_EVENT } from './threadScroll';
import { canSkipMessageLayout, createMessageLayout } from './messageLayout';
import { useCockpit } from '../net/store';
import { ToolCallRow, ToolStatusIcon } from './ToolCallRow';
import { toolStatusLabel } from '../lib/toolStatus';
import { ActivityHeader } from './ActivityHeader';
import { Disclosure, DisclosureChevron } from './Disclosure';
import { useDisclosureChoice } from '../lib/disclosureChoice';
import { groupTranscript, transcriptGap, type TranscriptRow, type ProcessItem } from '../lib/transcriptRows';
import { RegionErrorBoundary } from './ErrorBoundary';

function Thought({ message, latest, sessionId }: { message: ChatMessage; latest: boolean; sessionId: string }) {
  const { open, toggle } = useDisclosureChoice(JSON.stringify([sessionId, 'thought', message.thoughtKey ?? message.id]), latest);
  return (
    <div className="msg-thought-block">
      <ActivityHeader className="thought-toggle" icon={<Icon name="thought" size={16} />}
        title="思考过程" disclosure={{ open, onToggle: toggle }} />
      {message.incomplete && <div className="thought-incomplete" role="status">{message.incomplete}</div>}
      {open && <div className="activity-detail msg-thought"><MessageBody body={message.thought ?? ''} /></div>}
    </div>
  );
}

function SkillActivity({ message }: { message: ChatMessage }) {
  return <ActivityHeader className="skill-activity" icon={<Icon name="skills" size={16} />} title={`skill · ${message.content}`} />;
}

export function MessageProcess({ items, sessionId, latest = false, identity = items[0].key,
  latestItemId = latest ? items.at(-1)?.key : undefined }: {
  items: ProcessItem[]; sessionId: string; latest?: boolean; identity?: string; latestItemId?: string;
}) {
  const { open, toggle } = useDisclosureChoice(JSON.stringify([sessionId, 'overview', identity]), latest);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const contentId = useId();
  const tools = items.flatMap(item => item.kind === 'tool' ? [item.tool] : []);
  const thoughts = items.filter(item => item.kind === 'thought');
  const skills = items.filter(item => item.kind === 'skill');
  const latestThoughtId = latest && items.at(-1)?.key === latestItemId && items.at(-1)?.kind === 'thought'
    ? latestItemId : undefined;
  const categories = [
    { icon: 'tool', count: tools.length, label: `${tools.length} 次工具调用` },
    { icon: 'thought', count: thoughts.length, label: `${thoughts.length} 次思考` },
    { icon: 'skills', count: skills.length, label: `${skills.length} 次 Skill 使用` },
  ] as const;
  const visibleCategories = categories.filter(category => category.count > 0);
  const states = [
    [tools.filter(tool => tool.status === 'failed').length, 'failed'],
    [tools.filter(tool => tool.status === 'in_progress').length, 'in_progress'],
    [tools.filter(tool => tool.status === 'pending').length, 'pending'],
    [tools.filter(tool => !tool.status).length, undefined],
  ] as const;
  const notices = states.filter(([count]) => count > 0).map(([count, status]) => `${count} 项${toolStatusLabel(status)}`);
  if (thoughts.some(item => item.message.incomplete)) notices.push('思考归属未确认');
  const description = [...visibleCategories.map(category => category.label), ...notices].join(' · ');
  const timestamp = items[0].message.timestamp;
  const time = clock(timestamp);
  return <section className="message-process" data-failed={states[0][0] > 0 || undefined}>
    <div data-message-id={JSON.stringify([sessionId, identity])}><Disclosure className="process-summary" open={open} controls={contentId}
      name={`过程：${description} · ${time}`} title={description} onToggle={toggle}
      leading={<span className="process-summary-chevron"><DisclosureChevron open={open} /></span>}>
      <span className="process-summary-counts">
        {visibleCategories.map(({ icon, count, label }) => <span key={icon} className="process-summary-count" title={label}>
          <Icon name={icon} size={16} />{count}
        </span>)}
      </span>
      <span className="process-summary-states">
        {states.filter(([count]) => count > 0).map(([count, status]) => <span key={status ?? 'unknown'}
          className="process-summary-status" title={`${count} 项${toolStatusLabel(status)}`} data-status={status ?? 'unknown'}>
          <ToolStatusIcon status={status} />{count}
        </span>)}
        {thoughts.some(item => item.message.incomplete) && <span title="思考归属未确认"><Icon name="error" size={16} /></span>}
      </span>
      <MessageTimestamp timestamp={timestamp} />
    </Disclosure></div>
    <div id={contentId} className="message-process-content" hidden={!open} data-child-history>
      {(mounted || open) && items.map(item => <div key={item.key} data-child-message-frame={item.key}>
        <div data-message-id={JSON.stringify([sessionId, item.key])}>
          {item.kind === 'thought' && <Thought message={item.message} latest={item.key === latestThoughtId} sessionId={sessionId} />}
          {item.kind === 'tool' && <ToolCallRow tc={item.tool} sessionId={sessionId} />}
          {item.kind === 'skill' && <SkillActivity message={item.message} />}
        </div>
      </div>)}
    </div>
  </section>;
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const MessageTimestamp = memo(function MessageTimestamp({ timestamp, className }: { timestamp: number; className?: string }) {
  const date = new Date(timestamp);
  const full = date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' });
  return <time className={className} dateTime={date.toISOString()} title={full} aria-label={full}>{clock(timestamp)}</time>;
});
function sameDay(a: number, b: number): boolean {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
function dateLabel(ts: number, today: number): string {
  const d = new Date(ts);
  const now = new Date(today);
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayMs = 86_400_000;
  if (that === today) return '今天';
  if (that === today - dayMs) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// A sub-agent (spawned via the `task` tool) as one collapsible card. The header
// shows the agent + status; expanding reveals its full inner work (tools,
// thinking, messages) — the same rendering as the main thread, nested.
function SubagentCard({ m, sessionId }: { m: ChatMessage; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const connected = useCockpit((s) => s.connState === 'open');
  const sa = m.subagent!;
  const status = {
    running: '已启动', activity: '有后续活动', completed: '本次执行已结束',
    failed: '失败', cancelled: '已取消', unknown: '未知',
  }[sa.status] ?? '未知';
  return (
    <div className="subagent-card" data-status={sa.status}>
      <div className="subagent-overview">
        <Disclosure className="subagent-head" open={open} onToggle={() => setOpen((v) => !v)}
          name={`子代理：${sa.displayName}`} leading={<span className="subagent-ico"><Icon name="agent" size={20} /></span>}>
          <span className="subagent-name">{sa.displayName}</span>
          <span className="subagent-status" title="根据已加载的子代理事件记录，不代表当前仍在运行或任务目标已完成。">
            记录：{status}{!connected && ' · 待同步'}
          </span>
          <span className="subagent-chevron"><DisclosureChevron open={open} /></span>
        </Disclosure>
        {sa.description && !open && <div className="subagent-desc">{sa.description}</div>}
      </div>
      {open && <SubagentDetails key={JSON.stringify([sessionId, sa.toolCallId])} m={m} sessionId={sessionId} />}
    </div>
  );
}

function SubagentDetails({ m, sessionId }: { m: ChatMessage; sessionId: string }) {
  const sa = m.subagent!;
  const connected = useCockpit((s) => s.connState === 'open');
  const toolCallId = sa.toolCallId;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [heldHead, setHeldHead] = useState<string | null>(null);
  const loaded = useMemo(() => m.subMessages ?? [], [m.subMessages]);
  const heldIndex = heldHead ? loaded.findIndex(message => message.id === heldHead) : -1;
  const sub = heldIndex > 0 ? loaded.slice(heldIndex) : loaded;
  useLayoutEffect(() => {
    const viewport = contentRef.current?.closest<HTMLElement>('.chat-messages');
    if (!viewport) return;
    const activity = (event: Event) => setHeldHead((event as CustomEvent<boolean>).detail ? loaded[0]?.id ?? null : null);
    viewport.addEventListener(READING_ACTIVITY_EVENT, activity);
    return () => viewport.removeEventListener(READING_ACTIVITY_EVENT, activity);
  }, [loaded]);
  return (
    <div className="subagent-body">
      {sa.prompt && (
        <div className="subagent-prompt">
          <div className="subagent-prompt-label">任务</div>
          <MessageBody body={sa.prompt} />
        </div>
      )}
      {sa.error && <div className="subagent-error">{sa.error}</div>}
      {!connected && toolCallId && <div role="status">等待连接…</div>}
      <div ref={contentRef} data-child-history>
        <TranscriptMessages messages={sub} sessionId={JSON.stringify([sessionId, toolCallId ?? m.id])}
          today={new Date().setHours(0, 0, 0, 0)} nested />
      </div>
      {!sub.length && <div className="subagent-empty">
        当前阅读窗口内暂无子代理消息。
      </div>}
    </div>
  );
}

function ElicitationRecordCard({ sessionId, message }: { sessionId: string; message: ChatMessage }) {
  const record = useElicitationRecords(sessionId).find(value => elicitationRecordId(value.requestId) === message.id);
  return <AnsweredElicitationCard message={message.content} source={record?.source} action={record?.action} />;
}

// One rendered message. Per @waksana's doctrine:
//  - user messages are right-aligned bubbles, time just outside, no label;
//  - assistant replies are NOT bubbles — they read as a full-width document,
//    with a quiet timestamp shown once per assistant group;
//  - system messages are a quiet centered note.
const MessageRow = memo(function MessageRow({ m, sessionId, showByline, nested }: { m: ChatMessage; sessionId: string; showByline: boolean; nested?: boolean }) {
  const anchorId = nested ? JSON.stringify([sessionId, m.id]) : m.id;
  if (m.subtype === 'subagent' && m.subagent) {
    return <div className="message is-doc" data-message-id={anchorId}><SubagentCard key={m.subagent.toolCallId ?? m.id} m={m} sessionId={sessionId} /></div>;
  }
  if (m.subtype === 'ask-reply') {
    return <div className="message is-doc" data-message-id={anchorId}>
      <AnsweredAskCard question={m.replyQuestion}><MessageContent message={m} /></AnsweredAskCard>
    </div>;
  }
  if (m.subtype === 'plan-reply') {
    return <div className="message is-doc" data-message-id={anchorId}>
      <AnsweredPlanCard summary={m.replyQuestion} result={m.content} />
    </div>;
  }
  if (m.subtype === 'elicitation-reply') {
    return <div className="message is-doc" data-message-id={anchorId}>
      <ElicitationRecordCard sessionId={sessionId} message={m} />
    </div>;
  }
  if (m.role === 'user') {
    return (
      <div className="user-message">
        <div className="message is-out" data-message-id={anchorId}>
          <MessageContent message={m} />
        </div>
        <div className="user-message-meta">
          <MessageTimestamp className="message-time" timestamp={m.timestamp} />
        </div>
      </div>
    );
  }
  if (m.role === 'system') {
    const level = m.level ?? 'info';
    return (
      <div className="message is-system" data-message-id={anchorId} data-level={level}>
        {level === 'error' && <span className="sys-ico" aria-hidden="true"><Icon name="error" size={16} /></span>}
        {m.content}
      </div>
    );
  }
  return (
    <article className="message is-doc">
      {showByline && hasMessageContent(m) && (
        <header className="doc-byline">
          <MessageTimestamp className="doc-time" timestamp={m.timestamp} />
        </header>
      )}
      {/* Date/byline removal on prepend must not move the reading anchor. */}
      <div className="message-speech" data-message-id={anchorId}>
        <MessageContent message={m} />
      </div>
    </article>
  );
});

const MessageGroup = memo(function MessageGroup({ m, sessionId, date, showByline, live, layout, nested, gap }: {
  m: ChatMessage; sessionId: string; date?: string; showByline: boolean; live: boolean;
  layout: ReturnType<typeof createMessageLayout>; nested?: boolean;
  gap: ReturnType<typeof transcriptGap>;
}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const skippable = canSkipMessageLayout(m, live);
  const answer = hasMessageContent(m);
  const plainAssistant = m.role === 'assistant' && m.subtype !== 'subagent';
  const empty = plainAssistant && !answer;
  useLayoutEffect(() => {
    if (skippable && frame.current) return layout.observe(frame.current);
  }, [layout, skippable, m, date, showByline]);
  return (
    <div ref={frame} className="msg-group" data-message-frame={nested ? undefined : m.id} data-child-message-frame={nested ? m.id : undefined}
      data-window-item-id={m.id}
      data-gap={gap}
      data-assistant-message={plainAssistant && !empty || undefined} data-empty={empty || undefined}>
      {date && !empty && <div className="date-separator" aria-hidden="true">{date}</div>}
      <RegionErrorBoundary label="这条消息" resetKey={m}>
        <MessageRow m={m} sessionId={sessionId} showByline={showByline} nested={nested} />
      </RegionErrorBoundary>
    </div>
  );
});

export const TranscriptMessages = memo(function TranscriptMessages({ messages, sessionId, liveId, today, nested = false }: {
  messages: ChatMessage[]; sessionId: string; liveId?: string; today: number; nested?: boolean;
}) {
  const layout = useMemo(() => createMessageLayout(), []);
  useLayoutEffect(() => () => layout.dispose(), [layout]);
  const [grouped, setGrouped] = useState(() => ({ source: messages, rows: groupTranscript(messages) }));
  let rows = grouped.rows;
  if (grouped.source !== messages) {
    rows = groupTranscript(messages, grouped.rows);
    setGrouped({ source: messages, rows });
  }
  const lastProcess = rows.findLast(row => row.kind === 'process');
  const firstItem = (row: TranscriptRow) => row.kind === 'process' ? row.items[0].message : row.message;
  const lastRow = rows.at(-1);
  const latestItemId = lastRow?.kind === 'process' ? lastRow.items.at(-1)?.key : lastRow?.message.id;
  return rows.map((row, i) => {
    const m = firstItem(row);
    const previous = rows[i - 1] && firstItem(rows[i - 1]);
    const newDay = !nested && (!previous || !sameDay(previous.timestamp, m.timestamp));
    const date = newDay ? dateLabel(m.timestamp, today) : undefined;
    const gap = newDay ? 'none' : transcriptGap(rows[i - 1], row);
    if (row.kind === 'process') return <div key={row.key} className="msg-group"
      data-window-item-id={m.id}
      data-gap={gap}
      data-message-frame={nested ? undefined : row.key} data-child-message-frame={nested ? row.key : undefined}>
      {date && <div className="date-separator" aria-hidden="true">{date}</div>}
      <RegionErrorBoundary label="这组过程记录" resetKey={row}>
        <MessageProcess items={row.items} identity={row.key} sessionId={sessionId}
          latest={row === lastProcess} latestItemId={latestItemId} />
      </RegionErrorBoundary>
    </div>;
    return (
      <MessageGroup key={m.id} m={m} sessionId={sessionId}
        date={date} nested={nested} gap={gap}
        showByline={m.role === 'assistant' && (newDay || previous?.role !== 'assistant')}
        live={m.role === 'assistant' && m.id === liveId} layout={layout} />
    );
  });
});
