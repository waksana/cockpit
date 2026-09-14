// Chat window (detail pane). Reading position and explicit bottom-follow are
// maintained by one scroll owner; message bodies reuse the markdown renderer.

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MessageBody } from './MessageBody';
import { MessageContent } from './MessageContent';
import { hasMessageContent } from '../lib/messageContent';
import { Composer } from './Composer';
import { Icon } from './Icon';
import type { ChatMessage, ChatSession, ToolCall, ExitPlanModeAction } from '../net/types';
import { acknowledgeInView, sendThreadDraft } from '../lib/draft';
import { getSessionDraft } from '../lib/textDraft';
import { observeThreadScroll, READING_ACTIVITY_EVENT, type ThreadScroll } from './threadScroll';
import { observeHistoryPrefetch } from './historyPrefetch';
import { canSkipMessageLayout, createMessageLayout } from './messageLayout';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { CopyButton } from './CopyButton';
import { ActivityHeader } from './ActivityHeader';
import { DisclosureChoices } from './DisclosureChoices';
import { useDisclosureChoice } from '../lib/disclosureChoice';
import { groupTranscript, type TranscriptRow, type ProcessItem } from '../lib/transcriptRows';

// Plan-exit action → button label. The SDK offers a subset of these (incl.
// autopilot_fleet); the card renders one button per offered action rather than a
// fixed three, so a new action surfaces automatically. The recommended one is
// emphasized. Order here is the fallback when the event omits an explicit order.
const PLAN_ACTION_LABEL: Record<ExitPlanModeAction, string> = {
  interactive: '开始执行（交互）',
  autopilot: '自动执行',
  autopilot_fleet: '并行执行（fleet）',
  exit_only: '仅退出计划',
};
const PLAN_ACTION_ORDER: ExitPlanModeAction[] = ['interactive', 'autopilot', 'autopilot_fleet', 'exit_only'];

// Static glyphs accompany the explicit status text; no decorative motion.
function ToolStatusIcon({ status }: { status: ToolCall['status'] }) {
  switch (status) {
    case 'completed': return <Icon name="check" size={16} />;
    case 'failed': return <Icon name="error" size={16} />;
    default: return <Icon name="radiooff" size={16} />;
  }
}

function ToolCallRow({ tc, sessionId }: { tc: ToolCall; sessionId: string }) {
  const { open, toggle } = useDisclosureChoice(JSON.stringify([sessionId, 'tool', tc.toolCallId]), false);
  const status = tc.status ? {
    completed: '已完成', failed: '失败', in_progress: '执行中', pending: '待执行',
  }[tc.status] : '状态未知';
  return (
    <div className="msg-tool" data-status={tc.status ?? 'unknown'} data-open={open || undefined}>
      <ActivityHeader className="tool-head tool-toggle" icon={<ToolStatusIcon status={tc.status} />}
        title={tc.title} status={tc.status === 'completed' ? undefined : status} accessibleStatus={status}
        disclosure={{ open, onToggle: toggle }} />
      {open && (
        <div className="activity-detail tool-detail">
          {tc.name && tc.name !== tc.title && <div className="tool-detail-name">{tc.name}</div>}
          {!tc.args && !tc.output && <div className="tool-detail-empty">暂无参数或输出记录。</div>}
          {tc.args && <section><div className="tool-detail-label">参数 <CopyButton text={tc.args} label="复制工具参数" /></div>
            <pre className="tool-args" tabIndex={0} aria-label="工具参数">{tc.args}</pre></section>}
          {tc.output && <section><div className="tool-detail-label">输出 <CopyButton text={tc.output} label="复制工具输出" /></div>
            <pre className="tool-output" tabIndex={0} aria-label="工具输出">{tc.output}</pre></section>}
        </div>
      )}
    </div>
  );
}

function Thought({ message, latest, sessionId }: { message: ChatMessage; latest: boolean; sessionId: string }) {
  const { open, toggle } = useDisclosureChoice(JSON.stringify([sessionId, 'thought', message.thoughtKey ?? message.id]), latest);
  return (
    <div className="msg-thought-block">
      <ActivityHeader className="thought-toggle" icon={<Icon name="skills" size={16} />}
        title="思考过程" disclosure={{ open, onToggle: toggle }} />
      {message.incomplete && <div className="thought-incomplete" role="status">{message.incomplete}</div>}
      {open && <div className="activity-detail msg-thought">{message.thought}</div>}
    </div>
  );
}

