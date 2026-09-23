import type { ReactNode } from 'react';
import type { ChatSession, ExitPlanModeAction } from '../net/types';
import { Icon } from './Icon';
import { Button } from './Button';
import { MessageBody } from './MessageBody';
import { MessagePresentation, ModuleRuntimeProvider } from './ModuleComponents';
import type { ModuleRuntime } from '../lib/moduleRuntime';

const PLAN_ACTION_LABEL: Record<ExitPlanModeAction, string> = {
  interactive: '开始执行（交互）',
  autopilot: '自动执行',
  autopilot_fleet: '并行执行（fleet）',
  exit_only: '仅退出计划',
};

function PendingDecision({ label, title, icon, pending, children, actions, className = '' }: {
  label: string; title: string; icon: ReactNode; pending: boolean;
  children: ReactNode; actions?: ReactNode; className?: string;
}) {
  return <div className={`chat-ask chat-pending ${className}`.trim()} role="group" aria-label={label} aria-busy={pending}>
    <div className="chat-pending-head">{icon}{actions ? <>
      <span>{title}</span><span className="chat-decision-actions">{actions}</span>
    </> : title}</div>
    <div className="chat-pending-body">
      {children}
    </div>
  </div>;
}

export function AskContent({ request, sessionId, pending, disabled = false, onChoice, runtime, actions }: {
  sessionId: string; runtime?: ModuleRuntime;
  request: NonNullable<ChatSession['ask']>; pending: boolean; disabled?: boolean; onChoice: (choice: string) => void;
  actions?: ReactNode;
}) {
  const body = <div className="chat-pending-body chat-answer-question" role="group" aria-label="需要你的选择" aria-busy={pending}>
    {actions ? <div className="chat-question-row">
      <Icon name="decision" size={16} />
      <MessagePresentation className="chat-ask-q" identity={{ sessionId, kind: 'ask', id: request.requestId }} complete>{request.question}</MessagePresentation>
      <span className="chat-decision-actions">{actions}</span>
    </div> : <MessagePresentation className="chat-ask-q" identity={{ sessionId, kind: 'ask', id: request.requestId }} complete>{request.question}</MessagePresentation>}
    {!!request.choices?.length && <div className="chat-ask-choices">
      {request.choices.map(choice => <Button key={choice} className="chat-ask-choice"
        disabled={pending || disabled} onClick={() => onChoice(choice)}>{choice}</Button>)}
    </div>}
  </div>;
  return runtime ? <ModuleRuntimeProvider runtime={runtime}>{body}</ModuleRuntimeProvider> : body;
}

export function PlanCard({ request, pending, disabled = false, onSelect, actions }: {
  request: NonNullable<ChatSession['planRequest']>; pending: boolean; disabled?: boolean; onSelect: (action: ExitPlanModeAction) => void;
  actions?: ReactNode;
}) {
  return <PendingDecision label="计划待确认" title="计划已就绪" icon={<Icon name="decision" size={16} />}
    className="chat-plan" pending={pending} actions={actions}>
    <div className="chat-pending-content" role="region" tabIndex={0} aria-label="计划内容">
      <div className="chat-pending-summary"><MessageBody body={request.summary} /></div>
      {request.planContent && <details className="chat-pending-detail">
        <summary>查看完整计划</summary>
        <pre className="chat-pending-pre">{request.planContent}</pre>
      </details>}
    </div>
    <div className="chat-ask-choices">
      {(request.actions ?? []).map(action => <Button key={action} className="chat-ask-choice"
        variant={action === request.recommendedAction ? 'primary' : 'default'}
        disabled={pending || disabled} onClick={() => onSelect(action)}>{PLAN_ACTION_LABEL[action]}</Button>)}
    </div>
    {!request.actions?.length && <div className="chat-pending-hint" role="status">
      {request.actions ? '原生未提供可用的计划操作。' : '原生计划操作列表不可用。'}
    </div>}
  </PendingDecision>;
}

export function ElicitationCard({ request, pending, disabled = false, onSelect, actions }: {
  request: NonNullable<ChatSession['elicitation']>; pending: boolean; disabled?: boolean;
  onSelect: (action: 'accept' | 'decline' | 'cancel') => void;
  actions?: ReactNode;
}) {
  return <PendingDecision label="需要你的输入" title="工具请求确认" icon={<Icon name="decision" size={16} />}
    className="chat-tool-confirm" pending={pending} actions={actions}>
    <div className="chat-ask-q">{request.message}</div>
    <div className="chat-ask-choices">
      {(request.actions ?? ['accept', 'decline', 'cancel']).map(action => <Button key={action}
        className="chat-ask-choice" disabled={pending || disabled} onClick={() => onSelect(action)}>
        {{ accept: '同意', decline: '拒绝', cancel: '取消' }[action]}
      </Button>)}
    </div>
  </PendingDecision>;
}
