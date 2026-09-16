// The text editor owns neither file transfer nor dictation. Per-session draft
// revisions protect edits made while an earlier native send is settling.
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ComponentProps } from 'react';
import type { SessionDraft } from '../lib/textDraft';
import { Icon } from './Icon';
import type { ComposerContext } from '@cockpit/module-api';
import { ModuleContributions } from './ModuleContributions';
import { moduleRuntime, type ModuleRuntime } from '../lib/moduleRuntime';
import { AskContent } from './PendingDecision';

function shouldSubmitOnEnter(): boolean {
  return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
}
export function ComposerNotices({ draft, operation }: { draft: SessionDraft; operation: ComposerContext['operation'] }) {
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
  operation?: ComposerContext['operation'];
  runtime?: ModuleRuntime;
  ask?: Omit<ComponentProps<typeof AskContent>, 'pending'>;
  statusInHeader?: boolean;
}
export function Composer({ disabled, busy, placeholder, submitLabel, draft, onSend, sendBlocked, operation = 'prompt', runtime = moduleRuntime, ask, statusInHeader }: ComposerProps) {
  const { text, attachments, blocks, pending } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const modules = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, [draft]);
  const update = useCallback((next: string) => {
    if (active.current) draft.edit(next);
  }, [draft]);
  const attachmentRouteBlocked = attachments.length > 0 && operation !== 'prompt';
  const attachmentsDisabled = !!disabled || pending;
  const hasAttachmentRenderer = modules.some(module => module.frontend.rendersDraftAttachments);
  const blockedReason = blocks.map(block => block.reason).join('；');
  const canSend = (!!text.trim() || !!attachments.length) && !disabled && !sendBlocked && !pending && !blocks.length && !attachmentRouteBlocked;
  const submit = () => {
    if (!active.current || !canSend || draft.getSnapshot().pending || draft.getSnapshot().blocks.length) return;
    void onSend();
  };
  return <div className="chat-composer" data-question={!!ask || undefined}>
    <div className="chat-composer-body">
      <div className="chat-composer-context">
        {ask && <AskContent {...ask} pending={pending} />}
        {blocks.filter(block => block.orphaned).map(block => <div className="module-draft-recovery" role="status" key={block.id}>
          <span>{block.reason}</span>
          {block.orphaned && <button className="module-block-remove ck-button" type="button" onClick={() => draft.dismissOrphanedBlock(block.id)}>移除未完成的选择</button>}
        </div>)}
        <ModuleContributions slot="composerAbove" draft={draft} operation={operation} disabled={attachmentsDisabled} runtime={runtime} />
        {!!attachments.length && !hasAttachmentRenderer && <div className="module-draft-attachments" role="group" aria-label="附件">
          {attachments.map(item => <div key={item.id}>
            <span>{item.value.displayName || ('path' in item.value ? item.value.path : item.value.type === 'selection' ? item.value.filePath : '附件')}</span>
            <button type="button" className="ck-button" disabled={attachmentsDisabled} onClick={() => {
              if (!draft.getSnapshot().pending) draft.removeAttachment(item.id);
            }} aria-label="移除附件">移除</button>
          </div>)}
        </div>}
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
          if (active.current) runtime.receive(files, draft, operation, attachmentsDisabled);
        }}
        onPaste={event => {
          if (event.defaultPrevented) return;
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          // Keep mixed clipboard text and the textarea's native insertion/IME behavior.
          if (!event.clipboardData.getData('text/plain')) event.preventDefault();
          if (active.current) runtime.receive(files, draft, operation, attachmentsDisabled);
        }}>
        <ModuleContributions slot="composerActions" draft={draft} operation={operation} disabled={attachmentsDisabled} runtime={runtime} />
        <textarea className="chat-input-message ck-input" aria-label="消息输入" value={text}
          disabled={disabled} onChange={event => update(event.target.value)} placeholder={placeholder ?? '输入消息…'} rows={1}
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
