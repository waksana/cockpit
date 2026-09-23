// Chat window (detail pane). Reading position and explicit bottom-follow are
// maintained by one scroll owner; message bodies reuse the markdown renderer.

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { MessageBody } from './MessageBody';
import { MessageContent } from './MessageContent';
import { hasMessageContent } from '../lib/messageContent';
import { Composer, ComposerNotices } from './Composer';
import { SessionControlBar, SessionControlActionButton } from './SessionControlBar';
import type { SessionControlAction } from '../lib/sessionControls';
import { useControlComposer } from '../lib/useControlComposer';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';
import { Button, IconButton } from './Button';
import type { ChatMessage, ChatSession, ExitPlanModeAction } from '../net/types';
import type { NativeDraftRequest } from '../lib/draft';
import { observeLocalSubmissions } from '../lib/localSubmission';
import { getDraftSession } from '../lib/draftSelection';
import type { SessionDraft } from '../lib/textDraft';
import { observeThreadScroll, READING_ACTIVITY_EVENT, type ThreadScroll } from './threadScroll';
import { observeHistoryPrefetch } from './historyPrefetch';
import { canSkipMessageLayout, createMessageLayout } from './messageLayout';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { ToolCallRow, ToolStatusIcon } from './ToolCallRow';
import { toolStatusLabel } from '../lib/toolStatus';
import { ActivityHeader } from './ActivityHeader';
import { DisclosureChoices } from './DisclosureChoices';
import { Disclosure, DisclosureChevron, TextClamp } from './Disclosure';
import { useDisclosureChoice } from '../lib/disclosureChoice';
import { groupTranscript, transcriptGap, type TranscriptRow, type ProcessItem } from '../lib/transcriptRows';
import { PlanCard, ElicitationCard } from './PendingDecision';
import { StateNotice } from './StateNotice';
import { useModuleRuntime } from './ModuleComponents';
import { hasNewTranscriptContent } from '../lib/transcriptActivity';
import { useRemovedControlFocus } from '../lib/useRemovedControlFocus';
import { sessionActivityIndicators } from '../lib/sessionActivity';
import { SessionActivity } from './SessionActivity';

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
  if (m.role === 'user') {
    const isAskReply = m.subtype === 'ask-reply';
    const cls = ['message', 'is-out'];
    if (isAskReply) cls.push('is-ask-reply');
    return (
      <div className="user-message">
        <div className={cls.join(' ')} data-message-id={anchorId}>
          {isAskReply && <div className="ask-reply-question" aria-label="回答的问题">
            <span className="ask-reply-label">问题</span>
            {m.replyQuestion || '原问题记录不可用'}
          </div>}
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
      <MessageRow m={m} sessionId={sessionId} showByline={showByline} nested={nested} />
    </div>
  );
});

const TranscriptMessages = memo(function TranscriptMessages({ messages, sessionId, liveId, today, nested = false }: {
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
      <MessageProcess items={row.items} identity={row.key} sessionId={sessionId}
        latest={row === lastProcess} latestItemId={latestItemId} />
    </div>;
    return (
      <MessageGroup key={m.id} m={m} sessionId={sessionId}
        date={date} nested={nested} gap={gap}
        showByline={m.role === 'assistant' && (newDay || previous?.role !== 'assistant')}
        live={m.role === 'assistant' && m.id === liveId} layout={layout} />
    );
  });
});

interface ThreadProps {
  session: ChatSession;
  onSend?: (request: NativeDraftRequest) => Promise<boolean>;
  onRespondAsk?: (requestId: string, answer: string, wasFreeform: boolean) => Promise<boolean>;
  onRespondPlan?: (requestId: string, action: ExitPlanModeAction) => Promise<boolean>;
  onRespondElicitation?: (requestId: string, action: 'accept' | 'decline' | 'cancel') => Promise<boolean>;
  onRemoveQueued?: (itemId: string) => void;
  onCancel?: () => void | Promise<void>;
  onInterrupt?: () => Promise<{ ok: true; interrupted: boolean }>;
  onLoadMore: () => void;
  onRetryHistory?: () => void;
  // Alternate activity/queue composition; Thread still owns decisions and drafts.
  composerControls?: ReactNode;
  promptBusy?: boolean;
  onControlAction?: (action: SessionControlAction) => Promise<void>;
  onRetryControls?: () => void;
  // Read-only transcript: renders the paginated
  // message list but hides the composer and every interactive banner, so the
  // conversation can be browsed but not driven.
  readOnly?: boolean;
}

