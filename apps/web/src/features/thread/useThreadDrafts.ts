import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ChatSession } from '../../net/types';
import type { NativeDraftRequest } from '../../lib/draft';
import { getDraftSession } from '../../lib/draftSelection';
import { pendingDecisions, pendingDecisionKey, type PendingDecision } from '../../lib/pendingDecisions';
import type { SessionDraft } from '../../lib/textDraft';
import { useModuleRuntime } from '../../components/ModuleComponents';

// Purpose-owned drafts for the prompt and each pending decision. Actions only
// run while this view is authoritative and the target draft is still live.
export function useThreadDrafts(session: ChatSession, { readOnly, authoritative, onSend, onRespondAsk }: {
  readOnly: boolean; authoritative: boolean;
  onSend?: (request: NativeDraftRequest) => Promise<boolean>;
  onRespondAsk?: (requestId: string, answer: string, wasFreeform: boolean) => Promise<boolean>;
}) {
  const drafts = useMemo(() => getDraftSession(session.sessionId), [session.sessionId]);
  const runtime = useModuleRuntime();
  useLayoutEffect(() => { runtime.prepareDraft(drafts.prompt, readOnly); }, [runtime, drafts, readOnly]);
  const draftRevision = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot, drafts.getSnapshot);
  const { decisions: list, ask, planRequest, elicitation, loaded } = session;
  const pending = useMemo(() => pendingDecisions({ decisions: list, ask, planRequest, elicitation }),
    [list, ask, planRequest, elicitation]);
  const decisions = useMemo(() => ({ loaded, decisions: pending }), [pending, loaded]);
  const draft = useMemo(() => {
    void draftRevision;
    return drafts.current(decisions, authoritative);
  }, [drafts, decisions, authoritative, draftRevision]);
  useLayoutEffect(() => { drafts.synchronize(decisions, authoritative); }, [drafts, decisions, authoritative]);
  useLayoutEffect(() => { runtime.prepareDraft(draft, readOnly); }, [runtime, draft, readOnly]);
  const canAct = useRef(false);
  useLayoutEffect(() => {
    canAct.current = authoritative && !readOnly;
    return () => { canAct.current = false; };
  }, [session.sessionId, authoritative, readOnly]);
  const { pending: actionPending, hasContent } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);

  const draftFor = useCallback((decision: PendingDecision): SessionDraft => (
    drafts.candidate({ kind: decision.kind, requestId: decision.request.requestId })
  ), [drafts]);
  // Handlers capture this render's drafts, so a saved callback cannot answer a
  // later occurrence that reuses the same native request ID.
  const draftOf = useMemo(() => {
    const byKey = new Map(pending.map(decision => [pendingDecisionKey(decision), draftFor(decision)]));
    return (kind: PendingDecision['kind'], requestId: string) => byKey.get(pendingDecisionKey({ kind, request: { requestId } }));
  }, [pending, draftFor]);
  const purpose = draft.reference.purpose;
  const selected = purpose.kind === 'prompt' ? undefined
    : pending.find(decision => decision.kind === purpose.kind && decision.request.requestId === purpose.requestId);
  const select = useCallback((decision: PendingDecision) => {
    drafts.select({ kind: decision.kind, requestId: decision.request.requestId });
  }, [drafts]);

  const runAction = useCallback((target: SessionDraft, send: () => Promise<boolean> | undefined): Promise<boolean> => (
    target.runAction(send, () => canAct.current && drafts.isLive(target))
  ), [drafts]);

  // A composer send answers the selected ask (respondAsk), submits feedback on
  // the selected plan (planSupersede), or otherwise sends a normal prompt.
  const handleSend = useCallback((): Promise<boolean> => draft.send(
    request => onSend?.(request) ?? Promise.resolve(false), () => canAct.current && drafts.isCurrent(draft),
  ), [draft, drafts, onSend]);

  const handleChoice = useCallback((requestId: string, choice: string): Promise<boolean> => {
    const target = draftOf('ask', requestId);
    if (!target) return Promise.resolve(false);
    return runAction(target, () => onRespondAsk?.(requestId, choice, false));
  }, [draftOf, onRespondAsk, runAction]);

  const decisionKey = selected ? pendingDecisionKey(selected) : undefined;
  return { draft, pending, selected, select, draftOf, actionPending, hasContent, decisionKey, runAction, handleSend, handleChoice };
}
