// The text editor owns neither file transfer nor dictation. Per-session draft
// revisions protect edits made while an earlier native send is settling.
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { SessionDraft } from '../lib/textDraft';
import { Icon } from './Icon';

function shouldSubmitOnEnter(): boolean {
  return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
}
interface ComposerProps {
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  draft: SessionDraft;
  onSend: () => Promise<boolean>;
  sendBlocked?: boolean;
}
export function Composer({ disabled, busy, placeholder, draft, onSend, sendBlocked }: ComposerProps) {
  const { text, pending, unconfirmed } = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, [draft]);
  const update = useCallback((next: string) => {
    if (active.current) draft.edit(next);
  }, [draft]);
  const canSend = !!text.trim() && !disabled && !sendBlocked && !pending;
  const submit = () => {
    if (!active.current || !canSend || draft.getSnapshot().pending) return;
    void onSend();
  };
  return <>
    {unconfirmed && <div className="chat-input-notice" role="alert" tabIndex={0}>
      <span>发送失败或结果尚未确认，草稿已保留；重发前请先检查会话。</span>
      <button type="button" onClick={draft.dismissNotice} aria-label="关闭发送提示"><Icon name="close" size={18} /></button>
    </div>}
    <div className="chat-input">
      <textarea className="chat-input-message" aria-label="消息输入" value={text}
        disabled={disabled} onChange={event => update(event.target.value)} placeholder={placeholder ?? '输入消息…'} rows={1}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); return; }
          if (event.key === 'Enter' && !event.shiftKey && shouldSubmitOnEnter()) { event.preventDefault(); submit(); }
        }} />
      <button type="button" className="chat-input-btn send rp" disabled={!canSend} onClick={submit}
        aria-label={pending ? '正在提交' : busy ? '排队发送' : '发送'} aria-busy={pending}
        title={pending ? '正在提交，草稿仍可编辑' : busy ? '加入队列' : '发送'}>
        <Icon name={pending ? 'sending' : 'arrow_up'} size={22} />
      </button>
    </div>
  </>;
}