export function Thread({ session, onSend, onRespondAsk, onRespondPlan, onRespondElicitation, onRemoveQueued, onCancel, onInterrupt, onLoadMore, onRetryHistory, composerControls, promptBusy = session.controls?.main ?? session.status === 'running', onControlAction, onRetryControls, readOnly = false }: ThreadProps) {
  const controls = !readOnly && onControlAction ? session.controls ?? session.controlsDisplay : undefined;
  const connected = useCockpit((s) => s.connState === 'open');
  const snapshotReady = useCockpit((s) => s.snapshotReady);
  const interruptAction = useKeyedAction(`interrupt:${session.sessionId}`);
  const stopAction = useKeyedAction(`stop:${session.sessionId}`);
  const canInterrupt = !!onInterrupt && session.loaded && session.status === 'running'
    && !session.loading && !session.closing && !session.cancelling && !session.compacting
    && session.nativeProcessing !== false && session.activity?.abortable !== false;
  const queueCount = session.activity
    ? session.activity.queue.pendingCount + session.activity.queue.steeringCount
    : session.queue?.length ?? 0;
  const showStop = !readOnly && !onControlAction && session.status === 'running' && !session.compacting;
  const stopPending = !!session.cancelling || stopAction.busy;
  const notAbortable = connected && snapshotReady && session.loaded && session.activity?.abortable === false && queueCount === 0
    && !session.ask && !session.planRequest && !session.elicitation;
  const stopDisabled = !connected || !session.loaded || session.loading || session.closing
    || !snapshotReady || (!stopPending && (!!session.activeOperations || interruptAction.busy || notAbortable)) || !onCancel;
  const showInterrupt = !readOnly && !onControlAction && queueCount > 0 && canInterrupt;
  const interruptResult = readOnly ? null : interruptAction.error
    ? `打断未确认：${interruptAction.error}。请核对会话状态，不要直接重试。`
    : null;
  const drafts = useMemo(() => getDraftSession(session.sessionId), [session.sessionId]);
  const runtime = useModuleRuntime();
  useLayoutEffect(() => { runtime.prepareDraft(drafts.prompt, readOnly); }, [runtime, drafts, readOnly]);
  const draftRevision = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  const askId = session.ask?.requestId, planId = session.planRequest?.requestId, elicitationId = session.elicitation?.requestId;
  const decisions = useMemo(() => ({
    loaded: session.loaded,
    ask: session.ask,
    planRequest: planId !== undefined ? { requestId: planId } : null,
    elicitation: elicitationId !== undefined ? { requestId: elicitationId } : null,
  }), [session.ask, planId, elicitationId, session.loaded]);
  const authoritative = connected && snapshotReady;
  const draft = useMemo(() => {
    void draftRevision;
    return drafts.current(decisions, authoritative);
  }, [drafts, decisions, authoritative, draftRevision]);
  useLayoutEffect(() => { drafts.synchronize(decisions, authoritative); }, [drafts, decisions, authoritative]);
  const askDraft = askId !== undefined ? drafts.candidate({ kind: 'ask', requestId: askId }) : undefined;
  const planDraft = planId !== undefined ? drafts.candidate({ kind: 'plan', requestId: planId }) : undefined;
  const elicitationDraft = elicitationId !== undefined ? drafts.candidate({ kind: 'elicitation', requestId: elicitationId }) : undefined;
  useLayoutEffect(() => { runtime.prepareDraft(draft, readOnly); }, [runtime, draft, readOnly]);
  const canAct = useRef(false);
  useLayoutEffect(() => {
    canAct.current = authoritative && !readOnly;
    return () => { canAct.current = false; };
  }, [session.sessionId, authoritative, readOnly]);
  const { pending: actionPending, hasContent } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const activityRefreshing = useCockpit(state => state.activityRefreshingIds.includes(session.sessionId));
  const activityItems = sessionActivityIndicators({
    ...session, activityRefreshing, needsDecision: !!(session.ask || session.planRequest || session.elicitation),
  }, connected && snapshotReady);
  const executionProgress = connected && snapshotReady && session.cancelling ? '正在停止…'
    : connected && snapshotReady && session.compacting ? '正在压缩上下文…'
    : actionPending && !readOnly ? session.ask ? '正在提交回答…' : '正在提交…'
    : connected && snapshotReady && session.activity?.processing ? session.intent : null;
  const executionLabel = [executionProgress, ...activityItems.map(item => item.label)].filter(Boolean).join(' · ') || '当前无活动';
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollOwnerRef = useRef<ThreadScroll | null>(null);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const visible = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  const [heldHead, setHeldHead] = useState<{ sessionId: string; id: string } | null>(null);
  // Keep the existing DOM prefix under an active gesture. Only newly received
  // older rows wait for settle; tail updates and already mounted history stay live.
  const messages = useMemo(() => {
    const start = heldHead?.sessionId === session.sessionId
      ? session.messages.findIndex((message) => message.id === heldHead.id) : -1;
    return start > 0 ? session.messages.slice(start) : session.messages;
  }, [heldHead, session.sessionId, session.messages]);
  const prependHeld = messages !== session.messages;
  const [hasNewContent, setHasNewContent] = useState(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const previousMessages = useRef<ChatMessage[]>([]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    previousMessages.current = [];
    const owner = observeThreadScroll(el, content, () => setHasNewContent(false), (active) => {
      const id = content.querySelector<HTMLElement>('[data-window-item-id]')?.getAttribute('data-window-item-id') ?? undefined;
      setHeldHead(active && id ? { sessionId: session.sessionId, id } : null);
    }, setAwayFromBottom);
    scrollOwnerRef.current = owner.scroll;
    // A new view enters at latest; only this mounted owner retains reading anchors.
    return () => {
      owner.dispose();
      scrollOwnerRef.current = null;
    };
  }, [session.sessionId]);

  useLayoutEffect(() => {
    const owner = scrollOwnerRef.current;
    if (!owner || readOnly) return;
    return observeLocalSubmissions(session.sessionId, () => owner.follow());
  }, [session.sessionId, readOnly]);

  // Every mounted viewport owns its measured fill and near-head prefetch. A
  // retained native page proves neither two screens nor this viewport's size.
  // Existing rows stay visible; the separate scroll owner preserves the reader.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!connected || !snapshotReady || !pageVisible || !el || !content || !session.materialized
      || session.loadingHistory || session.historyError || session.error || session.historyStale || prependHeld) return;
    const needsFill = () => el.clientHeight > 0 && el.scrollHeight < el.clientHeight * 2;
    return observeHistoryPrefetch(el, content, () => session.hasMore && !session.incompleteBoundary
      && (needsFill() || !scrollOwnerRef.current?.following), onLoadMore, () => el.scrollTop, needsFill);
  }, [session.sessionId, session.hasMore, session.materialized, session.loadingHistory, session.historyError,
    session.error, session.historyStale, session.incompleteBoundary, onLoadMore,
    prependHeld, pageVisible, connected, snapshotReady]);

  useLayoutEffect(() => {
    if (!scrollOwnerRef.current?.following && hasNewTranscriptContent(previousMessages.current, session.messages)) {
      setHasNewContent(true);
    }
    previousMessages.current = session.messages;
    scrollOwnerRef.current?.changed({ contentReady: !!contentRef.current?.querySelector('[data-message-frame]') });
  }, [messages, session.sessionId, session.messages, session.status, session.compacting, session.error, session.materialized, session.hasMore]);

  const jumpToBottom = useCallback(() => { scrollOwnerRef.current?.follow(); }, []);

  // A composer send answers a pending ask (respondAsk), submits feedback on
  // a pending plan (planSupersede), or otherwise sends a normal prompt.
  const ask = session.ask;
  const planRequest = session.planRequest;
  const hasPendingDecision = !readOnly && !!(planRequest || session.elicitation);
  const hasExecution = session.compacting || session.status === 'running' || (!readOnly && queueCount > 0);
  const hasInputHeader = !controls && composerControls === undefined && !!(hasExecution || hasPendingDecision || (!readOnly && ask) || activityItems.length);
  const inputCardRef = useRef<HTMLDivElement | null>(null);
  const inputBodyId = useId();
  // The fold survives ordinary updates; a new request or idle input opens afresh.
  const inputFoldKey = JSON.stringify([session.sessionId, ask?.requestId, planRequest?.requestId, session.elicitation?.requestId, hasInputHeader]);
  const [inputFold, setInputFold] = useState({ key: inputFoldKey, folded: false });
  if (inputFold.key !== inputFoldKey) setInputFold({ key: inputFoldKey, folded: false });
  const inputOpen = inputFold.key !== inputFoldKey || !inputFold.folded;
  const decisionKey = askId ? `ask:${askId}` : planId ? `plan:${planId}` : elicitationId ? `elicitation:${elicitationId}` : undefined;
  const [controlsDisclosure, setControlsDisclosure] = useState<{ decision?: string; open: boolean }>({ open: true });
  const controlsOpen = decisionKey && decisionKey !== controlsDisclosure.decision ? true : controlsDisclosure.open;
  const releaseEditorSize = useControlComposer(inputCardRef, !!controls, draft.reference.id, decisionKey);
  const executionControlRef = useRemovedControlFocus(session.sessionId, inputCardRef);
  const cancelDecision = (kind: 'ask' | 'plan' | 'elicitation', requestId: string, pending: boolean) =>
    controls && onControlAction ? <SessionControlActionButton
      identity={JSON.stringify([session.sessionId, session.controls?.token ?? session.controlsDisplay?.token, 'cancel-decision', kind, requestId])}
      label={kind === 'ask' ? '取消问题并中断当前回合' : kind === 'plan' ? '取消计划确认（仅退出计划）' : '取消工具确认'}
      icon="close" waiting="取消中…" disabled={!authoritative || pending || !session.loaded || !!session.closing || !!session.loading
        || !!session.controlsStale || activityRefreshing}
      controlRef={executionControlRef} onAction={() => onControlAction({ type: 'cancel-decision', kind, requestId })} /> : undefined;
  const operation = draft.reference.purpose.kind;
  const runAction = useCallback((target: SessionDraft, send: () => Promise<boolean> | undefined): Promise<boolean> => (
    target.runAction(send, () => canAct.current && drafts.isLive(target))
  ), [drafts]);

  const handleSend = useCallback((): Promise<boolean> => draft.send(
    request => onSend?.(request) ?? Promise.resolve(false), () => canAct.current && drafts.isCurrent(draft),
  ), [draft, drafts, onSend]);

  const handleChoice = useCallback((choice: string): Promise<boolean> => {
    if (!ask || !askDraft) return Promise.resolve(false);
    return runAction(askDraft, () => onRespondAsk?.(ask.requestId, choice, false));
  }, [ask, askDraft, onRespondAsk, runAction]);

  return (
    <DisclosureChoices key={session.sessionId}><main className="chat">
      <div className="chat-transcript">
        <div ref={scrollRef} className="chat-messages" tabIndex={0} aria-label="对话消息" aria-busy={session.loadingHistory}>
          <div ref={contentRef} className="chat-message-content">
            <div className="chat-history-controls">
              {(!session.materialized || session.hasMore) && <StateNotice className="chat-history-loading">
                加载更早的消息…
              </StateNotice>}
              <div className="chat-history-actions">
                {session.loadingHistory ? null : session.historyStale || !session.materialized ? (
                  <StateNotice className="chat-loading-older" kind={session.historyError ? 'error' : 'info'}>
                    {session.historyError ? `历史加载失败：${session.historyError}` : '对话历史尚未同步。'}
                    {onRetryHistory && <Button className="chat-history-retry" onClick={() => {
                      scrollOwnerRef.current?.follow();
                      onRetryHistory();
                    }}>
                      重新读取最新历史
                    </Button>}
                  </StateNotice>
                ) : session.historyError ? <StateNotice className="chat-loading-older" kind="error">
                  历史加载失败：{session.historyError}
                  {onRetryHistory && <Button className="chat-history-retry" onClick={onRetryHistory}>重试加载历史</Button>}
                </StateNotice> : null}
              </div>
              {session.partialHistory && <p className="chat-history-note" role="status">
                断线期间的临时片段可能不完整；已保留现有文字，以保存后的完整消息为准。
              </p>}
              {session.incompleteBoundary && !session.hasMore && <p className="chat-history-note">
                部分工具记录缺少对应的发起消息，现有历史无法补齐。
              </p>}
            </div>
            <div className="chat-message-rows">
              {session.messages.length === 0 && session.materialized && !session.historyStale && !session.loadingHistory && !session.hasMore && (
                <div className="chat-empty-hint"><Icon name="newchat" size={28} />
                  <strong>开始对话</strong><span>输入消息开始讨论。</span><code>{session.cwd}</code></div>
              )}
              <TranscriptMessages messages={messages} sessionId={session.sessionId}
                liveId={session.status === 'running' ? session.messages.at(-1)?.id : undefined}
                today={new Date().setHours(0, 0, 0, 0)} />

            </div>
          </div>
        </div>

        {awayFromBottom && (
          <Button className="new-msg-badge" onClick={jumpToBottom}>
            {hasNewContent ? '有新内容 · 回到最新' : '回到最新'}
          </Button>
        )}
      </div>

      <div className="chat-input-area">
        <div className="chat-input-notices">
          {!readOnly && session.controlsError && <p className="chat-error" role="alert">
            活动列表读取失败：{session.controlsError}
            {onRetryControls && <Button disabled={!authoritative || activityRefreshing}
              onClick={onRetryControls}>重试</Button>}
          </p>}
          {session.error && <p className="chat-error" role="alert">错误: {session.error}
            {onRetryHistory && session.materialized && !session.historyStale && <Button
              onClick={onRetryHistory}>重试同步</Button>}
          </p>}
          {interruptResult && <p className="chat-interrupt-status" tabIndex={0} aria-label="打断结果" role={interruptAction.error ? 'alert' : 'status'}>
            {interruptResult}
          </p>}
          {stopAction.error && <p className="chat-interrupt-status" role="alert">
            停止结果未确认：{stopAction.error}
          </p>}
          {!readOnly && <ComposerNotices draft={draft} />}
        </div>
        <div className="chat-input-card" ref={inputCardRef} data-open={inputOpen}
          data-controls={!!controls || undefined} data-controls-open={controls ? controlsOpen : undefined}
          onChange={controls ? event => { if (event.target instanceof HTMLTextAreaElement) releaseEditorSize(); } : undefined}
          data-header={hasInputHeader || undefined} data-decision={!!(!readOnly && (ask || hasPendingDecision)) || undefined}
          data-question={(!readOnly && operation === 'ask') || undefined}>
          <div className="chat-execution-head" hidden={!hasInputHeader}>
            <Disclosure className="chat-execution-toggle" open={inputOpen} onToggle={() => setInputFold({ key: inputFoldKey, folded: inputOpen })}
              controls={inputBodyId} name={`输入卡片：${executionLabel}`}>
              <span className="chat-execution-label" role="status" title={executionLabel}
                aria-label={executionLabel}>
                {executionProgress && <span className="chat-execution-progress">{executionProgress}</span>}
                <SessionActivity items={activityItems} />
              </span>
              {!readOnly && hasContent && !inputOpen && <span className="chat-folded-draft">有草稿</span>}
            </Disclosure>
            {(showStop || showInterrupt) && <span className="chat-execution-actions" role="group" aria-label="执行操作">
              {showInterrupt && <Button ref={executionControlRef} className="chat-interrupt"
                disabled={!interruptAction.connected || (!!session.activeOperations && !interruptAction.busy)}
                aria-disabled={interruptAction.busy || undefined}
                onClick={() => {
                  void interruptAction.run(async () => {
                    await onInterrupt!();
                  });
                }}>{interruptAction.busy ? '正在请求…' : '打断并处理队列'}</Button>}
              {showStop && <Button ref={executionControlRef} className="chat-typing-stop" danger disabled={stopDisabled}
                aria-disabled={stopPending || undefined} aria-busy={stopPending || undefined}
                onClick={() => {
                  if (!stopDisabled && !stopPending) void stopAction.run(async () => { await onCancel?.(); });
                }}>
                <Icon name="stop" size={16} />
                {stopPending ? '正在停止…' : notAbortable ? '当前不可中断' : queueCount > 0 ? '停止并清空队列' : '停止'}
              </Button>}
            </span>}
          </div>
          <div id={inputBodyId} className="chat-input-card-body" hidden={!inputOpen}>
            {controls && onControlAction && <SessionControlBar session={session} controls={controls} connected={authoritative}
              expanded={controlsOpen} disabled={!authoritative || !session.loaded || !!session.loading || !!session.closing || activityRefreshing || !!session.controlsStale}
              controlRef={executionControlRef} onAction={onControlAction}
              onToggle={() => { setControlsDisclosure({ decision: decisionKey, open: !controlsOpen }); }} />}
            {!readOnly && composerControls}
            <div className="chat-input-context">
              {!readOnly && !onControlAction && composerControls === undefined && queueCount > 0 && <div className="chat-queue" aria-label="排队中的消息">
                {session.queue?.map((q) => (
                  <div key={q.id} className="chat-queue-item">
                    <TextClamp className="chat-queue-entry" text={q.text} label="排队消息" lines={1} />
                    <div className="chat-queue-copy"><CopyButton text={q.text} label="复制排队消息" /></div>
                    <IconButton ref={executionControlRef} className="chat-queue-remove" icon="close" iconSize={16} disabled={!connected || !onRemoveQueued}
                      label={`移除排队消息：${q.text}`} onClick={() => onRemoveQueued?.(q.id)} />
                  </div>
                ))}
              </div>}
              {hasPendingDecision && <div className="chat-decisions">
                {planRequest && planDraft && <PlanCard request={planRequest}
                  pending={planDraft.getSnapshot().pending}
                  actions={cancelDecision('plan', planRequest.requestId, planDraft.getSnapshot().pending)}
                  disabled={!authoritative || !onRespondPlan}
                  onSelect={action => { void runAction(planDraft,
                    () => onRespondPlan?.(planRequest.requestId, action)); }} />}
                {session.elicitation && elicitationDraft && <ElicitationCard request={session.elicitation}
                  pending={elicitationDraft.getSnapshot().pending}
                  actions={cancelDecision('elicitation', session.elicitation.requestId, elicitationDraft.getSnapshot().pending)}
                  disabled={!authoritative || !onRespondElicitation}
                  onSelect={action => { void runAction(elicitationDraft,
                    () => onRespondElicitation?.(session.elicitation!.requestId, action)); }} />}
              </div>}
            </div>
            {readOnly ? (
              <div className="chat-readonly-note" aria-label="只读会话">只读会话</div>
            ) : (
              <Composer
                key={!onControlAction && composerControls === undefined ? draft.reference.id : 'shared-composer'}
                busy={promptBusy && !ask && !planRequest}
                submitLabel={ask ? '提交回答' : planRequest ? '发送新指令' : undefined}
                disabled={!!session.compacting && session.status !== 'running'}
                placeholder={(session.compacting && session.status !== 'running') ? '正在压缩…' : (ask ? (ask.allowFreeform === false ? '请选择上方选项' : '输入回答…') : (planRequest ? '输入新指令…' : operation === 'elicitation' ? '请选择上方操作' : promptBusy ? '加入队列' : '输入消息…'))}
                draft={draft}
                editorRef={executionControlRef}
                statusInHeader={hasInputHeader}
                ask={ask ? { request: ask, disabled: !authoritative || !onRespondAsk, onChoice: choice => { void handleChoice(choice); },
                  actions: cancelDecision('ask', ask.requestId, actionPending) } : undefined}
                onSend={handleSend}
                sendBlocked={!connected || !snapshotReady || ask?.allowFreeform === false || operation === 'elicitation' || !onSend}
              />
            )}
          </div>
        </div>
      </div>
    </main></DisclosureChoices>
  );
}
