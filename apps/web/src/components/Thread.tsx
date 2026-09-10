// Chat window (detail pane). Reading position and explicit bottom-follow are
// maintained by one scroll owner; message bodies reuse the markdown renderer.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MessageBody } from './MessageBody';
import { MessageContent } from './MessageContent';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { ContextMenu, type MenuItem } from './ContextMenu';
import type { ChatMessage, ChatSession, ToolCall, Attachment, ExitPlanModeAction } from '../net/types';
import { acknowledgeInView, sendThreadDraft } from '../lib/draft';
import { getSessionDraft, type UploadFile } from '../lib/attachmentSend';
import { observeThreadScroll, type ThreadScroll, type ReadingPosition } from './threadScroll';
import { canSkipMessageLayout, createMessageLayout } from './messageLayout';
import { useCockpit } from '../net/store';
import { createSubagentHistory } from '../lib/subagentHistory';
import { useKeyedAction } from '../lib/useKeyedResource';

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
const readingPositions = new Map<string, ReadingPosition>();

// Tool-call status → icon + tone. Static glyphs (no spinner) per the zero-
// animation doctrine; color carries the state.
function ToolStatusIcon({ status }: { status: ToolCall['status'] }) {
  switch (status) {
    case 'completed': return <span className="tool-ico"><Icon name="check" size={15} /></span>;
    case 'failed': return <span className="tool-ico"><Icon name="error" size={16} /></span>;
    case 'in_progress': return <span className="tool-ico"><Icon name="radiooff" size={14} /></span>;
    default: return <span className="tool-ico"><Icon name="radiooff" size={14} /></span>;
  }
}

