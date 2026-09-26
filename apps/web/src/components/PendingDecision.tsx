// Decision cards in the transcript: the pending card the user answers (one
// tab per request) and the read-only records of answered decisions.
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { ExitPlanModeAction } from '../net/types';
import type { PendingDecision } from '../lib/pendingDecisions';
import { pendingDecisionKey, PLAN_ACTION_LABEL } from '../lib/pendingDecisions';
import { Icon, type IconName } from './Icon';
import { Button } from './Button';
import { DisclosureSection } from './Disclosure';
import { MarkdownLabel, MessageBody } from './MessageBody';
import { MessagePresentation } from './ModuleComponents';

const ELICITATION_ACTION_LABEL = { accept: '同意', decline: '拒绝', cancel: '取消' } as const;
export type ElicitationAction = keyof typeof ELICITATION_ACTION_LABEL;

const KIND: Record<PendingDecision['kind'], { icon: IconName; title: string; tab: string; waiting: string; done: string }> = {
  ask: { icon: 'decision', title: 'Copilot 在问你', tab: '问题', waiting: '等待你回答', done: '已回答' },
  plan: { icon: 'mode_plan', title: '计划已就绪', tab: '计划', waiting: '等待你确认', done: '已确认' },
  elicitation: { icon: 'mcp', title: '工具请求确认', tab: '工具确认', waiting: '等待你确认', done: '已处理' },
};

function CardHead({ kind, source, state, actions, status }: {
  kind: PendingDecision['kind']; source?: string; state: 'pending' | 'done'; actions?: ReactNode; status?: string;
}) {
  const meta = KIND[kind];
  return <div className="chat-decision-head">
    <Icon name={meta.icon} size={16} className="chat-decision-icon" />
    <span className="chat-decision-title">{meta.title}</span>
    {source && <span className="chat-decision-source">· {source}</span>}
    <span className="chat-decision-status">
      {state === 'done' && <Icon name="success" size={14} />}
      {status ?? (state === 'pending' ? meta.waiting : meta.done)}
    </span>
    {actions && <span className="chat-decision-actions">{actions}</span>}
  </div>;
}

