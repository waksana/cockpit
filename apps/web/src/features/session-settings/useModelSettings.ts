import { useRef, useState } from 'react';
import { classifyNativeModelSwitchResult, type IntentResult } from '@cockpit/protocol';
import type { ChatSession } from '../../net/types';
import { useKeyedAction } from '../../lib/useKeyedResource';
import { useHostUnsavedChanges } from '../../lib/hostLeave';

export type ContextTier = 'default' | 'long_context';
export type ModelSelection = { modelId: string; reasoningEffort?: string; contextTier?: ContextTier };
export type SetModel = (modelId: string, options?: Omit<ModelSelection, 'modelId'>) => Promise<IntentResult<'setModel'>>;
export const selectionFrom = (session: ChatSession): ModelSelection => ({
  modelId: session.currentModelId ?? '',
  ...(session.currentReasoningEffort ? { reasoningEffort: session.currentReasoningEffort } : {}),
  ...(session.currentContextTier ? { contextTier: session.currentContextTier } : {}),
});
export function sameModelSelection(a: ModelSelection, b: ModelSelection) {
  return a.modelId === b.modelId && a.reasoningEffort === b.reasoningEffort && a.contextTier === b.contextTier;
}

// Snapshots are current native state, never a replacement for an edited draft.
export function useModelSettings(session: ChatSession, onSetModel: SetModel, disabled: boolean) {
  const [draft, setDraft] = useState<{ selection: ModelSelection; revision: number } | null>(null);
  const [submission, setSubmission] = useState<{ selection: ModelSelection; revision: number } | null>(null);
  const [outcome, setOutcome] = useState<IntentResult<'setModel'> | null>(null);
  const submittedRevision = useRef<number | null>(null);
  const action = useKeyedAction(`model:${session.sessionId}`);
  const selection = draft?.selection ?? selectionFrom(session);
  const revision = draft?.revision ?? 0;
  const edit = (next: ModelSelection) => setDraft({ selection: next, revision: revision + 1 });
  const list = session.availableModels;
  const currentModel = list?.find(model => model.modelId === selection.modelId);
  const efforts = currentModel?.supportedReasoningEfforts ?? [];
  const supportsLong = currentModel?.supportsLongContext ?? false;
  const invalid = !currentModel || (efforts.length > 0 && !!selection.reasoningEffort && !efforts.includes(selection.reasoningEffort));
  const classification = outcome && classifyNativeModelSwitchResult(outcome.result);
  const accepted = classification && ['applied', 'unchanged', 'queued'].includes(classification.state);
  const dirty = !!draft && !sameModelSelection(selection, selectionFrom(session))
    && (submission?.revision !== revision || !accepted);
  useHostUnsavedChanges(dirty);
  const apply = () => {
    if (disabled || invalid || action.busy || submittedRevision.current === revision) return;
    submittedRevision.current = revision;
    const options = {
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      ...(selection.contextTier ? { contextTier: selection.contextTier } : {}),
    };
    setSubmission({ selection, revision });
    setOutcome(null);
    let result: IntentResult<'setModel'>;
    void action.run(async () => { result = await onSetModel(selection.modelId, options); }, () => setOutcome(result));
  };
  return { draft, selection, revision, submission, outcome, action, edit, apply, list, currentModel, efforts, supportsLong, invalid, dirty,
    reset: () => edit(selectionFrom(session)) };
}
