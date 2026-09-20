// Chat window (detail pane). Reading position and explicit bottom-follow are
// maintained by one scroll owner; message bodies reuse the markdown renderer.

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MessageBody } from './MessageBody';
import { MessageContent } from './MessageContent';
import { hasMessageContent } from '../lib/messageContent';
import { Composer, ComposerNotices } from './Composer';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';
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
import { useDisclosureChoice } from '../lib/disclosureChoice';
import { groupTranscript, transcriptGap, type TranscriptRow, type ProcessItem } from '../lib/transcriptRows';
import { PlanCard, ElicitationCard } from './PendingDecision';
import { StateNotice } from './StateNotice';
import { useModuleRuntime } from './ModuleComponents';
import { useClippedText } from '../lib/useClippedText';
import { hasNewTranscriptContent } from '../lib/transcriptActivity';
import { useRemovedControlFocus } from '../lib/useRemovedControlFocus';

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
  const title = [tools.length ? `${tools.length} 次工具调用` : '', thoughts.length ? `${thoughts.length} 次思考` : '',
    skills.length ? skills.length === 1 ? `Skill · ${skills[0].message.content}` : `${skills.length} 次 Skill 使用` : ''].filter(Boolean).join(' · ');
  const { ref: titleRef, clipped: titleClipped } = useClippedText(title);
  const states = [
    [tools.filter(tool => tool.status === 'failed').length, 'failed'],
    [tools.filter(tool => tool.status === 'in_progress').length, 'in_progress'],
    [tools.filter(tool => tool.status === 'pending').length, 'pending'],
    [tools.filter(tool => !tool.status).length, undefined],
  ] as const;
  const notices = states.filter(([count]) => count > 0).map(([count, status]) => `${count} 项${toolStatusLabel(status)}`);
  if (thoughts.some(item => item.message.incomplete)) notices.push('思考归属未确认');
  const description = [title, ...notices].join(' · ');
  const timestamp = items[0].message.timestamp;
  const time = clock(timestamp);
  return <section className="message-process" data-failed={states[0][0] > 0 || undefined}>
    <div data-message-id={JSON.stringify([sessionId, identity])}><button type="button" className="process-summary ck-button" aria-expanded={open} aria-controls={contentId}
      aria-label={`${open ? '收起' : '展开'}过程：${description} · ${time}`} title={description}
      onClick={toggle}>
      <span className="process-summary-chevron"><Icon name="down" size={16} /></span>
      <span ref={titleRef} className="process-summary-title">{title}</span>
      <span className="process-summary-states">
        {states.filter(([count]) => count > 0).map(([count, status]) => <span key={status ?? 'unknown'}
          className="process-summary-status" title={`${count} 项${toolStatusLabel(status)}`} data-status={status ?? 'unknown'}>
          <ToolStatusIcon status={status} />{count}
        </span>)}
        {thoughts.some(item => item.message.incomplete) && <span title="思考归属未确认"><Icon name="error" size={16} /></span>}
      </span>
      <MessageTimestamp timestamp={timestamp} />
    </button></div>
    <div id={contentId} className="message-process-content" hidden={!open} data-child-history>
      {open && titleClipped && <div className="process-expanded-summary">{title}</div>}
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
        <button type="button" className="subagent-head ck-button rp" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="subagent-ico"><Icon name="newchat" size={20} /></span>
          <span className="subagent-name">{sa.displayName}</span>
          <span className="subagent-status" title="根据已加载的子代理事件记录，不代表当前仍在运行或任务目标已完成。">
            记录：{status}{!connected && ' · 待同步'}
          </span>
          <span className="subagent-chevron"><Icon name={open ? 'up' : 'down'} size={16} /></span>
        </button>
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
  onCancel?: () => void;
  onInterrupt?: () => Promise<{ ok: true; interrupted: boolean }>;
  onLoadMore: () => void;
  onRetryHistory?: () => void;
  // Read-only transcript: renders the paginated
  // message list but hides the composer and every interactive banner, so the
  // conversation can be browsed but not driven.
  readOnly?: boolean;
}

