// The text editor owns neither file transfer nor dictation. Per-session draft
// revisions protect edits made while an earlier native send is settling.
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { SessionDraft } from '../lib/textDraft';
import { Icon } from './Icon';
import type { ComposerContext } from '@cockpit/module-api';
import { ModuleContributions } from './ModuleContributions';
import { moduleRuntime, type ModuleRuntime } from '../lib/moduleRuntime';

function shouldSubmitOnEnter(): boolean {
  return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
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
}
export function Composer({ disabled, busy, placeholder, submitLabel, draft, onSend, sendBlocked, operation = 'prompt', runtime = moduleRuntime }: ComposerProps) {
  const { text, attachments, blocks, pending, unconfirmed } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
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
  const canSend = (!!text.trim() || !!attachments.length) && !disabled && !sendBlocked && !pending && !blocks.length && !attachmentRouteBlocked;
  const submit = () => {
    if (!active.current || !canSend || draft.getSnapshot().pending || draft.getSnapshot().blocks.length) return;
    void onSend();
  };
  return <div className="chat-composer">
    <div className="chat-composer-context">
      {unconfirmed && <div className="chat-input-notice" role="alert" tabIndex={0}>
        <span>发送失败或结果尚未确认，草稿已保留；重发前请先检查会话。</span>
        <button type="button" onClick={draft.dismissNotice} aria-label="关闭发送提示"><Icon name="close" size={18} /></button>
      </div>}
      {attachmentRouteBlocked && <div className="chat-input-notice" role="alert">当前回答或确认操作不接受附件，请先移除附件；草稿已保留。</div>}
      {blocks.map(block => <div className="chat-input-notice" role="status" key={block.id}>
        <span>{block.reason}</span>
        {block.orphaned && <button className="module-block-remove" type="button" onClick={() => draft.dismissOrphanedBlock(block.id)}>移除未完成的选择</button>}
      </div>)}
      <ModuleContributions slot="composerAbove" draft={draft} operation={operation} disabled={!!disabled} runtime={runtime} />
      {!!attachments.length && <details className="module-draft-attachments" open={!modules.some(module => module.frontend.composerAbove?.length)}>
        <summary>{attachments.length} 个原生附件</summary>
        {attachments.map(item => <div key={item.id}>
          <span>{item.value.displayName || ('path' in item.value ? item.value.path : item.value.type === 'selection' ? item.value.filePath : '附件')}</span>
          <button type="button" disabled={disabled} onClick={() => draft.removeAttachment(item.id)} aria-label="移除附件">移除</button>
        </div>)}
      </details>}
    </div>
    <div className="chat-input"
      onDragOver={event => {
        if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }
      }}
      onDrop={event => {
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault();
        if (active.current) runtime.receive(files, draft, operation, !!disabled);
      }}
      onPaste={event => {
        const files = Array.from(event.clipboardData.files);
        if (!files.length) return;
        // Keep mixed clipboard text and the textarea's native insertion/IME behavior.
        if (!event.clipboardData.getData('text/plain')) event.preventDefault();
        if (active.current) runtime.receive(files, draft, operation, !!disabled);
      }}>
      <ModuleContributions slot="composerActions" draft={draft} operation={operation} disabled={!!disabled} runtime={runtime} />
      <textarea className="chat-input-message" aria-label="消息输入" value={text}
        disabled={disabled} onChange={event => update(event.target.value)} placeholder={placeholder ?? '输入消息…'} rows={1}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); return; }
          if (event.key === 'Enter' && !event.shiftKey && shouldSubmitOnEnter()) { event.preventDefault(); submit(); }
        }} />
      <button type="button" className="chat-input-btn send rp" disabled={!canSend} onClick={submit}
        aria-label={pending ? '正在提交' : submitLabel ?? (busy ? '排队发送' : '发送')} aria-busy={pending}
        title={pending ? '正在提交，草稿仍可编辑' : submitLabel ?? (busy ? '加入队列' : '发送')}>
        <Icon name={pending ? 'sending' : 'arrow_up'} size={22} />
      </button>
    </div>
  </div>;
}
