import { useState, type ReactNode } from 'react';
import type { ChatSession, ExitPlanModeAction } from '../net/types';
import { Icon } from './Icon';
import { MessageBody } from './MessageBody';
import { ModuleMessageDecorations } from './ModuleContributions';
import type { ModuleRuntime } from '../lib/moduleRuntime';

const PLAN_ACTION_LABEL: Record<ExitPlanModeAction, string> = {
  interactive: '开始执行（交互）',
  autopilot: '自动执行',
  autopilot_fleet: '并行执行（fleet）',
  exit_only: '仅退出计划',
};

function PendingDecision({ label, title, icon, pending, children, className = '' }: {
  label: string; title: string; icon: ReactNode; pending: boolean;
  children: ReactNode; className?: string;
}) {
  return <div className={`chat-ask chat-pending ${className}`.trim()} role="group" aria-label={label} aria-busy={pending}>
    <div className="chat-pending-head">{icon}{title}</div>
    <div className="chat-pending-body">
      {children}
    </div>
  </div>;
}

export function AskContent({ request, sessionId, pending, disabled = false, onChoice, runtime }: {
  sessionId: string; runtime?: ModuleRuntime;
  request: NonNullable<ChatSession['ask']>; pending: boolean; disabled?: boolean; onChoice: (choice: string) => void;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return <div className="chat-pending-body chat-answer-question" role="group" aria-label="需要你的选择" aria-busy={pending}>
    <div className="chat-ask-q" ref={setElement}>{request.question}</div>
    {!!request.choices?.length && <div className="chat-ask-choices">
      {request.choices.map(choice => <button key={choice} type="button" className="chat-ask-choice ck-button"
        disabled={pending || disabled} onClick={() => onChoice(choice)}>{choice}</button>)}
    </div>}
    <ModuleMessageDecorations runtime={runtime} context={{
      sessionId, kind: 'ask', id: request.requestId, complete: true, element,
    }} />
  </div>;
}

export function PlanCard({ request, pending, disabled = false, onSelect }: {
  request: NonNullable<ChatSession['planRequest']>; pending: boolean; disabled?: boolean; onSelect: (action: ExitPlanModeAction) => void;
}) {
  return <PendingDecision label="计划待确认" title="计划已就绪" icon={<Icon name="mode_plan" size={16} />}
    className="chat-plan" pending={pending}>
    <div className="chat-pending-content" role="region" tabIndex={0} aria-label="计划内容">
      <div className="chat-pending-summary"><MessageBody body={request.summary} /></div>
      {request.planContent && <details className="chat-pending-detail">
        <summary>查看完整计划</summary>
        <pre className="chat-pending-pre">{request.planContent}</pre>
      </details>}
    </div>
    <div className="chat-ask-choices">
      {(request.actions ?? []).map(action => <button key={action} type="button"
        className={`chat-ask-choice ck-button${action === request.recommendedAction ? ' is-recommended' : ''}`}
        disabled={pending || disabled} onClick={() => onSelect(action)}>{PLAN_ACTION_LABEL[action]}</button>)}
    </div>
    {!request.actions?.length && <div className="chat-pending-hint" role="status">
      {request.actions ? '原生未提供可用的计划操作。' : '原生计划操作列表不可用。'}
    </div>}
  </PendingDecision>;
}

export function ElicitationCard({ request, pending, disabled = false, onSelect }: {
  request: NonNullable<ChatSession['elicitation']>; pending: boolean; disabled?: boolean;
  onSelect: (action: 'accept' | 'decline' | 'cancel') => void;
}) {
  return <PendingDecision label="需要你的输入" title="工具请求确认" icon={<Icon name="mcp" size={16} />}
    className="chat-tool-confirm" pending={pending}>
    <div className="chat-ask-q">{request.message}</div>
    <div className="chat-ask-choices">
      {(request.actions ?? ['accept', 'decline', 'cancel']).map(action => <button key={action} type="button"
        className="chat-ask-choice ck-button" disabled={pending || disabled} onClick={() => onSelect(action)}>
        {{ accept: '同意', decline: '拒绝', cancel: '取消' }[action]}
      </button>)}
    </div>
  </PendingDecision>;
}
