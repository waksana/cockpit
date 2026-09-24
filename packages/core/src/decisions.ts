import { randomUUID } from 'node:crypto';
import type { ExitPlanModeAction } from '@cockpit/protocol';
import { invalid, notPending } from './errors.ts';
import type { SessionKernel } from './kernel.ts';
import type { Decision, DecisionKind, InterruptTarget, SessionHandle } from './session-handle.ts';

/** Pending native ask/plan/elicitation callbacks and their answers. */
export class DecisionBroker {
  private readonly k: SessionKernel;

  constructor(k: SessionKernel) {
    this.k = k;
  }

  decision<T>(st: SessionHandle, kind: DecisionKind, fields: object, validate?: (value: T) => void): Promise<T> {
    if (this.k.failure) return Promise.reject(this.k.failure);
    if (st.closing || st.cancelling || this.k.lifecycle) return Promise.reject(new Error('Session is closing or cancelling'));
    const requestId = randomUUID();
    return new Promise<T>((answer, reject) => {
      st.decisions.set(requestId, {
        kind, epoch: st.turnEpoch, interactionId: st.interactionId,
        value: { ...fields, requestId } as Decision['value'],
        answer: value => answer(value as T), reject,
        validate: validate ? value => validate(value as T) : undefined,
      });
      this.k.projectDecisions(st);
    });
  }

  answer(st: SessionHandle, requestId: string, kind: DecisionKind, value: unknown): void {
    const pending = st.decisions.get(requestId);
    if (!pending || pending.kind !== kind) throw notPending('Request is no longer pending');
    pending.validate?.(value);
    st.decisions.delete(requestId);
    pending.answer(value);
    this.k.projectDecisions(st);
  }

  clearInterruptedTurn(st: SessionHandle, target: InterruptTarget): void {
    for (const [id, decision] of target.decisions) {
      if (st.decisions.get(id) !== decision) continue;
      decision.reject(new Error('Native main turn interrupted'));
      st.decisions.delete(id);
    }
    target.decisions.clear();
    this.k.projectDecisions(st);
    if (st.turnEpoch !== target.epoch) return;
    st.interruptedEpoch = target.epoch;
  }

  async respondAsk(id: string, requestId: string, answer: string, wasFreeform: boolean): Promise<void> {
    this.answerPending(id, requestId, 'ask', { answer, wasFreeform });
  }

  async respondPlan(id: string, requestId: string, action: ExitPlanModeAction): Promise<void> {
    this.answerPending(id, requestId, 'planRequest', { approved: true, selectedAction: action });
  }

  async respondElicitation(id: string, requestId: string, action: 'accept' | 'decline' | 'cancel'): Promise<void> {
    this.answerPending(id, requestId, 'elicitation', { action });
  }

  async planSupersede(id: string, requestId: string, message: string): Promise<void> {
    if (!message.trim()) throw invalid('Plan feedback must not be empty');
    this.answerPending(id, requestId, 'planRequest', { approved: false, feedback: message });
  }

  private answerPending(id: string, requestId: string, kind: DecisionKind, value: unknown): void {
    this.k.assertAvailable();
    const st = this.k.sessions.get(id);
    if (!st || st.closing || st.cancelling || this.k.lifecycle) throw notPending('Request is no longer pending or session is transitioning');
    this.answer(st, requestId, kind, value);
  }
}
