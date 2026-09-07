// Chat window (detail pane). Faithfully ports evo-chat's best-tuned mechanics:
//  - instant pin-to-bottom on session switch / first paint / keyboard rise
//  - instant pin on new-message append only when already near bottom
//  - "↓ N new" badge when scrolled up and messages arrive
//  - touchmove on the list blurs the textarea (mobile keyboard dismiss)
// Message bodies reuse evo-chat's markdown renderer + Solarized bubble CSS.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageBody } from './MessageBody';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { ContextMenu, type MenuItem } from './ContextMenu';
import type { ChatMessage, ChatSession, ToolCall, Attachment, ExitPlanModeAction } from '../net/types';
import { BASE_URL } from '../lib/config';

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

function humanSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let n = bytes; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

// TG-style attachment: an image renders inline (tap to open full); any other file
// renders as a document card (icon + name + size). Served from /uploads/* via the
// backend; clicking opens the file in a new tab.
function AttachmentView({ att }: { att: Attachment }) {
  const href = `${BASE_URL}${att.url}`;
  if (att.kind === 'image') {
    return (
      <a className="attach-image" href={href} target="_blank" rel="noreferrer">
        <img src={href} alt={att.name} loading="lazy" />
      </a>
    );
  }
  return (
    <a className="attach-file" href={href} download={att.name} title={`下载 ${att.name}`}>
      <span className="attach-file-ico"><Icon name="file" size={22} /></span>
      <span className="attach-file-meta">
        <span className="attach-file-name">{att.name}</span>
        {att.size ? <span className="attach-file-size">{humanSize(att.size)}</span> : null}
      </span>
      <span className="attach-file-dl" aria-hidden="true"><Icon name="arrow_down" size={18} /></span>
    </a>
  );
}