function tabLabels(decisions: readonly PendingDecision[]): string[] {
  const totals = new Map<string, number>();
  for (const decision of decisions) totals.set(decision.kind, (totals.get(decision.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  return decisions.map(decision => {
    const index = (seen.get(decision.kind) ?? 0) + 1;
    seen.set(decision.kind, index);
    return totals.get(decision.kind)! > 1 ? `${KIND[decision.kind].tab} ${index}` : KIND[decision.kind].tab;
  });
}

export interface PendingDecisionHandlers {
  sessionId: string;
  pending: boolean;
  disabled: { ask: boolean; plan: boolean; elicitation: boolean };
  actions?: ReactNode;
  onChoice: (requestId: string, choice: string) => void;
  onPlan: (requestId: string, action: ExitPlanModeAction) => void;
  onElicitation: (request: Extract<PendingDecision, { kind: 'elicitation' }>['request'], action: ElicitationAction) => void;
}

// One card for every pending request. The selected tab is the request the
// input answers; switching tabs never moves focus away from the editor.
export function PendingDecisionCard({ decisions, selected, onSelect, ...handlers }: PendingDecisionHandlers & {
  decisions: readonly PendingDecision[]; selected: PendingDecision; onSelect: (decision: PendingDecision) => void;
}) {
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = tabLabels(decisions);
  const index = Math.max(0, decisions.findIndex(decision => pendingDecisionKey(decision) === pendingDecisionKey(selected)));
  const multiple = decisions.length > 1;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = decisions.length - 1;
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onSelect(decisions[next]);
    tabs.current[next]?.focus();
  };
  const panelId = `${id}-panel`;
  const label = multiple ? `${decisions.length} 项待你处理，当前：${labels[index]}` : `待你处理：${KIND[selected.kind].title}`;
  return <div className="chat-decision-card" data-state="pending" data-kind={selected.kind}
    role="group" aria-label={label} aria-busy={handlers.pending || undefined}>
    {multiple && <div className="chat-decision-tabs" role="tablist" aria-label="待处理的请求" onKeyDown={move}>
      {decisions.map((decision, position) => <button key={pendingDecisionKey(decision)} type="button"
        ref={element => { tabs.current[position] = element; }}
        className="chat-decision-tab" role="tab" id={`${id}-tab-${position}`}
        aria-selected={position === index} aria-controls={panelId} tabIndex={position === index ? 0 : -1}
        onClick={() => onSelect(decision)}>
        <Icon name={KIND[decision.kind].icon} size={14} />{labels[position]}
      </button>)}
    </div>}
    <div className="chat-decision-panel" id={panelId} {...(multiple
      ? { role: 'tabpanel', 'aria-labelledby': `${id}-tab-${index}` } : {})}>
      <CardHead kind={selected.kind} state="pending"
        source={selected.kind === 'elicitation' ? selected.request.source : undefined} actions={handlers.actions} />
      <div className="chat-decision-body" key={pendingDecisionKey(selected)}><PendingBody decision={selected} {...handlers} /></div>
    </div>
    <span className="chat-sr-only" aria-live="polite">{label}</span>
  </div>;
}

function PendingBody({ decision, sessionId, pending, disabled, onChoice, onPlan, onElicitation }: PendingDecisionHandlers & { decision: PendingDecision }) {
  if (decision.kind === 'ask') {
    const request = decision.request;
    return <>
      <MessagePresentation className="chat-ask-q" identity={{ sessionId, kind: 'ask', id: request.requestId }} complete>
        <MessageBody body={request.question} />
      </MessagePresentation>
      {!!request.choices?.length && <div className="chat-ask-choices" data-layout="column">
        {request.choices.map(choice => <Button key={choice} className="chat-ask-choice"
          disabled={pending || disabled.ask} onClick={() => onChoice(request.requestId, choice)}>
          <MarkdownLabel body={choice} />
        </Button>)}
      </div>}
    </>;
  }
  if (decision.kind === 'plan') {
    const request = decision.request;
    return <>
      <div className="chat-pending-summary"><MessageBody body={request.summary} /></div>
      {request.planContent && <DisclosureSection className="chat-pending-detail" label="查看完整计划" name="完整计划">
        <pre className="chat-pending-pre">{request.planContent}</pre>
      </DisclosureSection>}
      {!!request.actions?.length && <div className="chat-ask-choices" data-layout="column">
        {request.actions.map(action => <Button key={action} className="chat-ask-choice"
          variant={action === request.recommendedAction ? 'primary' : 'default'}
          disabled={pending || disabled.plan} onClick={() => onPlan(request.requestId, action)}>
          {PLAN_ACTION_LABEL[action]}{action === request.recommendedAction && '（推荐）'}
        </Button>)}
      </div>}
      {!request.actions?.length && <div className="chat-pending-hint" role="status">
        {request.actions ? 'Copilot 未提供可用的计划操作。' : '计划操作列表不可用。'}
      </div>}
    </>;
  }
  const request = decision.request;
  return <>
    <div className="chat-ask-q">{request.message}</div>
    <div className="chat-ask-choices">
      {(request.actions ?? ['accept', 'decline', 'cancel']).map(action => <Button key={action}
        className="chat-ask-choice" disabled={pending || disabled.elicitation} onClick={() => onElicitation(request, action)}>
        {ELICITATION_ACTION_LABEL[action]}
      </Button>)}
    </div>
  </>;
}

function Answer({ label, children }: { label: string; children: ReactNode }) {
  return <div className="chat-decision-answer">
    <Icon name="success" size={16} />
    <div className="chat-decision-answer-text"><small>{label}</small>{children}</div>
  </div>;
}

export function AnsweredAskCard({ question, children }: { question?: string; children: ReactNode }) {
  return <div className="chat-decision-card" data-state="done" data-kind="ask" role="group" aria-label="已回答的问题">
    <CardHead kind="ask" state="done" />
    <div className="chat-decision-body">
      <div className="chat-ask-q" aria-label="回答的问题">
        {question ? <MessageBody body={question} /> : '原问题记录不可用'}
      </div>
      <Answer label="你的回答">{children}</Answer>
    </div>
  </div>;
}

export function AnsweredPlanCard({ summary, result }: { summary?: string; result: string }) {
  const feedback = /^修改意见：([\s\S]*)$/.exec(result)?.[1];
  const chosen = /^已批准：([\s\S]*)$/.exec(result)?.[1];
  return <div className="chat-decision-card" data-state="done" data-kind="plan" role="group" aria-label="已确认的计划">
    <CardHead kind="plan" state="done" status={feedback !== undefined ? '已提交修改意见' : result === '未批准计划' ? '未批准' : undefined} />
    <div className="chat-decision-body">
      {summary ? <div className="chat-pending-summary"><MessageBody body={summary} /></div>
        : <div className="chat-ask-q">计划摘要记录不可用</div>}
      <Answer label={feedback !== undefined ? '你提交了修改意见' : chosen !== undefined ? '你选择了' : '结果'}>
        <span className="chat-decision-answer-body">{feedback ?? chosen ?? result}</span>
      </Answer>
    </div>
  </div>;
}

export function AnsweredElicitationCard({ message, source, action }: { message: string; source?: string; action?: ElicitationAction }) {
  return <div className="chat-decision-card" data-state="done" data-kind="elicitation" role="group" aria-label="已处理的工具请求">
    <CardHead kind="elicitation" state="done" source={source} />
    <div className="chat-decision-body">
      <div className="chat-ask-q">{message}</div>
      {action && <Answer label="你选择了">{ELICITATION_ACTION_LABEL[action]}</Answer>}
    </div>
  </div>;
}
