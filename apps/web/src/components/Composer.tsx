// The text editor owns neither file transfer nor dictation. Per-session draft
// revisions protect edits made while an earlier native send is settling.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionDraft } from '../lib/textDraft';
import { Button, IconButton } from './Button';
import type { ComposerProps as PublicComposerProps } from '@cockpit/module-api/frontend';
import { ModuleRuntimeProvider, useModuleElement, useModuleRuntime } from './ModuleComponents';
import type { ModuleRuntime } from '../lib/moduleRuntime';
import { describeReason, reportUxError } from '../lib/errorReporter';
export function ComposerNotices({ draft }: { draft: SessionDraft }) {
  const { unconfirmed, pending, submissionId } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const accepted = draft.hasAcceptedSubmission();
  const [settling, setSettling] = useState<{ draft: SessionDraft; id: string } | undefined>(undefined);
  const inFlight = useRef(new Set<SessionDraft>());
  const recovering = settling?.draft === draft && settling.id === submissionId;
  const busy = pending || recovering;
  const reconcile = () => {
    if (!submissionId || inFlight.current.has(draft) || !draft.hasAcceptedSubmission()
      || draft.getSnapshot().submissionId !== submissionId) return;
    const operation = { draft, id: submissionId };
    inFlight.current.add(draft);
    setSettling(operation);
    void draft.reconcile(submissionId).catch(error => {
      reportUxError(`草稿确认失败：${describeReason(error, false)}`);
    }).finally(() => {
      inFlight.current.delete(draft);
      setSettling(current => current === operation ? undefined : current);
    });
  };
  return <>
    {(unconfirmed || (accepted && recovering)) && <div className="chat-input-notice" role="alert" tabIndex={0}>
      <span>{accepted ? '提交已确认，但草稿清理尚未完成。完成确认不会再次发送。'
        : '发送或草稿确认尚未完整完成，重发前请先检查会话。'}</span>
      {accepted ? <Button disabled={busy || !submissionId} aria-busy={busy} onClick={reconcile}>完成草稿确认</Button>
        : <IconButton icon="close" iconSize={20} label="关闭发送提示" onClick={draft.dismissNotice} />}
    </div>}
  </>;
}
interface ComposerProps {
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  submitLabel?: string;
  draft: SessionDraft;
  onSend: () => Promise<boolean>;
  sendBlocked?: boolean;
  runtime?: ModuleRuntime;
  statusInHeader?: boolean;
  editorRef?: PublicComposerProps['editorRef'];
}
export function Composer({ runtime, ...props }: ComposerProps) {
  const inherited = useModuleRuntime();
  return <ModuleRuntimeProvider runtime={runtime ?? inherited}><ComposerController {...props} /></ModuleRuntimeProvider>;
}
function ComposerController({ disabled = false, busy = false, placeholder, submitLabel, draft, onSend, sendBlocked = false, statusInHeader, editorRef }: ComposerProps) {
  const runtime = useModuleRuntime();
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  useLayoutEffect(() => { runtime.prepareDraft(draft); }, [runtime, draft]);
  const operation = draft.reference.purpose.kind;
  const active = useRef<SessionDraft | null>(null);
  const current = useRef({ disabled, sendBlocked, operation, onSend });
  useLayoutEffect(() => {
    active.current = draft;
    return () => { active.current = null; };
  }, [draft]);
  useLayoutEffect(() => { current.current = { disabled, sendBlocked, operation, onSend }; });
  const update = useCallback((next: string) => {
    const state = draft.getSnapshot();
    if (active.current === draft && !current.current.disabled && state.editable && !state.retired) draft.edit(next);
  }, [draft]);
  const submit = useCallback(() => {
    const options = current.current;
    const state = draft.getSnapshot();
    if (active.current !== draft || options.disabled || options.sendBlocked || state.pending || state.blocks.length
      || !state.editable || !state.submittable || state.unconfirmed || draft.isRetired() || !state.hasContent) return;
    void options.onSend();
  }, [draft]);
  const props: PublicComposerProps = { draft: draft.reference, disabled: disabled || !snapshot.editable || snapshot.retired,
    busy, placeholder, submitLabel, sendBlocked: sendBlocked || !snapshot.submittable || snapshot.unconfirmed,
    operation, statusInHeader, editorRef, onTextChange: update, onSubmit: submit,
  };
  return <ComposerPresentation {...props} />;
}
function ComposerPresentation(props: PublicComposerProps) {
  return useModuleElement('composer', props);
}
