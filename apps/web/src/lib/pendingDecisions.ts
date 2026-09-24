import type { ExitPlanModeAction, PendingDecision, SessionMeta } from '@cockpit/protocol';

export type { PendingDecision };

export const PLAN_ACTION_LABEL: Record<ExitPlanModeAction, string> = {
  interactive: '开始执行（交互）',
  autopilot: '自动执行',
  autopilot_fleet: '并行执行（fleet）',
  exit_only: '仅退出计划',
};

export type DecisionSource = Pick<SessionMeta, 'ask' | 'planRequest' | 'elicitation' | 'decisions'>;

// Every pending decision in arrival order. Older hosts only publish the first
// request of each kind, so their singular fields remain the fallback.
export function pendingDecisions(session: Partial<DecisionSource>): PendingDecision[] {
  if (session.decisions) return session.decisions;
  return [
    ...(session.ask ? [{ kind: 'ask' as const, request: session.ask }] : []),
    ...(session.planRequest ? [{ kind: 'plan' as const, request: session.planRequest }] : []),
    ...(session.elicitation ? [{ kind: 'elicitation' as const, request: session.elicitation }] : []),
  ];
}

export const pendingDecisionKey = (decision: { kind: string; request: { requestId: string } }): string =>
  `${decision.kind}:${decision.request.requestId}`;

export function findPendingDecision<K extends PendingDecision['kind']>(
  session: Partial<DecisionSource>, kind: K, requestId: string,
): Extract<PendingDecision, { kind: K }> | undefined {
  return pendingDecisions(session).find((decision): decision is Extract<PendingDecision, { kind: K }> =>
    decision.kind === kind && decision.request.requestId === requestId);
}
