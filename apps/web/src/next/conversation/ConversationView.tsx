import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { Alert, AlertDescription, Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@cockpit/ui';
import { ArrowDown, ChevronDown, Square, X } from 'lucide-react';
import type { ChatMessage, ChatSession, ExitPlanModeAction } from '../../net/types';
import type { NativeDraftRequest } from '../../lib/draft';
import type { SessionDraft } from '../../lib/textDraft';
import { getDraftSession } from '../../lib/draftSelection';
import { observeLocalSubmissions } from '../../lib/localSubmission';
import { hasNewTranscriptContent } from '../../lib/transcriptActivity';
import { useRemovedControlFocus } from '../../lib/useRemovedControlFocus';
import { useKeyedAction } from '../../lib/useKeyedResource';
import { useCockpit } from '../../net/store';
import { observeThreadScroll, type ThreadScroll } from '../../components/threadScroll';
import { observeHistoryPrefetch } from '../../components/historyPrefetch';
import { MessagePresentation, useModuleRuntime } from '../modules';
import { Composer, DraftNotices, type ModuleBootstrap } from './Composer';
import { CopyText, Markdown } from './Markdown';
import { Disclosures, Transcript } from './Transcript';

export interface ConversationViewProps {
  session: ChatSession;
  moduleBootstrap: ModuleBootstrap;
  readOnly?: boolean;
  onSend?: (request: NativeDraftRequest) => Promise<boolean>;
  onRespondAsk?: (requestId: string, answer: string, wasFreeform: boolean) => Promise<boolean>;
  onRespondPlan?: (requestId: string, action: ExitPlanModeAction) => Promise<boolean>;
  onRespondElicitation?: (requestId: string, action: 'accept' | 'decline' | 'cancel') => Promise<boolean>;
  onRemoveQueued?: (itemId: string) => Promise<void>;
  onCancel?: () => Promise<void>;
  onInterrupt?: () => Promise<{ ok: true; interrupted: boolean }>;
  onLoadMore: () => void;
  onRetryHistory?: () => void;
}
const planLabels: Record<ExitPlanModeAction, string> = {
  interactive: '开始执行（交互）', autopilot: '自动执行', autopilot_fleet: '并行执行（fleet）', exit_only: '仅退出计划',
};

export function ConversationView(props: ConversationViewProps) {
  return <Disclosures key={props.session.sessionId}><ConversationContent {...props} /></Disclosures>;
}

function DecisionAction({ draft, disabled, onAction, children, controlRef, variant = 'outline' }: {
  draft: SessionDraft; disabled: boolean; onAction(): Promise<boolean>; children: ReactNode;
  controlRef: Ref<HTMLButtonElement>; variant?: 'default' | 'outline';
}) {
  const { pending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  return <Button ref={controlRef} variant={variant} disabled={disabled} aria-disabled={pending || undefined}
    aria-busy={pending || undefined} onClick={() => { if (!disabled && !pending) void onAction(); }}>{children}</Button>;
}

function ConversationContent({ session, moduleBootstrap, readOnly = false, onSend, onRespondAsk, onRespondPlan,
  onRespondElicitation, onRemoveQueued, onCancel, onInterrupt, onLoadMore, onRetryHistory }: ConversationViewProps) {
  const connected = useCockpit(state => state.connState === 'open');
  const snapshotReady = useCockpit(state => state.snapshotReady);
  const authoritative = connected && snapshotReady;
  const runtime = useModuleRuntime();
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const drafts = useMemo(() => getDraftSession(session.sessionId), [session.sessionId]);
  useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  const decisions = useMemo(() => ({
    loaded: session.loaded, ask: session.ask, planRequest: session.planRequest, elicitation: session.elicitation,
  }), [session.loaded, session.ask, session.planRequest, session.elicitation]);
  const draft = drafts.current(decisions, authoritative);
  const askDraft = session.ask ? drafts.candidate({ kind: 'ask', requestId: session.ask.requestId }) : undefined;
  const planDraft = session.planRequest ? drafts.candidate({ kind: 'plan', requestId: session.planRequest.requestId }) : undefined;
  const elicitationDraft = session.elicitation ? drafts.candidate({ kind: 'elicitation', requestId: session.elicitation.requestId }) : undefined;
  const preparation = () => [draft, askDraft, planDraft, elicitationDraft]
    .map(target => !target || runtime.isDraftPrepared(target)).join(':');
  useSyncExternalStore(runtime.subscribe, preparation, preparation);
  useLayoutEffect(() => { drafts.synchronize(decisions, authoritative); }, [drafts, decisions, authoritative]);
  useLayoutEffect(() => {
    if (moduleBootstrap !== 'settled') return;
    for (const target of new Set([drafts.prompt, draft, askDraft, planDraft, elicitationDraft])) {
      if (target) runtime.prepareDraft(target, readOnly);
    }
  }, [runtime, drafts, draft, askDraft, planDraft, elicitationDraft, readOnly, moduleBootstrap]);
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const allowed = authoritative && !readOnly && !session.loading && !session.closing
    && !session.cancelling && !(session.compacting && session.status !== 'running');
  const canAct = useRef(false);
  useLayoutEffect(() => {
    canAct.current = allowed && moduleBootstrap === 'settled';
    return () => { canAct.current = false; };
  }, [allowed, moduleBootstrap, session.sessionId]);
  const ready = (target: SessionDraft) => canAct.current && runtime.isDraftPrepared(target)
    && (target.reference.purpose.kind === 'prompt' || session.loaded);
  const send = () => draft.send(request => onSend?.(request) ?? Promise.resolve(false),
    () => ready(draft) && drafts.isCurrent(draft) && !draft.hasUnclaimedStoredData()
      && draft.reference.purpose.kind !== 'elicitation' && session.ask?.allowFreeform !== false);
  const runDecision = (target: SessionDraft, action: () => Promise<boolean> | undefined) =>
    target.runAction(action, () => ready(target) && drafts.isLive(target));
  const controlAction = useKeyedAction(`next-execution:${session.sessionId}`);
  const [notice, setNotice] = useState('');
  const controls = useRef<HTMLDivElement>(null);
  const controlRef = useRemovedControlFocus(session.sessionId, controls);
  const askId = session.ask?.requestId, planId = session.planRequest?.requestId, elicitationId = session.elicitation?.requestId;
  const executing = session.status === 'running' || !!session.compacting;
  const inputKey = JSON.stringify([askId, planId, elicitationId, executing]);
  const [inputState, setInputState] = useState({ key: inputKey, open: true });
  if (inputState.key !== inputKey) setInputState({ key: inputKey, open: true });
  const inputOpen = inputState.key !== inputKey || inputState.open;
  const setInputOpen = (open: boolean) => setInputState({ key: inputKey, open });

  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scroll = useRef<ThreadScroll | null>(null);
  const previous = useRef<ChatMessage[]>([]);
  const [heldHead, setHeldHead] = useState<string | null>(null);
  const [away, setAway] = useState(false);
  const [newContent, setNewContent] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const start = heldHead ? session.messages.findIndex(message => message.id === heldHead) : -1;
  const messages = useMemo(() => start > 0 ? session.messages.slice(start) : session.messages, [start, session.messages]);
  const held = messages !== session.messages;
  useLayoutEffect(() => {
    if (!viewport.current || !content.current) return;
    const element = content.current;
    previous.current = [];
    const owner = observeThreadScroll(viewport.current, element, () => setNewContent(false), active => {
      setHeldHead(active ? element.querySelector('[data-window-item-id]')?.getAttribute('data-window-item-id') ?? null : null);
    }, setAway);
    scroll.current = owner.scroll;
    return () => { owner.dispose(); scroll.current = null; };
  }, [session.sessionId]);
  useLayoutEffect(() => {
    if (readOnly || !scroll.current) return;
    const owner = scroll.current;
    return observeLocalSubmissions(session.sessionId, () => owner.follow());
  }, [session.sessionId, readOnly]);
  useLayoutEffect(() => {
    const element = viewport.current, body = content.current;
    if (!authoritative || !visible || !element || !body || !session.materialized || session.loadingHistory
      || session.historyError || session.error || session.historyStale || held) return;
    const needsFill = () => element.clientHeight > 0 && element.scrollHeight < element.clientHeight * 2;
    return observeHistoryPrefetch(element, body,
      () => session.hasMore && !session.incompleteBoundary && (needsFill() || !scroll.current?.following),
      onLoadMore, () => element.scrollTop, needsFill);
  }, [authoritative, visible, session.materialized, session.loadingHistory, session.historyError, session.error,
    session.historyStale, session.hasMore, session.incompleteBoundary, held, onLoadMore]);
  useLayoutEffect(() => {
    if (!scroll.current?.following && hasNewTranscriptContent(previous.current, session.messages)) setNewContent(true);
    previous.current = session.messages;
    scroll.current?.changed({ contentReady: !!content.current?.querySelector('[data-message-frame]') });
  }, [messages, session.messages, session.status, session.materialized, session.hasMore, session.error, session.compacting]);
  const jump = useCallback(() => { scroll.current?.follow(); }, []);
  const queue = session.queue ?? [];
  const canControl = authoritative && !readOnly && session.loaded && !session.loading && !session.closing
    && !session.cancelling && !session.compacting && !session.activeOperations && !controlAction.busy;
  const stop = session.status === 'running' && !session.compacting;
  const stopUnavailable = !authoritative || !session.loaded || !!session.loading || !!session.closing
    || (!session.cancelling && !controlAction.busy && !!session.activeOperations);
  const interrupt = stop && queue.length > 0 && session.nativeProcessing !== false;
  const label = session.cancelling ? '正在停止…' : session.compacting ? '正在压缩上下文…'
    : state.pending ? '正在提交…' : session.ask ? '等待你的回答' : session.planRequest ? '等待确认计划'
      : session.elicitation ? '等待工具确认' : session.status === 'running' ? session.intent || '执行中…'
        : queue.length ? '等待处理队列' : '消息输入';
  const decisionDisabled = !allowed || !session.loaded || moduleBootstrap !== 'settled';
  return <section className="next-conversation" aria-label="会话" data-conversation-session={session.sessionId}>
    <div className="next-transcript">
      <div ref={viewport} className="next-messages chat-messages" tabIndex={0} aria-label="对话消息" aria-busy={session.loadingHistory}>
        <div ref={content} className="next-message-content">
          {(!session.materialized || session.hasMore) && <p className="next-history-notice">加载更早的消息…</p>}
          {(session.historyError || session.historyStale || !session.materialized) && !session.loadingHistory && <Alert>
            <AlertDescription>{session.historyError ? `历史加载失败：${session.historyError}` : '对话历史尚未同步。'}
              {onRetryHistory && <Button variant="outline" disabled={!authoritative} onClick={() => {
                if (session.historyStale || !session.materialized) jump();
                onRetryHistory();
              }}>重新读取历史</Button>}
            </AlertDescription>
          </Alert>}
          {session.partialHistory && <p role="status">断线期间的临时片段可能不完整，以原生保存后的完整消息为准。</p>}
          {session.incompleteBoundary && !session.hasMore && <p>部分工具记录缺少对应的发起消息，现有历史无法补齐。</p>}
          {!session.messages.length && session.materialized && !session.historyStale && !session.loadingHistory && !session.hasMore &&
            <div className="next-empty"><h2>开始对话</h2><p>输入消息开始讨论。</p><code>{session.cwd}</code></div>}
          <Transcript messages={messages} scope={session.sessionId} liveId={session.status === 'running' ? session.messages.at(-1)?.id : undefined} />
        </div>
      </div>
      {away && <Button className="next-latest" variant="secondary" onClick={jump}><ArrowDown aria-hidden="true" />{newContent ? '有新内容 · 回到最新' : '回到最新'}</Button>}
    </div>
    <div className="next-input-area" ref={controls}>
      {!authoritative && <p role="status">等待连接与会话同步，现有内容仍可阅读。</p>}
      {session.error && <Alert variant="destructive"><AlertDescription>{session.error}
        {onRetryHistory && <Button variant="outline" disabled={!authoritative} onClick={onRetryHistory}>重试同步</Button>}
      </AlertDescription></Alert>}
      {controlAction.error && <Alert variant="destructive"><AlertDescription>操作未确认：{controlAction.error}。请先核对会话，不要直接重试。</AlertDescription></Alert>}
      {notice && <p role="status">{notice}</p>}
      {!readOnly && <DraftNotices draft={draft} moduleBootstrap={moduleBootstrap} />}
      {!readOnly && [askDraft, planDraft, elicitationDraft].filter((target): target is SessionDraft => !!target && target !== draft)
        .map(target => <DraftNotices key={target.reference.id} draft={target} moduleBootstrap="settled" />)}
      {readOnly ? <p>只读会话</p> : <Collapsible open={inputOpen} onOpenChange={setInputOpen}>
        <div className="next-input-header">
          <CollapsibleTrigger asChild><Button ref={controlRef} variant="ghost" className="chat-execution-head">
            <ChevronDown aria-hidden="true" /><span>{label}</span>{state.hasContent && <span>有草稿</span>}
          </Button></CollapsibleTrigger>
          <div className="next-actions">
            {interrupt && onInterrupt && <Button ref={controlRef} variant="outline" disabled={stopUnavailable}
              aria-disabled={!canControl || undefined} onClick={() => {
              if (!canControl) return;
              let interrupted = false;
              void controlAction.run(async () => {
                const result = await onInterrupt();
                interrupted = result.interrupted;
              }, () => setNotice(interrupted ? '已请求打断；队列由 Copilot 接着处理。' : '当前没有可打断的主回合；队列未改动。'));
            }}>打断并处理队列</Button>}
            {stop && onCancel && <Button ref={controlRef} variant="outline" disabled={stopUnavailable}
              aria-disabled={!canControl || undefined} aria-busy={session.cancelling || undefined} onClick={() => {
              if (canControl) void controlAction.run(onCancel);
            }}><Square aria-hidden="true" />{session.cancelling ? '正在停止…' : queue.length ? '停止并清空队列' : '停止'}</Button>}
          </div>
        </div>
        <CollapsibleContent forceMount hidden={!inputOpen} className="next-input-content">
          {!!queue.length && <section aria-label="排队中的消息" className="next-queue">
            {queue.map(item => <article key={item.id}><pre>{item.text}</pre><div className="next-actions">
              <CopyText text={item.text} label="复制排队消息" />
              <Button ref={controlRef} className="chat-queue-remove" variant="ghost" aria-label="移除排队消息"
                disabled={!allowed || !onRemoveQueued} aria-disabled={controlAction.busy || undefined} onClick={() => {
                  if (allowed && onRemoveQueued && !controlAction.busy) void controlAction.run(() => onRemoveQueued(item.id));
                }}><X aria-hidden="true" />移除</Button>
            </div></article>)}
          </section>}
          {session.planRequest && planDraft && <section key={planDraft.reference.id} className="next-decision" aria-label="计划待确认">
            <Markdown body={session.planRequest.summary} />
            {session.planRequest.planContent && <details><summary>查看完整计划</summary><pre>{session.planRequest.planContent}</pre></details>}
            <div className="next-actions">{(session.planRequest.actions ?? []).map(action => <DecisionAction key={action}
              draft={planDraft} controlRef={controlRef}
              disabled={decisionDisabled || planDraft.hasUnclaimedStoredData() || !runtime.isDraftPrepared(planDraft) || !onRespondPlan}
              variant={action === session.planRequest?.recommendedAction ? 'default' : 'outline'}
              onAction={() => runDecision(planDraft, () => onRespondPlan?.(session.planRequest!.requestId, action))}>{planLabels[action]}</DecisionAction>)}</div>
            {!session.planRequest.actions?.length && <p role="status">原生未提供可用的计划操作。</p>}
          </section>}
          {session.elicitation && elicitationDraft && <section key={elicitationDraft.reference.id} className="next-decision" aria-label="工具请求确认">
            <p>{session.elicitation.message}</p><div className="next-actions">
              {(session.elicitation.actions ?? ['accept', 'decline', 'cancel']).map(action => <DecisionAction key={action}
                draft={elicitationDraft} controlRef={controlRef}
                disabled={decisionDisabled || elicitationDraft.hasUnclaimedStoredData() || !runtime.isDraftPrepared(elicitationDraft) || !onRespondElicitation}
                onAction={() => runDecision(elicitationDraft, () => onRespondElicitation?.(session.elicitation!.requestId, action))}>
                {{ accept: '同意', decline: '拒绝', cancel: '取消' }[action]}</DecisionAction>)}
            </div>
          </section>}
          <Composer key={draft.reference.id} draft={draft} moduleBootstrap={moduleBootstrap}
            disabled={!!session.compacting && session.status !== 'running'} editorRef={controlRef}
            busy={session.status === 'running'} onSend={send}
            sendBlocked={!allowed || (!session.loaded && draft.reference.purpose.kind !== 'prompt')
              || session.ask?.allowFreeform === false || draft.reference.purpose.kind === 'elicitation' || !onSend}
            submitLabel={session.ask ? '提交回答' : session.planRequest ? '发送新指令' : undefined}
            placeholder={session.ask?.allowFreeform === false ? '请选择上方选项' : session.ask ? '输入回答…'
              : session.planRequest ? '输入新指令…' : session.elicitation ? '请选择上方操作' : '输入消息…'}>
            {session.ask && askDraft && <section className="next-decision" aria-label="需要你的选择">
              <MessagePresentation identity={{ kind: 'ask', sessionId: session.sessionId, id: session.ask.requestId }} complete>
                {session.ask.question}
              </MessagePresentation>
              <div className="next-actions">{session.ask.choices?.map((choice, index) => <DecisionAction key={index}
                draft={askDraft} controlRef={controlRef}
                disabled={decisionDisabled || askDraft.hasUnclaimedStoredData() || !runtime.isDraftPrepared(askDraft) || !onRespondAsk}
                onAction={() => runDecision(askDraft, () => onRespondAsk?.(session.ask!.requestId, choice, false))}>{choice}</DecisionAction>)}</div>
            </section>}
          </Composer>
        </CollapsibleContent>
      </Collapsible>}
    </div>
  </section>;
}