function SkillActivity({ message }: { message: ChatMessage }) {
  return <ActivityHeader icon={<Icon name="skills" size={16} />} title={`skill · ${message.content}`} />;
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
  const latestThoughtId = latest && items.at(-1)?.key === latestItemId && items.at(-1)?.kind === 'thought'
    ? latestItemId : undefined;
  const title = [tools.length ? `${tools.length} 次工具调用` : '', thoughts.length ? `${thoughts.length} 次思考` : ''].filter(Boolean).join(' · ') || '技能使用';
  const states = [
    [tools.filter(tool => tool.status === 'failed').length, '项失败'],
    [tools.filter(tool => tool.status === 'in_progress').length, '项执行中'],
    [tools.filter(tool => tool.status === 'pending').length, '项待执行'],
    [tools.filter(tool => !tool.status).length, '项状态未知'],
  ] as const;
  const notices = states.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  if (thoughts.some(item => item.message.incomplete)) notices.push('思考归属未确认');
  const description = [title, ...notices].join(' · ');
  const timestamp = items[0].message.timestamp;
  const time = clock(timestamp);
  return <section className="message-process" data-failed={states[0][0] > 0 || undefined}>
    <div data-message-id={JSON.stringify([sessionId, identity])}><button type="button" className="process-summary" aria-expanded={open} aria-controls={contentId}
      aria-label={`${open ? '收起' : '展开'}过程：${description} · ${time}`} title={description}
      onClick={toggle}>
      <span className="process-summary-chevron"><Icon name="down" size={14} /></span>
      <span className="process-summary-title">{title}</span>
      {notices.length > 0 && <span className="process-summary-status">{notices[0]}</span>}
      <time dateTime={new Date(timestamp).toISOString()}>{time}</time>
    </button></div>
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
      <button type="button" className="subagent-head rp" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="subagent-ico"><Icon name="newchat" size={18} /></span>
        <span className="subagent-name">{sa.displayName}</span>
        <span className="subagent-status" title="根据已加载的子代理事件记录，不代表当前仍在运行或任务目标已完成。">
          记录：{status}{!connected && ' · 待同步'}
        </span>
        <span className="subagent-chevron"><Icon name={open ? 'up' : 'down'} size={14} /></span>
      </button>
      {sa.description && !open && <div className="subagent-desc">{sa.description}</div>}
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
//    with a light byline (icon + Copilot + time) shown once per assistant group;
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
          {isAskReply && <span className="ask-reply-tag" aria-label="对提问的回复">↩ 回复</span>}
          <MessageContent message={m} sessionId={sessionId} />
        </div>
        <div className="user-message-meta">
          <span className="message-time">{clock(m.timestamp)}</span>
        </div>
      </div>
    );
  }
  if (m.role === 'system') {
    const level = m.level ?? 'info';
    return (
      <div className="message is-system" data-message-id={anchorId} data-level={level}>
        {level === 'error' && <span className="sys-ico" aria-hidden="true"><Icon name="error" size={14} /></span>}
        {m.content}
      </div>
    );
  }
  return (
    <article className="message is-doc">
      {showByline && hasMessageContent(m) && (
        <header className="doc-byline">
          <span className="doc-mark" aria-hidden="true"><Icon name="compose" size={15} /></span>
          <span className="doc-time">{clock(m.timestamp)}</span>
        </header>
      )}
      {/* Date/byline removal on prepend must not move the reading anchor. */}
      <div data-message-id={anchorId}>
        <MessageContent message={m} sessionId={sessionId} />
      </div>
    </article>
  );
});

const MessageGroup = memo(function MessageGroup({ m, sessionId, date, showByline, live, layout, nested }: {
  m: ChatMessage; sessionId: string; date?: string; showByline: boolean; live: boolean;
  layout: ReturnType<typeof createMessageLayout>; nested?: boolean;
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
    if (row.kind === 'process') return <div key={row.key} className="msg-group"
      data-window-item-id={m.id}
      data-message-frame={nested ? undefined : row.key} data-child-message-frame={nested ? row.key : undefined}>
      {date && <div className="date-separator" aria-hidden="true">{date}</div>}
      <MessageProcess items={row.items} identity={row.key} sessionId={sessionId}
        latest={row === lastProcess} latestItemId={latestItemId} />
    </div>;
    return (
      <MessageGroup key={m.id} m={m} sessionId={sessionId}
        date={date} nested={nested}
        showByline={m.role === 'assistant' && (newDay || previous?.role !== 'assistant')}
        live={m.role === 'assistant' && m.id === liveId} layout={layout} />
    );
  });
});