export function Thread({ session, onSend, onRespondAsk, onRespondPlan, onRespondElicitation, onRemoveQueued, onCancel, onInterrupt, onLoadMore, onRetryHistory, readOnly = false }: ThreadProps) {
  const connected = useCockpit((s) => s.connState === 'open');
  const snapshotReady = useCockpit((s) => s.snapshotReady);
  const interruptAction = useKeyedAction(`interrupt:${session.sessionId}`);
  const [interruptNotice, setInterruptNotice] = useState<{ sessionId: string; text: string } | null>(null);
  const canInterrupt = !!onInterrupt && session.loaded && session.status === 'running'
    && !session.loading && !session.closing && !session.cancelling && !session.compacting
    && session.nativeProcessing !== false;
  const queueCount = session.queue?.length ?? 0;
  const showStop = !readOnly && session.status === 'running' && !session.compacting;
  const stopPending = !!session.cancelling;
  const stopDisabled = !connected || !session.loaded || session.loading || session.closing
    || (!stopPending && (!!session.activeOperations || interruptAction.busy)) || !onCancel;
  const showInterrupt = !readOnly && queueCount > 0 && canInterrupt;
  const interruptResult = readOnly ? null : interruptAction.error
    ? `打断未确认：${interruptAction.error}。请核对会话状态，不要直接重试。`
    : interruptNotice?.sessionId === session.sessionId ? interruptNotice.text : null;
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
  const executionLabel = session.cancelling ? '正在停止…' : session.compacting ? '正在压缩上下文…'
    : actionPending && !readOnly ? session.ask ? '正在提交回答…' : '正在提交…'
    : session.ask ? '等待你的回答' : session.planRequest ? '等待确认计划'
      : session.elicitation ? '等待工具确认' : session.status === 'running'
        ? session.intent || '执行中…' : queueCount > 0 ? '等待处理' : '执行结果';
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
    scrollOwnerRef.current?.changed();
  }, [messages, session.messages, session.status, session.compacting, session.error, session.materialized, session.hasMore]);

  const jumpToBottom = useCallback(() => { scrollOwnerRef.current?.follow(); }, []);

  // A composer send answers a pending ask (respondAsk), submits feedback on
  // a pending plan (planSupersede), or otherwise sends a normal prompt.
  const ask = session.ask;
  const planRequest = session.planRequest;
  const hasPendingDecision = !readOnly && !!(planRequest || session.elicitation);
  const hasExecution = session.compacting || session.status === 'running' || (!readOnly && queueCount > 0);
  const hasInputHeader = !!(hasExecution || hasPendingDecision || (!readOnly && ask));
  const inputCardRef = useRef<HTMLDetailsElement | null>(null);
  useLayoutEffect(() => {
    // Native disclosure survives ordinary updates; a new request or idle input opens afresh.
    if (inputCardRef.current) inputCardRef.current.open = true;
  }, [session.sessionId, ask?.requestId, planRequest?.requestId, session.elicitation?.requestId, hasInputHeader]);
  const executionControlRef = useRemovedControlFocus(session.sessionId, inputCardRef);
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
                    {onRetryHistory && <button type="button" className="dialog-btn ck-button rp" onClick={() => {
                      scrollOwnerRef.current?.follow();
                      onRetryHistory();
                    }}>
                      重新读取最新历史
                    </button>}
                  </StateNotice>
                ) : session.historyError ? <StateNotice className="chat-loading-older" kind="error">
                  历史加载失败：{session.historyError}
                  {onRetryHistory && <button type="button" className="dialog-btn ck-button rp" onClick={onRetryHistory}>重试加载历史</button>}
                </StateNotice> : null}
              </div>
              {session.partialHistory && <p className="chat-history-note" role="status">
                断线期间的临时片段可能不完整；已保留现有文字，以原生保存后的完整消息为准。
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
          <button className="new-msg-badge ck-button" type="button" onClick={jumpToBottom}>
            {hasNewContent ? '有新内容 · 回到最新' : '回到最新'}
          </button>
        )}
      </div>

      <div className="chat-input-area">
        <div className="chat-input-notices">
          {session.error && <p className="chat-error" role="alert">错误: {session.error}
            {onRetryHistory && session.materialized && !session.historyStale && <button type="button"
              className="dialog-btn ck-button rp" onClick={onRetryHistory}>重试同步</button>}
          </p>}
          {interruptResult && <p className="chat-interrupt-status" tabIndex={0} aria-label="打断结果" role={interruptAction.error ? 'alert' : 'status'}>
            {interruptResult}
          </p>}
          {!readOnly && <ComposerNotices draft={draft} />}
        </div>
        <details className="chat-input-card" ref={inputCardRef} open
          data-header={hasInputHeader || undefined} data-decision={!!(!readOnly && (ask || hasPendingDecision)) || undefined}
          data-question={(!readOnly && operation === 'ask') || undefined}>
          <summary className="chat-execution-head" hidden={!hasInputHeader} aria-label={`${executionLabel}，展开或收起输入卡片`}>
            <span className="chat-execution-label" role="status" title={executionLabel}
              data-running={session.status === 'running' || undefined}>{executionLabel}</span>
            {!readOnly && hasContent && <span className="chat-folded-draft">有草稿</span>}
            {(showStop || showInterrupt) && <span className="chat-execution-actions" role="group" aria-label="执行操作"
              onClick={event => event.stopPropagation()}>
              {showInterrupt && <button ref={executionControlRef} type="button" className="chat-interrupt ck-button"
                disabled={!interruptAction.connected || (!!session.activeOperations && !interruptAction.busy)}
                aria-disabled={interruptAction.busy || undefined}
                onClick={() => {
                  let interrupted = false;
                  void interruptAction.run(async () => {
                    const result = await onInterrupt!();
                    interrupted = result.interrupted;
                  }, () => setInterruptNotice({ sessionId: session.sessionId, text: interrupted
                    ? '已请求打断；队列由 Copilot 接着处理。'
                    : '当前没有可打断的主回合；队列未改动。' }));
                }}>{interruptAction.busy ? '正在请求…' : '打断并处理队列'}</button>}
              {showStop && <button ref={executionControlRef} type="button" className="chat-typing-stop ck-button" disabled={stopDisabled}
                aria-disabled={stopPending || undefined} aria-busy={stopPending || undefined}
                onClick={() => { if (!stopDisabled && !stopPending) onCancel?.(); }}>
                <Icon name="stop" size={16} />
                {session.cancelling ? '正在停止…' : queueCount > 0 ? '停止并清空队列' : '停止'}
              </button>}
            </span>}
          </summary>
          <div className="chat-input-card-body">
            <div className="chat-input-context">
              {!readOnly && queueCount > 0 && <div className="chat-queue" aria-label="排队中的消息">
                {session.queue?.map((q) => (
                  <div key={q.id} className="chat-queue-item">
                    <details className="chat-queue-entry">
                      <summary className="chat-queue-text" aria-label={`查看排队消息：${q.text}`}>
                        {q.text}
                      </summary>
                    </details>
                    <div className="chat-queue-copy"><CopyButton text={q.text} label="复制排队消息" /></div>
                    <button ref={executionControlRef} type="button" className="chat-queue-remove ck-icon-button" disabled={!connected || !onRemoveQueued}
                      aria-label={`移除排队消息：${q.text}`} onClick={() => onRemoveQueued?.(q.id)}><Icon name="close" size={16} /></button>
                  </div>
                ))}
              </div>}
              {hasPendingDecision && <div className="chat-decisions">
                {planRequest && planDraft && <PlanCard request={planRequest}
                  pending={planDraft.getSnapshot().pending}
                  disabled={!authoritative || !onRespondPlan}
                  onSelect={action => { void runAction(planDraft,
                    () => onRespondPlan?.(planRequest.requestId, action)); }} />}
                {session.elicitation && elicitationDraft && <ElicitationCard request={session.elicitation}
                  pending={elicitationDraft.getSnapshot().pending}
                  disabled={!authoritative || !onRespondElicitation}
                  onSelect={action => { void runAction(elicitationDraft,
                    () => onRespondElicitation?.(session.elicitation!.requestId, action)); }} />}
              </div>}
            </div>
            {readOnly ? (
              <div className="chat-readonly-note" aria-label="只读会话">只读会话</div>
            ) : (
              <Composer
                key={draft.reference.id}
                busy={session.status === 'running' && !ask && !planRequest}
                submitLabel={ask ? '提交回答' : planRequest ? '发送新指令' : undefined}
                disabled={!!session.compacting && session.status !== 'running'}
                placeholder={(session.compacting && session.status !== 'running') ? '正在压缩…' : (ask ? (ask.allowFreeform === false ? '请选择上方选项' : '输入回答…') : (planRequest ? '输入新指令…' : operation === 'elicitation' ? '请选择上方操作' : session.status === 'running' ? '加入队列' : '输入消息…'))}
                draft={draft}
                editorRef={executionControlRef}
                statusInHeader={hasInputHeader}
                ask={ask ? { request: ask, disabled: !authoritative || !onRespondAsk, onChoice: choice => { void handleChoice(choice); } } : undefined}
                onSend={handleSend}
                sendBlocked={!connected || !snapshotReady || ask?.allowFreeform === false || operation === 'elicitation' || !onSend}
              />
            )}
          </div>
        </details>
      </div>
    </main></DisclosureChoices>
  );
}
