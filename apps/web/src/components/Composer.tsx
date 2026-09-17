// The text editor owns neither file transfer nor dictation. Per-session draft
// revisions protect edits made while an earlier native send is settling.
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ComponentProps } from 'react';
import type { SessionDraft } from '../lib/textDraft';
import { Icon } from './Icon';
import type { ComposerProps as PublicComposerProps } from '@cockpit/module-api';
import { ModuleRuntimeProvider, useModuleElement, useModuleRuntime } from './ModuleComponents';
import type { ModuleRuntime } from '../lib/moduleRuntime';
import { AskContent } from './PendingDecision';
import { pickComposerFiles } from '../lib/composerFiles';

function shouldSubmitOnEnter(): boolean {
  return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
}
export function ComposerNotices({ draft }: { draft: SessionDraft }) {
  const { unconfirmed } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  return <>
    {unconfirmed && <div className="chat-input-notice" role="alert" tabIndex={0}>
      <span>发送或草稿确认尚未完整完成，重发前请先检查会话。</span>
      <button type="button" className="ck-icon-button" onClick={draft.dismissNotice} aria-label="关闭发送提示"><Icon name="close" size={20} /></button>
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
  ask?: Omit<ComponentProps<typeof AskContent>, 'pending' | 'sessionId' | 'runtime'>;
  statusInHeader?: boolean;
  editorRef?: PublicComposerProps['editorRef'];
}
export function Composer({ runtime, ...props }: ComposerProps) {
  const inherited = useModuleRuntime();
  return <ModuleRuntimeProvider runtime={runtime ?? inherited}><ComposerController {...props} /></ModuleRuntimeProvider>;
}
function ComposerController({ disabled = false, busy = false, placeholder, submitLabel, draft, onSend, sendBlocked = false, ask, statusInHeader, editorRef }: ComposerProps) {
  const { pending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const runtime = useModuleRuntime();
  const prepared = useSyncExternalStore(runtime.subscribe,
    () => runtime.isDraftPrepared(draft), () => runtime.isDraftPrepared(draft));
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
    if (active.current === draft && !current.current.disabled) draft.edit(next);
  }, [draft]);
  const submit = useCallback(() => {
    const options = current.current;
    const state = draft.getSnapshot();
    if (active.current !== draft || options.disabled || options.sendBlocked || state.pending || state.blocks.length
      || draft.isRetired() || !state.hasContent) return;
    void options.onSend();
  }, [draft]);
  const props: PublicComposerProps = { draft: draft.reference, disabled, busy, placeholder, submitLabel,
    sendBlocked, operation, statusInHeader, editorRef, onTextChange: update, onSubmit: submit,
    children: ask && draft.reference.purpose.kind === 'ask' && draft.reference.purpose.requestId === ask.request.requestId
      ? <AskContent {...ask} sessionId={draft.sessionId} pending={pending} /> : undefined,
  };
  return prepared ? <ComposerPresentation {...props} /> : <ComposerBase {...props} />;
}
function ComposerPresentation(props: PublicComposerProps) {
  return useModuleElement('composer', ComposerBase, props);
}

function ComposerBase({ draft, operation, disabled, busy, placeholder, submitLabel, sendBlocked, statusInHeader, editorRef,
  onTextChange, onSubmit, onFiles, actions, children }: PublicComposerProps) {
  const { text, hasContent, blocks, pending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const runtime = useModuleRuntime();
  const inputDisabled = disabled || pending || !onFiles;
  const blockedReason = blocks.map(block => block.reason).join('；');
  const canSend = hasContent && !disabled && !sendBlocked && !pending && !blocks.length;
  const submit = () => {
    if (canSend) onSubmit();
  };
  const target = { draft, operation, disabled };
  return <div className="chat-composer" data-question={operation === 'ask' || undefined}>
    <div className="chat-composer-body">
      <div className="chat-composer-context">
        {children}
      </div>
      <div className="chat-input"
        onDragOver={event => {
          if (event.defaultPrevented) return;
          if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = inputDisabled ? 'none' : 'copy'; }
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
        <textarea ref={editorRef} className="chat-input-message ck-input" aria-label="消息输入" value={text}
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