function ToolCallRow({ tc }: { tc: ToolCall; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(tc.args || tc.output);
  return (
    <div className="msg-tool" data-status={tc.status ?? 'pending'}>
      <div className="tool-head">
        <ToolStatusIcon status={tc.status} />
        <span className="tool-title">{tc.title}</span>
        {tc.name && <span className="tool-name">{tc.name}</span>}
        {hasDetail && (
          <button type="button" className="tool-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={open ? '收起细节' : '展开细节'}>
            <Icon name={open ? 'up' : 'down'} size={14} />
          </button>
        )}
      </div>
      {hasDetail && open && (
        <div className="tool-detail">
          {tc.args && <pre className="tool-args">{tc.args}</pre>}
          {tc.output && <pre className="tool-output">{tc.output}</pre>}
        </div>
      )}
    </div>
  );
}

// Reasoning/thinking block. While live (turn streaming) it's expanded so you can
// watch it think (CLI ctrl+t); once the turn ends it auto-collapses to a quiet
// toggle the user can re-open.
function Thought({ text, live }: { text: string; live: boolean }) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? live;
  return (
    <div className="msg-thought-block" data-live={live ? 'true' : 'false'}>
      <button type="button" className="thought-toggle" onClick={() => setOpenOverride(!open)} aria-expanded={open}>
        <Icon name={open ? 'up' : 'down'} size={13} />
        <span>{live ? '正在思考…' : '思考过程'}</span>
      </button>
      {open && <div className="msg-thought">{text}</div>}
    </div>
  );
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

// Renders the inner content of an assistant message (thought + tools + body).
// Shared by top-level assistant messages and the nested messages inside a
// sub-agent card.
function MessageInner({ m, sessionId }: { m: ChatMessage; sessionId: string }) {
  return (
    <>
      {m.thought && <Thought text={m.thought} live={false} />}
      {m.toolCalls && m.toolCalls.length > 0 && (
        <div className="msg-tools">
          {m.toolCalls.map((tc) => <ToolCallRow key={JSON.stringify([sessionId, m.id, tc.toolCallId])} tc={tc} sessionId={sessionId} />)}
        </div>
      )}
      <MessageContent message={m} sessionId={sessionId} />
      {m.subtype === 'subagent' && m.subagent && <SubagentCard key={m.subagent.toolCallId ?? m.id} m={m} sessionId={sessionId} />}
    </>
  );
}

// A sub-agent (spawned via the `task` tool) as one collapsible card. The header
// shows the agent + status; expanding reveals its full inner work (tools,
// thinking, messages) — the same rendering as the main thread, nested.
function SubagentCard({ m, sessionId }: { m: ChatMessage; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const sa = m.subagent!;
  return (
    <div className="subagent-card">
      <button type="button" className="subagent-head rp" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="subagent-ico" aria-hidden="true">🤖</span>
        <span className="subagent-name">{sa.displayName}</span>
        <span className="subagent-chevron"><Icon name={open ? 'up' : 'down'} size={14} /></span>
      </button>
      {sa.description && !open && <div className="subagent-desc">{sa.description}</div>}
      {open && <SubagentDetails key={JSON.stringify([sessionId, sa.toolCallId])} m={m} sessionId={sessionId} />}
    </div>
  );
}

function SubagentDetails({ m, sessionId }: { m: ChatMessage; sessionId: string }) {
  const summary = m.subagent!;
  const read = useCockpit((s) => s.chat);
  const connected = useCockpit((s) => s.connState === 'open');
  const generation = useCockpit((s) => s.connectionGeneration);
  const toolCallId = summary.toolCallId;
  const agentId = summary.agentId;
  const resource = useMemo(() => createSubagentHistory(
    sessionId, { agentId, toolCallId }, read, useCockpit.getState,
  ), [sessionId, toolCallId, agentId, read]);
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useLayoutEffect(() => () => resource.deactivate(true), [resource]);
  useLayoutEffect(() => {
    if (connected && toolCallId) resource.activate();
    return () => resource.deactivate();
  }, [resource, connected, generation, toolCallId]);
  useEffect(() => {
    if (connected && toolCallId) void resource.refresh();
  }, [resource, connected, generation, toolCallId]);
  const sa = summary;
  const sub = snapshot.data?.messages ?? m.subMessages ?? [];
  const pending = snapshot.pending || (connected && !!toolCallId && !snapshot.data && !snapshot.error);
  return (
    <div className="subagent-body" aria-busy={pending}>
      {sa.prompt && (
        <div className="subagent-prompt">
          <div className="subagent-prompt-label">任务</div>
          <MessageBody body={sa.prompt} />
        </div>
      )}
      {sa.error && <div className="subagent-error">{sa.error}</div>}
      {!connected && toolCallId && <div role="status">等待连接…</div>}
      {pending && <div role="status">正在读取子代理历史…</div>}
      {snapshot.error && <div className="subagent-error" role="alert">
        加载失败：{snapshot.error}
        <button type="button" disabled={!connected || pending} onClick={() => { void resource.retry(); }}>重试</button>
      </div>}
      {snapshot.data?.hasMore && <button type="button" disabled={!connected || pending} onClick={() => { void resource.loadOlder(); }}>
        加载更早的消息
      </button>}
      {snapshot.data?.incompleteBoundary && !pending && <div className="subagent-empty">{snapshot.data.hasMore
        ? '本次尚未读到完整消息边界，可继续加载更早的消息。'
        : '部分工具记录缺少对应的发起消息，现有历史无法补齐。'}</div>}
      {sub.map((sm) => (
        <article key={sm.id} className="message is-doc subagent-msg">
          <MessageInner m={sm} sessionId={sessionId} />
        </article>
      ))}
      {toolCallId && <button type="button" disabled={!connected || pending} onClick={() => { void resource.refresh(); }}>刷新子代理历史</button>}
      <div className="subagent-empty">按需读取原生已保存的事件；生成中的消息可在保存后手动刷新。</div>
      {!pending && !snapshot.error && !sub.length && <div className="subagent-empty">
        {toolCallId ? '暂无已保存的子代理消息。' : '此历史记录未提供子代理读取标识。'}
      </div>}
    </div>
  );
}

// One rendered message. Per @waksana's doctrine:
//  - user messages are right-aligned bubbles (accent), time inside, no label;
//  - assistant replies are NOT bubbles — they read as a full-width document,
//    with a light byline (icon + Copilot + time) shown once per assistant group;
//  - system messages are a quiet centered note.
const MessageRow = memo(function MessageRow({ m, sessionId, showByline, thinkingLive, onMenu }: { m: ChatMessage; sessionId: string; showByline: boolean; thinkingLive: boolean; onMenu: (e: React.MouseEvent, m: ChatMessage) => void }) {
  const hasAttachment = m.parts ? m.parts.some(part => part.type === 'file') : !!(m.attachments?.length || m.attachment);
  if (m.subtype === 'subagent' && m.subagent) {
    return <div className="message is-doc" data-message-id={m.id} onContextMenu={(e) => onMenu(e, m)}><SubagentCard key={m.subagent.toolCallId ?? m.id} m={m} sessionId={sessionId} /></div>;
  }
  if (m.role === 'user') {
    const isAskReply = m.subtype === 'ask-reply';
    const cls = ['message', 'is-out'];
    if (isAskReply) cls.push('is-ask-reply');
    if (hasAttachment) cls.push('is-attachment');
    return (
      <div className={cls.join(' ')} data-message-id={m.id} onContextMenu={(e) => onMenu(e, m)}>
        {isAskReply && <span className="ask-reply-tag" aria-label="对提问的回复">↩ 回复</span>}
        <MessageContent message={m} sessionId={sessionId} />
        <span className="message-time">{clock(m.timestamp)}</span>
      </div>
    );
  }
  if (m.role === 'system') {
    if (m.subtype === 'skill') {
      return (
        <div className="message is-skill" data-message-id={m.id} onContextMenu={(e) => onMenu(e, m)}>
          <span className="skill-ico" aria-hidden="true"><Icon name="skills" size={14} /></span>
          <span className="skill-label">skill</span>
          <span className="skill-name">{m.parts ? <MessageContent message={m} sessionId={sessionId} /> : m.content}</span>
        </div>
      );
    }
    const level = m.level ?? 'info';
    return (
      <div className="message is-system" data-message-id={m.id} data-level={level} onContextMenu={(e) => onMenu(e, m)}>
        {level === 'error' && <span className="sys-ico" aria-hidden="true"><Icon name="error" size={14} /></span>}
        {m.parts || hasAttachment ? <MessageContent message={m} sessionId={sessionId} /> : m.content}
      </div>
    );
  }
  return (
    <article className={`message is-doc${hasAttachment ? ' is-attachment' : ''}`} onContextMenu={(e) => onMenu(e, m)}>
      {showByline && (
        <header className="doc-byline">
          <span className="doc-mark" aria-hidden="true"><Icon name="compose" size={15} /></span>
          <span className="doc-time">{clock(m.timestamp)}</span>
        </header>
      )}
      {/* Date/byline removal on prepend must not move the reading anchor. */}
      <div data-message-id={m.id}>
        {m.thought && <Thought text={m.thought} live={thinkingLive} />}
        {m.toolCalls && m.toolCalls.length > 0 && (
          <div className="msg-tools">
            {m.toolCalls.map((tc) => <ToolCallRow key={JSON.stringify([sessionId, m.id, tc.toolCallId])} tc={tc} sessionId={sessionId} />)}
          </div>
        )}
        <MessageContent message={m} sessionId={sessionId} />
      </div>
    </article>
  );
});

type MessageMenu = (event: React.MouseEvent, message: ChatMessage) => void;

const MessageGroup = memo(function MessageGroup({ m, sessionId, date, showByline, live, layout, onMenu }: {
  m: ChatMessage; sessionId: string; date?: string; showByline: boolean; live: boolean;
  layout: ReturnType<typeof createMessageLayout>; onMenu: MessageMenu;
}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const skippable = canSkipMessageLayout(m, live);
  useLayoutEffect(() => {
    if (skippable && frame.current) return layout.observe(frame.current);
  }, [layout, skippable, m, date, showByline]);
  return (
    <div ref={frame} className="msg-group" data-message-frame={m.id}>
      {date && <div className="date-separator" aria-hidden="true">{date}</div>}
      <MessageRow m={m} sessionId={sessionId} showByline={showByline} thinkingLive={live} onMenu={onMenu} />
    </div>
  );
});

const TranscriptMessages = memo(function TranscriptMessages({ messages, sessionId, liveId, today, onMenu }: {
  messages: ChatMessage[]; sessionId: string; liveId?: string; today: number; onMenu: MessageMenu;
}) {
  const layout = useMemo(() => createMessageLayout(), []);
  useLayoutEffect(() => () => layout.dispose(), [layout]);
  return messages.map((m, i) => {
    const previous = messages[i - 1];
    const newDay = !previous || !sameDay(previous.timestamp, m.timestamp);
    return (
      <MessageGroup key={m.id} m={m} sessionId={sessionId}
        date={newDay ? dateLabel(m.timestamp, today) : undefined}
        showByline={m.role === 'assistant' && (newDay || previous.role !== 'assistant')}
        live={m.role === 'assistant' && m.id === liveId} layout={layout} onMenu={onMenu} />
    );
  });
});

interface ThreadProps {
  session: ChatSession;
  onSend?: (text: string, attachment?: Attachment, attachments?: Attachment[]) => Promise<boolean>;
  uploadFile?: UploadFile;
  onRespondAsk?: (requestId: string, answer: string, wasFreeform: boolean) => Promise<boolean>;
  onRespondPlan?: (requestId: string, action: ExitPlanModeAction) => Promise<boolean>;
  onPlanSupersede?: (requestId: string, message: string) => Promise<boolean>;
  onRespondElicitation?: (requestId: string, action: 'accept' | 'decline' | 'cancel') => Promise<boolean>;
  onRemoveQueued?: (itemId: string) => void;
  onCancel?: () => void;
  onInterrupt?: () => Promise<{ ok: true; interrupted: boolean }>;
  onLoadMore: () => void;
  onRetryHistory?: () => void;
  onAttentionVisible?: (attnId: number, visible: boolean) => void;
  // Read-only transcript (e.g. a trashed-session preview): renders the paginated
  // message list but hides the composer and every interactive banner, so the
  // conversation can be browsed but not driven.
  readOnly?: boolean;
}

export function Thread({ session, onSend, uploadFile, onRespondAsk, onRespondPlan, onPlanSupersede, onRespondElicitation, onRemoveQueued, onCancel, onInterrupt, onLoadMore, onRetryHistory, onAttentionVisible, readOnly = false }: ThreadProps) {
  const interruptAction = useKeyedAction(`interrupt:${session.sessionId}`);
  const [interruptNotice, setInterruptNotice] = useState<{ sessionId: string; text: string } | null>(null);
  const canInterrupt = !!onInterrupt && session.loaded && session.status === 'running'
    && !session.loading && !session.closing && !session.cancelling && !session.compacting
    && session.nativeProcessing !== false;
  const draft = useMemo(() => getSessionDraft(session.sessionId), [session.sessionId]);
  const { pending: actionPending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollOwnerRef = useRef<ThreadScroll | null>(null);
  const initialFill = useRef({ sessionId: session.sessionId, done: session.materialized });
  const [readySession, setReadySession] = useState(session.materialized ? session.sessionId : null);
  const preparingHistory = readySession !== session.sessionId && !session.error && !session.historyStale;
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
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const openMsgMenu = useCallback((e: React.MouseEvent, m: ChatMessage) => {
    if (!m.content) return;
    e.preventDefault();
    setMsgMenu({
      x: e.clientX, y: e.clientY,
      items: [{ label: '复制', icon: 'compose', onClick: () => { void navigator.clipboard?.writeText(m.content).catch(() => {}); } }],
    });
  }, []);
  const prevLastIdRef = useRef<string | undefined>(undefined);
  const reportVisibleAttention = useCallback(() => {
    const el = scrollRef.current;
    const choiceVisible = session.attention === 'choice' && !!(session.ask || session.planRequest || session.elicitation);
    const latestVisible = !preparingHistory && session.materialized && !session.historyStale && session.messages.length > 0
      && !!el && el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
    onAttentionVisible?.(session.attnId ?? 0, !readOnly && (choiceVisible || latestVisible));
  }, [onAttentionVisible, readOnly, session.attention, session.attnId, session.ask, session.planRequest,
    session.elicitation, session.materialized, session.historyStale, session.messages.length, preparingHistory]);
  useLayoutEffect(reportVisibleAttention, [reportVisibleAttention, session.messages]);
  useEffect(() => {
    const el = scrollRef.current;
    el?.addEventListener('scroll', reportVisibleAttention, { passive: true });
    document.addEventListener('visibilitychange', reportVisibleAttention);
    window.addEventListener('focus', reportVisibleAttention);
    reportVisibleAttention();
    return () => {
      el?.removeEventListener('scroll', reportVisibleAttention);
      document.removeEventListener('visibilitychange', reportVisibleAttention);
      window.removeEventListener('focus', reportVisibleAttention);
      onAttentionVisible?.(session.attnId ?? 0, false);
    };
  }, [reportVisibleAttention, onAttentionVisible, session.attnId]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    prevLastIdRef.current = undefined;
    const owner = observeThreadScroll(el, content, () => setNewCount(0), (active) => {
      const id = content.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId;
      setHeldHead(active && id ? { sessionId: session.sessionId, id } : null);
    });
    scrollOwnerRef.current = owner.scroll;
    const saved = readingPositions.get(session.sessionId);
    if (saved) owner.scroll.restore(saved);
    return () => {
      readingPositions.set(session.sessionId, owner.scroll.position());
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
    if (!el || !session.materialized || session.loadingHistory || session.historyStale || session.error || prependHeld) return;
    // Measure hidden initial rows, then reveal the accumulated viewport in one batch.
    if (!session.hasMore || session.incompleteBoundary || el.scrollHeight >= el.clientHeight * 2) {
      fill.done = true;
      setReadySession(session.sessionId);
    } else if (el.clientHeight > 0) {
      onLoadMore();
    }
  }, [session.sessionId, session.materialized, session.loadingHistory, session.historyStale, session.error, session.hasMore, session.incompleteBoundary, messages, onLoadMore, prependHeld]);

  // The scroll owner continuously remembers the visible message, not a
  // request-time scrollHeight that can include unrelated loader/media growth.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!preparingHistory && el.scrollTop < 80 && session.hasMore && !session.loadingHistory && !prependHeld) {
        onLoadMore();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [session.hasMore, session.loadingHistory, onLoadMore, prependHeld, preparingHistory]);

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

  const handleSend = useCallback((): Promise<boolean> => runInView(() => draft.send((text, attachment, attachments) => sendThreadDraft(text, {
    askRequestId: ask?.requestId,
    planRequestId: planRequest?.requestId,
    onSend,
    onRespondAsk,
    onPlanSupersede,
  }, attachment, attachments))), [draft, ask, planRequest, onSend, onRespondAsk, onPlanSupersede, runInView]);

  const handleChoice = useCallback((choice: string): Promise<boolean> => runAction(
    () => ask ? onRespondAsk?.(ask.requestId, choice, false) : undefined,
  ), [ask, onRespondAsk, runAction]);

  return (
    <main className="chat">
      <div className="chat-transcript">
        <div className="chat-history-controls">
          <div className="chat-history-actions">
            {session.loadingHistory || preparingHistory ? (
              <div className="chat-loading-older" role="status">
                {preparingHistory || session.historyStale || !session.materialized ? '正在同步对话历史…' : '加载更早的消息…'}
              </div>
            ) : session.historyStale || !session.materialized ? (
              <div className="chat-loading-older" role="status">
                对话历史尚未同步。
                {onRetryHistory && <button type="button" className="dialog-btn rp" onClick={() => {
                  scrollOwnerRef.current?.follow();
                  onRetryHistory();
                }}>
                  重新读取最新历史
                </button>}
              </div>
            ) : session.hasMore ? <button type="button" className="dialog-btn rp"
              disabled={prependHeld} onClick={onLoadMore}>加载更早的历史</button> : null}
          </div>
          {session.partialHistory && <p className="chat-history-note" role="status">
            断线期间的临时片段可能不完整；已保留现有文字，以原生保存后的完整消息为准。
          </p>}
          {session.incompleteBoundary && !session.loadingHistory && <p className="chat-history-note">{session.hasMore
            ? '本次尚未读到完整消息边界，可点击加载更早的历史继续补齐。'
            : '部分工具记录缺少对应的发起消息，现有历史无法补齐。'}</p>}
        </div>
        <div ref={scrollRef} className="chat-messages" tabIndex={0} aria-busy={preparingHistory}>
          <div ref={contentRef} className="chat-message-content" data-preparing={preparingHistory || undefined}
            aria-hidden={preparingHistory || undefined} inert={preparingHistory || undefined}>
            {session.messages.length === 0 && session.materialized && !session.historyStale && !session.loadingHistory && !session.hasMore && (
              <p className="chat-empty-hint">开始对话吧 — 工作目录 {session.cwd}</p>
            )}
            <TranscriptMessages messages={messages} sessionId={session.sessionId}
              liveId={session.status === 'running' ? session.messages.at(-1)?.id : undefined}
              today={new Date().setHours(0, 0, 0, 0)} onMenu={openMsgMenu} />

            {session.compacting && (
              <div className="chat-typing" aria-live="polite">正在压缩上下文…</div>
            )}
            {session.status === 'running' && !session.compacting && !ask && (
              <div className="chat-typing" aria-live="polite">
                {session.intent || '回复中…'}
                <button type="button" className="chat-typing-stop" onClick={() => onCancel?.()}>
                  {(session.queue?.length ?? 0) > 0 ? '停止并清空队列' : '停止'}
                </button>
              </div>
            )}
            {session.error && <p className="chat-error">错误: {session.error}
              {onRetryHistory && session.materialized && !session.historyStale && <button type="button"
                className="dialog-btn rp" onClick={onRetryHistory}>重试同步</button>}
            </p>}
          </div>
        </div>

        {newCount > 0 && (
          <button className="new-msg-badge" type="button" onClick={jumpToBottom}>
            {newCount} 条新消息
          </button>
        )}
      </div>

      {!readOnly && ask && (
        <div className="chat-ask" role="group" aria-label="需要你的选择">
          <div className="chat-ask-q">{ask.question}</div>
          {ask.choices && ask.choices.length > 0 && (
            <div className="chat-ask-choices">
              {ask.choices.map((c) => (
                <button key={c} type="button" className="chat-ask-choice" disabled={actionPending} onClick={() => { void handleChoice(c); }}>{c}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {!readOnly && session.planRequest && (
        <div className="chat-ask chat-pending" role="group" aria-label="计划待确认">
          <div className="chat-pending-head">计划已就绪</div>
          <div className="chat-pending-summary">
            <MessageBody body={session.planRequest.summary} />
          </div>
          {session.planRequest.planContent && (
            <details className="chat-pending-detail">
              <summary>查看完整计划</summary>
              <pre className="chat-pending-pre">{session.planRequest.planContent}</pre>
            </details>
          )}
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
          <div className="chat-pending-hint">或在下方直接输入新指令，我先照做再回到计划</div>
        </div>
      )}

      {!readOnly && session.elicitation && (
        <div className="chat-ask chat-pending" role="group" aria-label="需要你的输入">
          <div className="chat-ask-q">{session.elicitation.message}</div>
          <div className="chat-ask-choices">
            {(session.elicitation.actions ?? ['accept', 'decline', 'cancel']).map(action => (
              <button key={action} type="button" className="chat-ask-choice" disabled={actionPending}
                onClick={() => { void runAction(() => onRespondElicitation?.(session.elicitation!.requestId, action)); }}>
                {{ accept: '同意', decline: '拒绝', cancel: '取消' }[action]}
              </button>
            ))}
          </div>
        </div>
      )}

      {!readOnly && (session.queue?.length ?? 0) > 0 && (
        <div className="chat-queue" aria-label="排队中的消息">
          {canInterrupt && (
            <div className="chat-queue-action">
              <button type="button" disabled={!interruptAction.connected || (!!session.activeOperations && !interruptAction.busy)}
                aria-disabled={interruptAction.busy || undefined}
                aria-describedby={`interrupt-help-${session.sessionId}`}
                onClick={() => {
                  let interrupted = false;
                  void interruptAction.run(async () => {
                    const result = await onInterrupt!();
                    interrupted = result.interrupted;
                  }, () => setInterruptNotice({ sessionId: session.sessionId, text: interrupted
                    ? '已请求打断；队列由 Copilot 接着处理。'
                    : '当前没有可打断的主回合；队列未改动。' }));
                }}>{interruptAction.busy ? '正在请求…' : '打断并继续'}</button>
              <span id={`interrupt-help-${session.sessionId}`}>只打断主回合，保留队列；后台任务继续，可能延后处理。</span>
            </div>
          )}
          {session.queue?.map((q) => (
            <div key={q.id} className="chat-queue-item">
              <span className="chat-queue-text">{q.text}</span>
              <button type="button" className="chat-queue-remove" aria-label="移除" onClick={() => onRemoveQueued?.(q.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      {!readOnly && (interruptAction.error || interruptNotice?.sessionId === session.sessionId) && (
        <p className="chat-interrupt-status" role={interruptAction.error ? 'alert' : 'status'}>
          {interruptAction.error ? `打断未确认：${interruptAction.error}。请核对会话状态，不要直接重试。` : interruptNotice?.text}
        </p>
      )}

      {readOnly ? (
        <div className="chat-readonly-note" aria-label="只读会话">已删除的会话 · 只读</div>
      ) : (
        <Composer
          key={session.sessionId}
          busy={session.status === 'running' && !ask}
          disabled={!!session.compacting && session.status !== 'running'}
          placeholder={(session.compacting && session.status !== 'running') ? '正在压缩上下文，请稍候…' : (ask ? (ask.allowFreeform ? '选择上方选项，或输入你的回答…' : '选择上方一个选项…') : (planRequest ? '选择上方操作，或直接输入新指令让我照做…' : '输入消息…'))}
          draft={draft}
          onSend={handleSend}
          uploadFile={uploadFile}
          attachmentBlocked={!!ask || !!planRequest}
        />
      )}
      {msgMenu && (
        <ContextMenu x={msgMenu.x} y={msgMenu.y} items={msgMenu.items} onClose={() => setMsgMenu(null)} />
      )}
    </main>
  );
}
