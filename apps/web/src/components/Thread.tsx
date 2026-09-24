// Chat window (detail pane). Reading position and explicit bottom-follow are
// maintained by one scroll owner; message bodies reuse the markdown renderer.
// Thread composes the per-concern hooks and presentation in features/thread.

import type { ReactNode } from 'react';
import { Composer } from './Composer';
import { SessionControlBar, SessionControlActionButton } from './SessionControlBar';
import type { SessionControlAction } from '../lib/sessionControls';
import type { ChatSession, ExitPlanModeAction } from '../net/types';
import type { NativeDraftRequest } from '../lib/draft';
import { useCockpit } from '../net/store';
import { DisclosureChoices } from './DisclosureChoices';
import { useThreadExecution } from '../features/thread/useThreadExecution';
import { useThreadDrafts } from '../features/thread/useThreadDrafts';
import { useThreadActivity } from '../features/thread/useThreadActivity';
import { useThreadScroll } from '../features/thread/useThreadScroll';
import { useInputCard } from '../features/thread/useInputCard';
import { ThreadTranscript } from '../features/thread/ThreadTranscript';
import { ExecutionHead, PendingDecisions, QueuedMessages, ThreadInputNotices } from '../features/thread/ThreadInputCard';

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
  const authoritative = connected && snapshotReady;
  const execution = useThreadExecution(session, {
    readOnly, hasControlAction: !!onControlAction, hasInterrupt: !!onInterrupt, hasCancel: !!onCancel, connected, snapshotReady,
  });
  const { queueCount } = execution;
  const {
    draft, planDraft, elicitationDraft, actionPending, hasContent, decisionKey, runAction, handleSend, handleChoice,
  } = useThreadDrafts(session, { readOnly, authoritative, onSend, onRespondAsk });
  const { activityRefreshing, activityItems, executionProgress, executionLabel } = useThreadActivity(session, { authoritative, actionPending, readOnly });
  const { scrollRef, contentRef, messages, hasNewContent, awayFromBottom, follow } = useThreadScroll(session, { readOnly, connected, snapshotReady, onLoadMore });

  const ask = session.ask;
  const planRequest = session.planRequest;
  const hasPendingDecision = !readOnly && !!(planRequest || session.elicitation);
  const hasExecution = session.compacting || session.status === 'running' || (!readOnly && queueCount > 0);
  const hasInputHeader = !controls && composerControls === undefined && !!(hasExecution || hasPendingDecision || (!readOnly && ask) || activityItems.length);
  const {
    cardRef, bodyId, open: inputOpen, controlsOpen, releaseEditorSize, executionControlRef, toggle: toggleInput, toggleControls,
  } = useInputCard({
    sessionId: session.sessionId, foldIdentity: [ask?.requestId, planRequest?.requestId, session.elicitation?.requestId],
    hasInputHeader, sharedControls: !!controls, draftId: draft.reference.id, decisionKey,
  });
  const cancelDecision = (kind: 'ask' | 'plan' | 'elicitation', requestId: string, pending: boolean) =>
    controls && onControlAction ? <SessionControlActionButton
      identity={JSON.stringify([session.sessionId, session.controls?.token ?? session.controlsDisplay?.token, 'cancel-decision', kind, requestId])}
      label={kind === 'ask' ? '取消问题并中断当前回合' : kind === 'plan' ? '取消计划确认（仅退出计划）' : '取消工具确认'}
      icon="close" waiting="取消中…" disabled={!authoritative || pending || !session.loaded || !!session.closing || !!session.loading
        || !!session.controlsStale || activityRefreshing}
      controlRef={executionControlRef} onAction={() => onControlAction({ type: 'cancel-decision', kind, requestId })} /> : undefined;
  const operation = draft.reference.purpose.kind;

  return (
    <DisclosureChoices key={session.sessionId}><main className="chat">
      <ThreadTranscript session={session} messages={messages} scrollRef={scrollRef} contentRef={contentRef}
        awayFromBottom={awayFromBottom} hasNewContent={hasNewContent}
        onFollow={follow} onRetryHistory={onRetryHistory} />

      <div className="chat-input-area">
        <ThreadInputNotices session={session} readOnly={readOnly} authoritative={authoritative}
          activityRefreshing={activityRefreshing} execution={execution} draft={draft}
          onRetryControls={onRetryControls} onRetryHistory={onRetryHistory} />
        <div className="chat-input-card" ref={cardRef} data-open={inputOpen}
          data-controls={!!controls || undefined} data-controls-open={controls ? controlsOpen : undefined}
          onChange={controls ? event => { if (event.target instanceof HTMLTextAreaElement) releaseEditorSize(); } : undefined}
          data-header={hasInputHeader || undefined} data-decision={!!(!readOnly && (ask || hasPendingDecision)) || undefined}
          data-question={(!readOnly && operation === 'ask') || undefined}>
          <ExecutionHead hidden={!hasInputHeader} open={inputOpen} bodyId={bodyId} onToggle={toggleInput}
            label={executionLabel} progress={executionProgress} activityItems={activityItems}
            foldedDraft={!readOnly && hasContent && !inputOpen} operationsActive={!!session.activeOperations}
            execution={execution} controlRef={executionControlRef} onInterrupt={onInterrupt} onCancel={onCancel} />
          <div id={bodyId} className="chat-input-card-body" hidden={!inputOpen}>
            {controls && onControlAction && <SessionControlBar session={session} controls={controls} connected={authoritative}
              expanded={controlsOpen} disabled={!authoritative || !session.loaded || !!session.loading || !!session.closing || activityRefreshing || !!session.controlsStale}
              controlRef={executionControlRef} onAction={onControlAction}
              onToggle={toggleControls} />}
            {!readOnly && composerControls}
            <div className="chat-input-context">
              {!readOnly && !onControlAction && composerControls === undefined && queueCount > 0 && <QueuedMessages
                queue={session.queue} connected={connected} controlRef={executionControlRef} onRemove={onRemoveQueued} />}
              {hasPendingDecision && <PendingDecisions session={session} authoritative={authoritative}
                planDraft={planDraft} elicitationDraft={elicitationDraft} cancelAction={cancelDecision}
                runAction={runAction} onRespondPlan={onRespondPlan} onRespondElicitation={onRespondElicitation} />}
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
