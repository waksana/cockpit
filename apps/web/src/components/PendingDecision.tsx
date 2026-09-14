import type { ReactNode } from 'react';
import type { ChatSession, ExitPlanModeAction } from '../net/types';
import { Icon } from './Icon';
import { MessageBody } from './MessageBody';

const PLAN_ACTION_LABEL: Record<ExitPlanModeAction, string> = {
  interactive: '开始执行（交互）',
  autopilot: '自动执行',
  autopilot_fleet: '并行执行（fleet）',
  exit_only: '仅退出计划',
};

function PendingDecision({ label, title, icon, pending, children, hint, className = '' }: {
  label: string; title: string; icon: ReactNode; pending: boolean;
  children: ReactNode; hint?: string; className?: string;
}) {
  return <div className={`chat-ask chat-pending ${className}`.trim()} role="group" aria-label={label} aria-busy={pending}>
    <div className="chat-pending-head">{icon}{title}</div>
    {children}
    {hint && <div className="chat-pending-hint" role="status">{hint}</div>}
  </div>;
}

export function AskCard({ request, pending, onChoice }: {
  request: NonNullable<ChatSession['ask']>; pending: boolean; onChoice: (choice: string) => void;
}) {
  return <PendingDecision label="需要你的选择" title="等待你的回答" icon={<Icon name="newchat" size={16} />}
    pending={pending} hint={pending ? '正在提交回答…' : undefined}>
    <div className="chat-ask-q">{request.question}</div>
    {!!request.choices?.length && <div className="chat-ask-choices">
      {request.choices.map(choice => <button key={choice} type="button" className="chat-ask-choice"
        disabled={pending} onClick={() => onChoice(choice)}>{choice}</button>)}
    </div>}
  </PendingDecision>;
}

export function PlanCard({ request, pending, onSelect }: {
  request: NonNullable<ChatSession['planRequest']>; pending: boolean; onSelect: (action: ExitPlanModeAction) => void;
}) {
  return <PendingDecision label="计划待确认" title="计划已就绪" icon={<Icon name="mode_plan" size={16} />}
    className="chat-plan" pending={pending} hint={pending ? '正在提交选择…' : undefined}>
    <div className="chat-pending-content" role="region" tabIndex={0} aria-label="计划内容">
      <div className="chat-pending-summary"><MessageBody body={request.summary} /></div>
      {request.planContent && <details className="chat-pending-detail">
        <summary>查看完整计划</summary>
        <pre className="chat-pending-pre">{request.planContent}</pre>
      </details>}
    </div>
    <div className="chat-ask-choices">
      {(request.actions ?? []).map(action => <button key={action} type="button"
        className={`chat-ask-choice${action === request.recommendedAction ? ' is-recommended' : ''}`}
        disabled={pending} onClick={() => onSelect(action)}>{PLAN_ACTION_LABEL[action]}</button>)}
    </div>
    {!request.actions?.length && <div className="chat-pending-hint" role="status">
      {request.actions ? '原生未提供可用的计划操作。' : '原生计划操作列表不可用。'}
    </div>}
  </PendingDecision>;
}

export function ElicitationCard({ request, pending, onSelect }: {
  request: NonNullable<ChatSession['elicitation']>; pending: boolean;
  onSelect: (action: 'accept' | 'decline' | 'cancel') => void;
}) {
  return <PendingDecision label="需要你的输入" title="工具请求确认" icon={<Icon name="mcp" size={16} />}
    className="chat-tool-confirm" pending={pending} hint={pending ? '正在提交选择…' : undefined}>
    <div className="chat-ask-q">{request.message}</div>
    <div className="chat-ask-choices">
      {(request.actions ?? ['accept', 'decline', 'cancel']).map(action => <button key={action} type="button"
        className="chat-ask-choice" disabled={pending} onClick={() => onSelect(action)}>
        {{ accept: '同意', decline: '拒绝', cancel: '取消' }[action]}
      </button>)}
    </div>
  </PendingDecision>;
}
