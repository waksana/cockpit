// The text editor owns neither file transfer nor dictation. Per-session draft
// revisions protect edits made while an earlier native send is settling.
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ComponentProps } from 'react';
import type { SessionDraft } from '../lib/textDraft';
import { Icon } from './Icon';
import type { ComposerOperation, ComposerProps as PublicComposerProps } from '@cockpit/module-api';
import { Attachment, ModuleRuntimeProvider, useModuleElement, useModuleRuntime } from './ModuleComponents';
import { moduleRuntime, type ModuleRuntime } from '../lib/moduleRuntime';
import { AskContent } from './PendingDecision';
import { pickComposerFiles } from '../lib/composerFiles';
import { resolveDraft } from '../lib/textDraft';

function shouldSubmitOnEnter(): boolean {
  return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
}
export function ComposerNotices({ draft, operation }: { draft: SessionDraft; operation: ComposerOperation }) {
  const { unconfirmed, attachments } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  return <>
    {unconfirmed && <div className="chat-input-notice" role="alert" tabIndex={0}>
      <span>发送失败或结果尚未确认，草稿已保留；重发前请先检查会话。</span>
      <button type="button" className="ck-icon-button" onClick={draft.dismissNotice} aria-label="关闭发送提示"><Icon name="close" size={20} /></button>
    </div>}
    {attachments.length > 0 && operation !== 'prompt' && <div className="chat-input-notice" role="alert">
      当前回答或确认操作不接受附件，请先移除附件；草稿已保留。
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
  operation?: ComposerOperation;
  runtime?: ModuleRuntime;
  ask?: Omit<ComponentProps<typeof AskContent>, 'pending' | 'sessionId' | 'runtime'>;
  statusInHeader?: boolean;
}
export function Composer({ runtime = moduleRuntime, ...props }: ComposerProps) {
  return <ModuleRuntimeProvider runtime={runtime}><ComposerController {...props} /></ModuleRuntimeProvider>;
}
function ComposerController({ disabled = false, busy = false, placeholder, submitLabel, draft, onSend, sendBlocked = false, operation = 'prompt', ask, statusInHeader }: ComposerProps) {
  const { attachments, pending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const runtime = useModuleRuntime();
  const active = useRef<SessionDraft | null>(null);
  const current = useRef({ disabled, sendBlocked, operation, onSend });
  useLayoutEffect(() => {
    active.current = draft;
    return () => { active.current = null; };
  }, [draft]);
  useLayoutEffect(() => { current.current = { disabled, sendBlocked, operation, onSend }; });
  const update = useCallback((next: string) => {
    if (active.current === draft && !current.current.disabled) draft.edit(next);
  }, [draft]);
  const submit = useCallback(() => {
    const options = current.current;
    const state = draft.getSnapshot();
    if (active.current !== draft || options.disabled || options.sendBlocked || state.pending || state.blocks.length
      || (options.operation !== 'prompt' && state.attachments.length) || (!state.text.trim() && !state.attachments.length)) return;
    void options.onSend();
  }, [draft]);
  return <ComposerPresentation draft={draft.reference} disabled={disabled} busy={busy} placeholder={placeholder}
    submitLabel={submitLabel} sendBlocked={sendBlocked} operation={operation} statusInHeader={statusInHeader}
    onTextChange={update} onSubmit={submit}
    attachments={attachments.length ? <div className="draft-attachments" role="group" aria-label="附件">
      {attachments.map(item => <Attachment key={item.id} source={{ kind: 'draft', draft: draft.reference, id: item.id }}
        attachment={item.value} label={item.value.displayName || ('path' in item.value ? item.value.path : item.value.type === 'selection' ? item.value.filePath : '附件')}
        disabled={disabled || pending} pending={pending}
        onRemove={() => {
          try {
            if (active.current !== draft || current.current.disabled || draft.getSnapshot().pending
              || !draft.getSnapshot().attachments.includes(item)) return false;
            draft.removeAttachment(item.id);
            return !draft.getSnapshot().attachments.includes(item);
          } catch (error) {
            runtime.report(error);
            return false;
          }
        }}>
        <span>{item.value.displayName || ('path' in item.value ? item.value.path : item.value.type === 'selection' ? item.value.filePath : '附件')}</span>
      </Attachment>)}
    </div> : undefined}>
    {ask && <AskContent {...ask} sessionId={draft.sessionId} pending={pending} />}
  </ComposerPresentation>;
}
function ComposerPresentation(props: PublicComposerProps) {
  return useModuleElement('composer', ComposerBase, props);
}

function ComposerBase({ draft, operation, disabled, busy, placeholder, submitLabel, sendBlocked, statusInHeader,
  onTextChange, onSubmit, onFiles, actions, children, attachments: attachmentContent }: PublicComposerProps) {
  const { text, attachments, blocks, pending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const runtime = useModuleRuntime();
  const attachmentRouteBlocked = attachments.length > 0 && operation !== 'prompt';
  const attachmentsDisabled = disabled || pending || operation !== 'prompt';
  const blockedReason = blocks.map(block => block.reason).join('；');
  const canSend = (!!text.trim() || !!attachments.length) && !disabled && !sendBlocked && !pending && !blocks.length && !attachmentRouteBlocked;
  const submit = () => {
    if (canSend) onSubmit();
  };
  const target = { draft, operation, disabled };
  return <div className="chat-composer" data-question={operation === 'ask' || undefined}>
    <div className="chat-composer-body">
      <div className="chat-composer-context">
        {children}
        {blocks.filter(block => block.orphaned).map(block => <div className="module-draft-recovery" role="status" key={block.id}>
          <span>{block.reason}</span>
          <button className="module-block-remove ck-button" type="button" onClick={() => resolveDraft(draft).dismissOrphanedBlock(block.id)}>移除未完成的选择</button>
        </div>)}
        {attachmentContent}
      </div>
      <div className="chat-input"
        onDragOver={event => {
          if (event.defaultPrevented) return;
          if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = attachmentsDisabled ? 'none' : 'copy'; }
        }}
        onDrop={event => {
          if (event.defaultPrevented) return;
          const files = Array.from(event.dataTransfer.files);
          if (!files.length) return;
          event.preventDefault();
          runtime.receiveFiles(files, target, 'drop', onFiles);
        }}
        onPaste={event => {
          if (event.defaultPrevented) return;
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          // Keep mixed clipboard text and the textarea's native insertion/IME behavior.
          if (!event.clipboardData.getData('text/plain')) event.preventDefault();
          runtime.receiveFiles(files, target, 'paste', onFiles);
        }}>
        {actions?.({ pickFiles: () => pickComposerFiles(runtime, target, onFiles) })}
        <textarea className="chat-input-message ck-input" aria-label="消息输入" value={text}
          disabled={disabled} onChange={event => onTextChange(event.target.value)} placeholder={placeholder ?? '输入消息…'} rows={1}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); return; }
            if (event.key === 'Enter' && !event.shiftKey && shouldSubmitOnEnter()) { event.preventDefault(); submit(); }
          }} />
        <button type="button" className="chat-input-btn ck-icon-button send rp" disabled={!canSend} onClick={submit}
          aria-label={pending ? '正在提交' : submitLabel ?? (busy ? '排队发送' : '发送')} aria-busy={pending}
          title={pending ? '正在提交，草稿仍可编辑' : blockedReason || (submitLabel ?? (busy ? '加入队列' : '发送'))}>
          <Icon name={pending && !statusInHeader ? 'sending' : 'arrow_up'} size={24} />
        </button>
      </div>
    </div>
  </div>;
}