interface ThreadProps {
  session: ChatSession;
  onSend?: (text: string) => Promise<boolean>;
  onRespondAsk?: (requestId: string, answer: string, wasFreeform: boolean) => Promise<boolean>;
  onRespondPlan?: (requestId: string, action: ExitPlanModeAction) => Promise<boolean>;
  onPlanSupersede?: (requestId: string, message: string) => Promise<boolean>;
  onRespondElicitation?: (requestId: string, action: 'accept' | 'decline' | 'cancel') => Promise<boolean>;
  onRemoveQueued?: (itemId: string) => void;
  onCancel?: () => void;
  onInterrupt?: () => Promise<{ ok: true; interrupted: boolean }>;
  onLoadMore: () => void;
  onRetryHistory?: () => void;
  // Read-only transcript (e.g. a trashed-session preview): renders the paginated
  // message list but hides the composer and every interactive banner, so the
  // conversation can be browsed but not driven.
  readOnly?: boolean;
}

export function Thread({ session, onSend, onRespondAsk, onRespondPlan, onPlanSupersede, onRespondElicitation, onRemoveQueued, onCancel, onInterrupt, onLoadMore, onRetryHistory, readOnly = false }: ThreadProps) {
  const connected = useCockpit((s) => s.connState === 'open');
  const interruptAction = useKeyedAction(`interrupt:${session.sessionId}`);
  const [interruptNotice, setInterruptNotice] = useState<{ sessionId: string; text: string } | null>(null);
  const canInterrupt = !!onInterrupt && session.loaded && session.status === 'running'
    && !session.loading && !session.closing && !session.cancelling && !session.compacting
    && session.nativeProcessing !== false;
  const queueCount = session.queue?.length ?? 0;
  const showStop = !readOnly && session.status === 'running' && !session.compacting && !session.ask;
  const showInterrupt = !readOnly && queueCount > 0 && canInterrupt;
  const interruptResult = readOnly ? null : interruptAction.error
    ? `打断未确认：${interruptAction.error}。请核对会话状态，不要直接重试。`
    : interruptNotice?.sessionId === session.sessionId ? interruptNotice.text : null;
  const executionLabel = session.compacting ? '正在压缩上下文…'
    : session.ask ? '等待你的回答' : session.planRequest ? '等待确认计划'
      : session.elicitation ? '等待工具确认' : session.status === 'running'
        ? session.intent || '回复中…' : queueCount > 0 ? '排队中的消息' : '执行结果';
  const draft = useMemo(() => getSessionDraft(session.sessionId), [session.sessionId]);
  const { pending: actionPending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollOwnerRef = useRef<ThreadScroll | null>(null);
  const initialFill = useRef({ sessionId: session.sessionId, done: session.materialized });
  const [readySession, setReadySession] = useState(session.materialized ? session.sessionId : null);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const visible = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  const preparingHistory = readySession !== session.sessionId && !session.error && !session.historyError && !session.historyStale;
  const [heldHead, setHeldHead] = useState<{ sessionId: string; id: string } | null>(null);
  // Keep the existing DOM prefix under an active gesture. Only newly received
  // older rows wait for settle; tail updates and already mounted history stay live.
  const messages = useMemo(() => {
    const start = heldHead?.sessionId === session.sessionId
      ? session.messages.findIndex((message) => message.id === heldHead.id) : -1;
    return start > 0 ? session.messages.slice(start) : session.messages;
  }, [heldHead, session.sessionId, session.messages]);
  const prependHeld = messages !== session.messages;
  const [newCount, setNewCount] = useState(0);
  const actionScopeRef = useRef({ active: false });
  useLayoutEffect(() => {
    const scope = { active: true };
    actionScopeRef.current = scope;
    return () => { scope.active = false; };
  }, [session.sessionId]);
  const prevLastIdRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    prevLastIdRef.current = undefined;
    const owner = observeThreadScroll(el, content, () => setNewCount(0), (active) => {
      const id = content.querySelector<HTMLElement>('[data-window-item-id]')?.getAttribute('data-window-item-id') ?? undefined;
      setHeldHead(active && id ? { sessionId: session.sessionId, id } : null);
    });
    scrollOwnerRef.current = owner.scroll;
    // A new view enters at latest; only this mounted owner retains reading anchors.
    return () => {
      owner.dispose();
      scrollOwnerRef.current = null;
    };
  }, [session.sessionId]);

  useLayoutEffect(() => {
    if (initialFill.current.sessionId !== session.sessionId) {
      initialFill.current = { sessionId: session.sessionId, done: session.materialized };
    }
    const fill = initialFill.current;
    const el = scrollRef.current;
    if (fill.done) { setReadySession(session.sessionId); return; }
    if (!connected || !pageVisible || !el || !session.materialized || session.loadingHistory || session.historyStale || session.historyError || session.error || prependHeld) return;
    // Measure hidden initial rows, then reveal the accumulated viewport in one batch.
    if (!session.hasMore || session.incompleteBoundary || el.scrollHeight >= el.clientHeight * 2) {
      fill.done = true;
      setReadySession(session.sessionId);
    } else if (el.clientHeight > 0) {
      onLoadMore();
    }
  }, [session.sessionId, session.materialized, session.loadingHistory, session.historyStale, session.historyError, session.error, session.hasMore, session.incompleteBoundary, messages, onLoadMore, prependHeld, pageVisible, connected]);

  // The scroll owner continuously remembers the visible message, not a
  // request-time scrollHeight that can include unrelated loader/media growth.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!connected || !pageVisible || !el || !content || preparingHistory || !session.materialized || !session.hasMore
      || session.loadingHistory || session.historyError || session.historyStale || session.incompleteBoundary || prependHeld) return;
    return observeHistoryPrefetch(el, content, () => !scrollOwnerRef.current?.following, onLoadMore);
  }, [session.sessionId, session.hasMore, session.materialized, session.loadingHistory, session.historyError,
    session.historyStale, session.incompleteBoundary, onLoadMore, prependHeld, preparingHistory, pageVisible, connected]);

  // Reconnect/metadata renders with identical geometry do not schedule a write.
  // Count only messages after the previous tail, never an older-page prepend.
  useLayoutEffect(() => {
    const lastId = session.messages.at(-1)?.id;
    if (!scrollOwnerRef.current?.following && prevLastIdRef.current && lastId !== prevLastIdRef.current) {
      const previousTail = session.messages.findIndex((m) => m.id === prevLastIdRef.current);
      if (previousTail >= 0) setNewCount((n) => n + session.messages.length - previousTail - 1);
    }
    prevLastIdRef.current = lastId;
    scrollOwnerRef.current?.changed();
  }, [messages, session.messages, session.status, session.compacting, session.error]);

  const jumpToBottom = useCallback(() => { scrollOwnerRef.current?.follow(); }, []);

  // Sending from THIS device: force-follow the bottom through the user-message
  // append + the stop button appearing (which shrinks the scroll viewport).
  // When the agent is waiting on an ask_user question, a freeform send answers
  // it (respondToUserInput) instead of starting a new prompt.
  // A composer send is context-sensitive: it answers a pending ask (respondToUserInput),
  // or — while a plan is pending — is taken as a NEW instruction that dismisses the
  // plan, leaves plan mode, and runs (planSupersede). Otherwise a normal prompt.
  const ask = session.ask;
  const planRequest = session.planRequest;
  const runInView = useCallback((send: () => Promise<boolean>): Promise<boolean> => (
    acknowledgeInView(actionScopeRef.current, send, {
      scrollRevision: () => scrollOwnerRef.current?.revision ?? 0,
      onAccepted: () => { scrollOwnerRef.current?.follow(); },
    })
  ), []);

  const runAction = useCallback((send: () => Promise<boolean> | undefined): Promise<boolean> => (
    runInView(() => draft.runAction(send))
  ), [draft, runInView]);

  const handleSend = useCallback((): Promise<boolean> => runInView(() => draft.send((text) => sendThreadDraft(text, {
    askRequestId: ask?.requestId,
    planRequestId: planRequest?.requestId,
    onSend,
    onRespondAsk,
    onPlanSupersede,
  }))), [draft, ask, planRequest, onSend, onRespondAsk, onPlanSupersede, runInView]);

  const handleChoice = useCallback((choice: string): Promise<boolean> => runAction(
    () => ask ? onRespondAsk?.(ask.requestId, choice, false) : undefined,
  ), [ask, onRespondAsk, runAction]);

  return (
    <DisclosureChoices key={session.sessionId}><main className="chat">
      <div className="chat-transcript">
        <div ref={scrollRef} className="chat-messages" tabIndex={0} aria-label="对话消息" aria-busy={preparingHistory}>
          <div ref={contentRef} className="chat-message-content">
            <div className="chat-history-controls">
              <div className="chat-history-actions">
                {session.loadingHistory || preparingHistory ? (
                  <div className="chat-loading-older" role="status">
                    {preparingHistory || session.historyStale || !session.materialized ? '正在同步对话历史…' : '加载更早的消息…'}
                  </div>
                ) : session.historyStale || !session.materialized ? (
                  <div className="chat-loading-older" role={session.historyError ? 'alert' : 'status'}>
                    {session.historyError ? `历史加载失败：${session.historyError}` : '对话历史尚未同步。'}
                    {onRetryHistory && <button type="button" className="dialog-btn rp" onClick={() => {
                      scrollOwnerRef.current?.follow();
                      onRetryHistory();
                    }}>
                      重新读取最新历史
                    </button>}
                  </div>
                ) : session.historyError ? <div className="chat-loading-older" role="alert">
                  历史加载失败：{session.historyError}
                  <button type="button" className="dialog-btn rp" onClick={onRetryHistory}>重试加载历史</button>
                </div> : null}
              </div>
              {session.partialHistory && <p className="chat-history-note" role="status">
                断线期间的临时片段可能不完整；已保留现有文字，以原生保存后的完整消息为准。
              </p>}
              {session.incompleteBoundary && !session.hasMore && !session.loadingHistory && <p className="chat-history-note">
                部分工具记录缺少对应的发起消息，现有历史无法补齐。
              </p>}
            </div>
            <div className="chat-message-rows" data-preparing={preparingHistory || undefined}
              aria-hidden={preparingHistory || undefined} inert={preparingHistory || undefined}>
              {session.messages.length === 0 && session.materialized && !session.historyStale && !session.loadingHistory && !session.hasMore && (
                <div className="chat-empty-hint"><Icon name="newchat" size={28} />
                  <strong>开始对话</strong><span>输入消息，或添加文件一起讨论。</span><code>{session.cwd}</code></div>
              )}
              <TranscriptMessages messages={messages} sessionId={session.sessionId}
                liveId={session.status === 'running' ? session.messages.at(-1)?.id : undefined}
                today={new Date().setHours(0, 0, 0, 0)} />

              {session.error && <p className="chat-error" role="alert">错误: {session.error}
                {onRetryHistory && session.materialized && !session.historyStale && <button type="button"
                  className="dialog-btn rp" onClick={onRetryHistory}>重试同步</button>}
              </p>}
            </div>
          </div>
        </div>

        {newCount > 0 && (
          <button className="new-msg-badge" type="button" onClick={jumpToBottom}>
            {newCount} 条新消息
          </button>
        )}
      </div>

      {!readOnly && ask && (
        <div className="chat-ask" role="group" aria-label="需要你的选择" aria-busy={actionPending}>
          <div className="chat-pending-head"><Icon name="newchat" size={16} />需要你的回答</div>
          <div className="chat-ask-q">{ask.question}</div>
          {ask.choices && ask.choices.length > 0 && (
            <div className="chat-ask-choices">
              {ask.choices.map((c) => (
                <button key={c} type="button" className="chat-ask-choice" disabled={actionPending} onClick={() => { void handleChoice(c); }}>{c}</button>
              ))}
            </div>
          )}
          <div className="chat-pending-hint" role="status">{actionPending ? '正在提交回答…' : ask.allowFreeform === false ? '请选择一个选项。' : '也可以在下方输入自己的回答。'}</div>
        </div>
      )}

      {!readOnly && session.planRequest && (
        <div className="chat-ask chat-pending chat-plan" role="group" aria-label="计划待确认" aria-busy={actionPending}>
          <div className="chat-pending-head"><Icon name="mode_plan" size={16} />计划已就绪</div>
          <div className="chat-pending-content" role="region" tabIndex={0} aria-label="计划内容">
            <div className="chat-pending-summary">
              <MessageBody body={session.planRequest.summary} />
            </div>
            {session.planRequest.planContent && (
              <details className="chat-pending-detail">
                <summary>查看完整计划</summary>
                <pre className="chat-pending-pre">{session.planRequest.planContent}</pre>
              </details>
            )}
          </div>
          <div className="chat-ask-choices">
            {(() => {
              const pr = session.planRequest!;
              // Render exactly the actions the SDK offered, in the canonical order;
              // fall back to the legacy three if the event carried none. The
              // recommended action is emphasized.
              const offered = pr.actions && pr.actions.length > 0
                ? PLAN_ACTION_ORDER.filter((a) => pr.actions!.includes(a))
                : (['interactive', 'autopilot', 'exit_only'] as ExitPlanModeAction[]);
              return offered.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`chat-ask-choice${a === pr.recommendedAction ? ' is-recommended' : ''}`}
                  disabled={actionPending}
                  onClick={() => { void runAction(() => onRespondPlan?.(pr.requestId, a)); }}
                >
                  {PLAN_ACTION_LABEL[a]}
                </button>
              ));
            })()}
          </div>
          <div className="chat-pending-hint" role="status">{actionPending ? '正在提交选择…' : '或在下方直接输入新指令，我先照做再回到计划'}</div>
        </div>
      )}

      {!readOnly && session.elicitation && (
        <div className="chat-ask chat-pending" role="group" aria-label="需要你的输入" aria-busy={actionPending}>
          <div className="chat-pending-head"><Icon name="mcp" size={16} />工具请求确认</div>
          <div className="chat-ask-q">{session.elicitation.message}</div>
          <div className="chat-ask-choices">
            {(session.elicitation.actions ?? ['accept', 'decline', 'cancel']).map(action => (
              <button key={action} type="button" className="chat-ask-choice" disabled={actionPending}
                onClick={() => { void runAction(() => onRespondElicitation?.(session.elicitation!.requestId, action)); }}>
                {{ accept: '同意', decline: '拒绝', cancel: '取消' }[action]}
              </button>
            ))}
          </div>
          {actionPending && <div className="chat-pending-hint" role="status">正在提交选择…</div>}
        </div>
      )}

      {(session.compacting || session.status === 'running' || (!readOnly && (queueCount > 0 || interruptResult))) && (
        <section className="chat-execution" aria-label="执行与排队">
          <div className="chat-execution-head">
            <span className="chat-execution-label" role="status" title={executionLabel}>{executionLabel}</span>
            {(showStop || showInterrupt) && <div className="chat-execution-actions" role="group" aria-label="执行操作">
              {showInterrupt && <button type="button" className="chat-interrupt"
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
                }}>{interruptAction.busy ? '正在请求…' : '打断并继续'}</button>}
              {showStop && <button type="button" className="chat-typing-stop" disabled={session.cancelling || !onCancel} onClick={() => onCancel?.()}>
                {session.cancelling ? '正在停止…' : queueCount > 0 ? '停止并清空队列' : '停止'}
              </button>}
            </div>}
          </div>
          {interruptResult && <p className="chat-interrupt-status" tabIndex={0} aria-label="打断结果" role={interruptAction.error ? 'alert' : 'status'}>
            {interruptResult}
          </p>}
          {!readOnly && queueCount > 0 && <>
            <div className="chat-queue-label">排队消息 · {queueCount}</div>
            <div className="chat-queue" aria-label="排队中的消息">
              {session.queue?.map((q) => (
                <div key={q.id} className="chat-queue-item">
                  <span className="chat-queue-text" title={q.text}>{q.text}</span>
                  <button type="button" className="chat-queue-remove" aria-label={`移除排队消息：${q.text}`} onClick={() => onRemoveQueued?.(q.id)}><Icon name="close" size={16} /></button>
                </div>
              ))}
            </div>
          </>}
        </section>
      )}

      {readOnly ? (
        <div className="chat-readonly-note" aria-label="只读会话">已删除的会话 · 只读</div>
      ) : (
        <Composer
          key={session.sessionId}
          busy={session.status === 'running' && !ask}
          disabled={!!session.compacting && session.status !== 'running'}
          placeholder={(session.compacting && session.status !== 'running') ? '正在压缩…' : (ask ? (ask.allowFreeform === false ? '请选择上方选项' : '输入回答…') : (planRequest ? '输入新指令…' : '输入消息…'))}
          draft={draft}
          onSend={handleSend}
          sendBlocked={ask?.allowFreeform === false}
        />
      )}
    </main></DisclosureChoices>
  );
}
