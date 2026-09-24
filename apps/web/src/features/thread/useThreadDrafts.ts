import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ChatSession } from '../../net/types';
import type { NativeDraftRequest } from '../../lib/draft';
import { getDraftSession } from '../../lib/draftSelection';
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
  const ask = session.ask;
  const askId = ask?.requestId, planId = session.planRequest?.requestId, elicitationId = session.elicitation?.requestId;
  const decisions = useMemo(() => ({
    loaded: session.loaded,
    ask,
    planRequest: planId !== undefined ? { requestId: planId } : null,
    elicitation: elicitationId !== undefined ? { requestId: elicitationId } : null,
  }), [ask, planId, elicitationId, session.loaded]);
  const draft = useMemo(() => {
    void draftRevision;
    return drafts.current(decisions, authoritative);
  }, [drafts, decisions, authoritative, draftRevision]);
  useLayoutEffect(() => { drafts.synchronize(decisions, authoritative); }, [drafts, decisions, authoritative]);
  const askDraft = askId !== undefined ? drafts.candidate({ kind: 'ask', requestId: askId }) : undefined;
  const planDraft = planId !== undefined ? drafts.candidate({ kind: 'plan', requestId: planId }) : undefined;
  const elicitationDraft = elicitationId !== undefined ? drafts.candidate({ kind: 'elicitation', requestId: elicitationId }) : undefined;
  useLayoutEffect(() => { runtime.prepareDraft(draft, readOnly); }, [runtime, draft, readOnly]);
  const canAct = useRef(false);
  useLayoutEffect(() => {
    canAct.current = authoritative && !readOnly;
    return () => { canAct.current = false; };
  }, [session.sessionId, authoritative, readOnly]);
  const { pending: actionPending, hasContent } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);

  const runAction = useCallback((target: SessionDraft, send: () => Promise<boolean> | undefined): Promise<boolean> => (
    target.runAction(send, () => canAct.current && drafts.isLive(target))
  ), [drafts]);

  // A composer send answers a pending ask (respondAsk), submits feedback on
  // a pending plan (planSupersede), or otherwise sends a normal prompt.
  const handleSend = useCallback((): Promise<boolean> => draft.send(
    request => onSend?.(request) ?? Promise.resolve(false), () => canAct.current && drafts.isCurrent(draft),
  ), [draft, drafts, onSend]);

  const handleChoice = useCallback((choice: string): Promise<boolean> => {
    if (!ask || !askDraft) return Promise.resolve(false);
    return runAction(askDraft, () => onRespondAsk?.(ask.requestId, choice, false));
  }, [ask, askDraft, onRespondAsk, runAction]);

  const decisionKey = askId ? `ask:${askId}` : planId ? `plan:${planId}` : elicitationId ? `elicitation:${elicitationId}` : undefined;
  return { draft, planDraft, elicitationDraft, actionPending, hasContent, decisionKey, runAction, handleSend, handleChoice };
}