function ToolCallRow({ tc }: { tc: ToolCall }) {
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
function dateLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
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
function MessageInner({ m }: { m: ChatMessage }) {
  return (
    <>
      {m.thought && <Thought text={m.thought} live={false} />}
      {m.toolCalls && m.toolCalls.length > 0 && (
        <div className="msg-tools">
          {m.toolCalls.map((tc) => <ToolCallRow key={tc.toolCallId} tc={tc} />)}
        </div>
      )}
      {m.content && <MessageBody body={m.content} />}
      {m.subtype === 'subagent' && m.subagent && <SubagentCard m={m} />}
    </>
  );
}

// A sub-agent (spawned via the `task` tool) as one collapsible card. The header
// shows the agent + status; expanding reveals its full inner work (tools,
// thinking, messages) — the same rendering as the main thread, nested.
function SubagentCard({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const sa = m.subagent!;
  const sub = m.subMessages ?? [];
  const toolCount = sa.toolCount ?? sub.reduce((n, x) => n + (x.toolCalls?.length ?? 0), 0);
  const statusLabel = sa.status === 'running' ? '运行中…'
    : sa.status === 'failed' ? '失败' : `完成 · ${toolCount} 个工具`;
  return (
    <div className="subagent-card" data-status={sa.status}>
      <button type="button" className="subagent-head rp" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="subagent-ico" aria-hidden="true">🤖</span>
        <span className="subagent-name">{sa.displayName}</span>
        <span className="subagent-status">{statusLabel}</span>
        <span className="subagent-chevron"><Icon name={open ? 'up' : 'down'} size={14} /></span>
      </button>
      {sa.description && !open && <div className="subagent-desc">{sa.description}</div>}
      {open && (
        <div className="subagent-body">
          {sa.prompt && (
            <div className="subagent-prompt">
              <div className="subagent-prompt-label">任务</div>
              <MessageBody body={sa.prompt} />
            </div>
          )}
          {sa.error && <div className="subagent-error">{sa.error}</div>}
          {sub.map((sm) => (
            <article key={sm.id} className="message is-doc subagent-msg">
              <MessageInner m={sm} />
            </article>
          ))}
          {sub.length === 0 && sa.status === 'running' && <div className="subagent-empty">子代理正在工作…</div>}
        </div>
      )}
    </div>
  );
}

// One rendered message. Per @waksana's doctrine:
//  - user messages are right-aligned bubbles (accent), time inside, no label;
//  - assistant replies are NOT bubbles — they read as a full-width document,
//    with a light byline (icon + Copilot + time) shown once per assistant group;
//  - system messages are a quiet centered note.
const MessageRow = memo(function MessageRow({ m, showByline, thinkingLive, onMenu }: { m: ChatMessage; showByline: boolean; thinkingLive: boolean; onMenu: (e: React.MouseEvent, m: ChatMessage) => void }) {
  if (m.subtype === 'subagent' && m.subagent) {
    return <div className="message is-doc" onContextMenu={(e) => onMenu(e, m)}><SubagentCard m={m} /></div>;
  }
  if (m.role === 'user') {
    const isAskReply = m.subtype === 'ask-reply';
    const cls = ['message', 'is-out'];
    if (isAskReply) cls.push('is-ask-reply');
    if (m.attachment) cls.push('is-attachment');
    return (
      <div className={cls.join(' ')} onContextMenu={(e) => onMenu(e, m)}>
        {isAskReply && <span className="ask-reply-tag" aria-label="对提问的回复">↩ 回复</span>}
        {m.attachment && <AttachmentView att={m.attachment} />}
        {m.content && <MessageBody body={m.content} />}
        <span className="message-time">{clock(m.timestamp)}</span>
      </div>
    );
  }
  if (m.role === 'system') {
    if (m.subtype === 'skill') {
      return (
        <div className="message is-skill" onContextMenu={(e) => onMenu(e, m)}>
          <span className="skill-ico" aria-hidden="true"><Icon name="skills" size={14} /></span>
          <span className="skill-label">skill</span>
          <span className="skill-name">{m.content}</span>
        </div>
      );
    }
    const level = m.level ?? 'info';
    return (
      <div className="message is-system" data-level={level} onContextMenu={(e) => onMenu(e, m)}>
        {level === 'error' && <span className="sys-ico" aria-hidden="true"><Icon name="error" size={14} /></span>}
        {m.content}
      </div>
    );
  }
  return (
    <article className={`message is-doc${m.attachment ? ' is-attachment' : ''}`} onContextMenu={(e) => onMenu(e, m)}>
      {showByline && (
        <header className="doc-byline">
          <span className="doc-mark" aria-hidden="true"><Icon name="compose" size={15} /></span>
          <span className="doc-time">{clock(m.timestamp)}</span>
        </header>
      )}
      {m.thought && <Thought text={m.thought} live={thinkingLive} />}
      {m.toolCalls && m.toolCalls.length > 0 && (
        <div className="msg-tools">
          {m.toolCalls.map((tc) => <ToolCallRow key={tc.toolCallId} tc={tc} />)}
        </div>
      )}
      {m.content && <MessageBody body={m.content} />}
      {m.attachment && <AttachmentView att={m.attachment} />}
    </article>
  );
});

interface ThreadProps {
  session: ChatSession;
  initialDraft?: string;
  onPersistDraft?: (text: string) => void;
  onSend?: (text: string) => boolean;
  onRespondAsk?: (requestId: string, answer: string, wasFreeform: boolean) => void;
  onRespondPlan?: (requestId: string, action: ExitPlanModeAction) => void;
  onPlanSupersede?: (requestId: string, message: string) => void;
  onRespondElicitation?: (requestId: string, action: 'accept' | 'decline' | 'cancel') => void;
  onRemoveQueued?: (itemId: string) => void;
  onCancel?: () => void;
  onLoadMore: () => void;
  onAttach?: (file: File) => Promise<void>;
  // Read-only transcript (e.g. a trashed-session preview): renders the paginated
  // message list but hides the composer and every interactive banner, so the
  // conversation can be browsed but not driven.
  readOnly?: boolean;
}

export function Thread({ session, initialDraft, onPersistDraft, onSend, onRespondAsk, onRespondPlan, onPlanSupersede, onRespondElicitation, onRemoveQueued, onCancel, onLoadMore, onAttach, readOnly = false }: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  // True from the moment THIS device sends until the turn ends — while set we
  // force-follow the bottom so the just-sent message + the appearing stop button
  // (which shrinks the scroll viewport) never strand the latest message out of
  // view. Cleared if the user deliberately scrolls up.
  const justSentRef = useRef(false);
  const [newCount, setNewCount] = useState(0);
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const openMsgMenu = useCallback((e: React.MouseEvent, m: ChatMessage) => {
    if (!m.content) return;
    e.preventDefault();
    setMsgMenu({
      x: e.clientX, y: e.clientY,
      items: [{ label: '复制', icon: 'compose', onClick: () => { void navigator.clipboard?.writeText(m.content).catch(() => {}); } }],
    });
  }, []);
  const prevLenRef = useRef(session.messages.length);
  const prevSidRef = useRef(session.sessionId);
  // Pagination: remember the top message + scrollHeight before an older page is
  // prepended, so we can restore the viewport anchor after it lands.
  const prevFirstIdRef = useRef(session.messages[0]?.id);
  const anchorRef = useRef<{ id: string | undefined; scrollHeight: number } | null>(null);

  // pinToBottom: direct scrollTop=scrollHeight (evo-chat doctrine — robust to
  // sentinel partial-visibility + Chromium JS-scroll-suppression). Used for
  // initial load, session switch, keyboard rise, and streaming tokens.
  const pinInstant = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Track near-bottom (50px tolerance) for the new-message badge / auto-follow,
  // and near-top (load older page when scrolled up to within 80px of the top).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      atBottomRef.current = bottom;
      if (bottom) setNewCount(0);
      // A deliberate scroll away from the bottom cancels the post-send follow.
      if (!bottom) justSentRef.current = false;
      if (el.scrollTop < 80 && session.hasMore && !session.loadingHistory) {
        anchorRef.current = { id: session.messages[0]?.id, scrollHeight: el.scrollHeight };
        onLoadMore();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [session.hasMore, session.loadingHistory, session.messages, onLoadMore]);

  // Keep the latest message pinned when the DOCK height changes (choice form
  // appears, stop button toggles, multiline textarea grows). Pure CSS can't move
  // an overflowing scroll on container resize, so — staying within the sanctioned
  // scroll-position gray area (same as the new-message pin) — re-pin on the
  // scroll viewport's own resize, but only if the user was already at the bottom
  // (don't yank them while reading history).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (atBottomRef.current || justSentRef.current) pinInstant(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pinInstant]);

  // touchmove → blur (dismiss mobile keyboard when dragging the list).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onTouchMove = () => {
      const a = document.activeElement;
      if (a instanceof HTMLElement && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) a.blur();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, []);

  // Switching sessions: snap instantly to the bottom, reset counters.
  useLayoutEffect(() => {
    if (prevSidRef.current !== session.sessionId) {
      prevSidRef.current = session.sessionId;
      prevLenRef.current = session.messages.length;
      atBottomRef.current = true;
      setNewCount(0);
      requestAnimationFrame(pinInstant);
    }
  }, [session.sessionId, session.messages.length, pinInstant]);

  // Message/stream updates. Distinguish an older-page PREPEND (top grows) from a
  // new-message APPEND (bottom grows): prepend → restore the viewport anchor so
  // the user stays put; append → follow if near bottom, else bump the badge.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const len = session.messages.length;
    const grew = len > prevLenRef.current;
    const firstId = session.messages[0]?.id;
    const prependedTop = firstId !== prevFirstIdRef.current && anchorRef.current != null;
    prevLenRef.current = len;
    prevFirstIdRef.current = firstId;

    if (prependedTop && el) {
      // Older page landed: keep the previously-top message visually fixed.
      const delta = el.scrollHeight - anchorRef.current!.scrollHeight;
      el.scrollTop = el.scrollTop + delta;
      anchorRef.current = null;
      return;
    }
    if (atBottomRef.current || justSentRef.current) {
      pinInstant();
    } else if (grew) {
      setNewCount((n) => n + 1);
    }
  }, [session.messages, pinInstant]);

  // Clear the post-send follow once the turn ends.
  useEffect(() => {
    if (session.status !== 'running') justSentRef.current = false;
  }, [session.status]);

  const jumpToBottom = useCallback(() => { setNewCount(0); atBottomRef.current = true; pinInstant(); }, [pinInstant]);

  // Focusing the composer should NOT yank the view to the bottom while the user is
  // reading history. Only re-pin if they were already at the bottom (the mobile
  // keyboard-rise case, where staying pinned to the latest message is desirable).
  const pinOnFocusIfAtBottom = useCallback(() => { if (atBottomRef.current) pinInstant(); }, [pinInstant]);

  // Sending from THIS device: force-follow the bottom through the user-message
  // append + the stop button appearing (which shrinks the scroll viewport).
  // When the agent is waiting on an ask_user question, a freeform send answers
  // it (respondToUserInput) instead of starting a new prompt.
  // A composer send is context-sensitive: it answers a pending ask (respondToUserInput),
  // or — while a plan is pending — is taken as a NEW instruction that dismisses the
  // plan, leaves plan mode, and runs (planSupersede). Otherwise a normal prompt.
  const ask = session.ask;
  const planRequest = session.planRequest;
  const handleSend = useCallback((text: string): boolean => {
    if (ask) { onRespondAsk?.(ask.requestId, text, true); justSentRef.current = true; atBottomRef.current = true; return true; }
    if (planRequest) { onPlanSupersede?.(planRequest.requestId, text); justSentRef.current = true; atBottomRef.current = true; return true; }
    const ok = onSend?.(text) ?? false;
    if (ok) { justSentRef.current = true; atBottomRef.current = true; }
    return ok;
  }, [ask, planRequest, onSend, onRespondAsk, onPlanSupersede]);

  const handleChoice = useCallback((choice: string) => {
    if (!ask) return;
    onRespondAsk?.(ask.requestId, choice, false);
    justSentRef.current = true; atBottomRef.current = true;
  }, [ask, onRespondAsk]);

  return (
    <main className="chat">
      <div ref={scrollRef} className="chat-messages">
        {session.loadingHistory && session.messages.length > 0 && (
          <div className="chat-loading-older" aria-live="polite">加载更早的消息…</div>
        )}
        {session.messages.length === 0 && !session.loadingHistory && (
          <p className="chat-empty-hint">开始对话吧 — 工作目录 {session.cwd}</p>
        )}
        {session.messages.map((m, i) => {
          const prev = session.messages[i - 1];
          const newDay = !prev || !sameDay(prev.timestamp, m.timestamp);
          const showByline = m.role === 'assistant' && (newDay || !prev || prev.role !== 'assistant');
          // Reasoning streams expanded while the turn is live (last message +
          // running), then auto-collapses when done.
          const thinkingLive = m.role === 'assistant' && i === session.messages.length - 1 && session.status === 'running';
          return (
            <div key={m.id} className="msg-group">
              {newDay && <div className="date-separator" aria-hidden="true">{dateLabel(m.timestamp)}</div>}
              <MessageRow m={m} showByline={showByline} thinkingLive={thinkingLive} onMenu={openMsgMenu} />
            </div>
          );
        })}

        {session.compacting && (
          <div className="chat-typing" aria-live="polite">正在压缩上下文…</div>
        )}
        {session.status === 'running' && !session.compacting && !ask && (
          <div className="chat-typing" aria-live="polite">
            {session.intent || '回复中…'}
            <button type="button" className="chat-typing-stop" onClick={() => onCancel?.()}>停止</button>
          </div>
        )}
        {session.error && <p className="chat-error">错误: {session.error}</p>}

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
                <button key={c} type="button" className="chat-ask-choice" onClick={() => handleChoice(c)}>{c}</button>
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
                  onClick={() => onRespondPlan?.(pr.requestId, a)}
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
            <button type="button" className="chat-ask-choice" onClick={() => onRespondElicitation?.(session.elicitation!.requestId, 'accept')}>同意</button>
            <button type="button" className="chat-ask-choice" onClick={() => onRespondElicitation?.(session.elicitation!.requestId, 'decline')}>拒绝</button>
          </div>
        </div>
      )}

      {!readOnly && session.queue.length > 0 && (
        <div className="chat-queue" aria-label="排队中的消息">
          {session.queue.map((q) => (
            <div key={q.id} className="chat-queue-item">
              <span className="chat-queue-text">{q.text}</span>
              <button type="button" className="chat-queue-remove" aria-label="移除" onClick={() => onRemoveQueued?.(q.id)}>×</button>
            </div>
          ))}
        </div>
      )}

      {readOnly ? (
        <div className="chat-readonly-note" aria-label="只读会话">已删除的会话 · 只读</div>
      ) : (
        <Composer
          busy={session.status === 'running' && !ask}
          disabled={!!session.compacting && session.status !== 'running'}
          placeholder={(session.compacting && session.status !== 'running') ? '正在压缩上下文，请稍候…' : (ask ? (ask.allowFreeform ? '选择上方选项，或输入你的回答…' : '选择上方一个选项…') : (planRequest ? '选择上方操作，或直接输入新指令让我照做…' : '输入消息…'))}
          initialDraft={initialDraft}
          onPersistDraft={onPersistDraft}
          onSend={handleSend}
          onAttach={onAttach}
          onFocusPin={pinOnFocusIfAtBottom}
        />
      )}
      {msgMenu && (
        <ContextMenu x={msgMenu.x} y={msgMenu.y} items={msgMenu.items} onClose={() => setMsgMenu(null)} />
      )}
    </main>
  );
}
