// Compose box — ported from evo-chat's best-tuned chat composer:
//  - CSS-only autoresize textarea (`field-sizing: content`, capped height)
//  - keyboard-glued at the bottom of the visible viewport (data-compose)
//  - desktop Enter-to-send / Shift+Enter newline; mobile Enter=newline, tap send
//  - never submits during IME (CJK) composition
//  - Cmd/Ctrl+Enter always submits
//  - voice dictation (Web Speech API) appended into the text
//
// Draft safety:
//  - every edit is persisted synchronously; unmount never writes a stale draft.
//  - only an acknowledged POST can clear unchanged per-session revisions.
//  - pending submissions block another send, not typing or dictation.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createVoiceController, isVoiceSupported } from '../lib/voice';
import type { VoiceController } from '../lib/voice';
import { stagedAttachments, type SessionDraft, type UploadFile } from '../lib/attachmentSend';
import { attachmentHref } from '../lib/upload';
import { fileDownloadUrl, filePreview } from '../lib/managedFile';
import { useCockpit } from '../net/store';
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
  uploadFile?: UploadFile;
  attachmentBlocked?: boolean;
  sendBlocked?: boolean;
  onFocusPin?: () => void;
}

export function Composer({
  disabled, busy, placeholder, draft, onSend, uploadFile, attachmentBlocked, sendBlocked, onFocusPin,
}: ComposerProps) {
  const snapshot = useSyncExternalStore(
    draft.subscribe, draft.getSnapshot, draft.getSnapshot,
  );
  const { text, pending, error: sendError } = snapshot;
  const attachments = stagedAttachments(snapshot);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const ownerRef = useRef<object | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const voiceRef = useRef<VoiceController | null>(null);
  const voiceSupported = isVoiceSupported();
  const speechToken = useCockpit((s) => s.speechToken);

  useLayoutEffect(() => {
    ownerRef.current = {};
    return () => { ownerRef.current = null; };
  }, [draft]);

  const update = useCallback((next: string) => {
    if (!ownerRef.current) return;
    draft.edit(next);
  }, [draft]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !onFocusPin) return;
    const onFocus = () => requestAnimationFrame(() => onFocusPin());
    ta.addEventListener('focus', onFocus);
    return () => ta.removeEventListener('focus', onFocus);
  }, [onFocusPin]);

  async function submit() {
    const submitted = draft.getSnapshot();
    if (disabled || sendBlocked || submitted.pending || !ownerRef.current
      || (attachmentBlocked && submitted.staged)) return;
    const owner = ownerRef.current;
    const sent = await onSend();
    const current = draft.getSnapshot();
    if (sent && ownerRef.current === owner && !current.text
      && current.revision === submitted.revision + 1) {
      voiceRef.current?.stop();
      setListening(false);
    }
  }

  // Create the voice controller at mount and warm the speech token AHEAD of any
  // tap. iOS requires getUserMedia + AudioContext.resume to run inside the tap
  // gesture (no await first), so the token must already be in hand when start()
  // fires. Errors surface as a transient notice (never a silent no-op).
  useEffect(() => {
    if (!voiceSupported) return;
    const ctrl = createVoiceController({
      onFinal: (chunk) => {
        const prev = draft.getSnapshot().text;
        update(prev ? `${prev}${prev.endsWith(' ') ? '' : ' '}${chunk}` : chunk);
      },
      onStateChange: setListening,
      onError: (msg) => { setVoiceError(msg); setListening(false); },
    }, speechToken);
    ctrl.prepare();
    voiceRef.current = ctrl;
    return () => { ctrl.stop(); voiceRef.current = null; };
  }, [voiceSupported, speechToken, update, draft]);

  function toggleVoice() {
    const ctrl = voiceRef.current;
    if (!ctrl) return;
    setVoiceError(null);
    if (listening) ctrl.stop();
    else ctrl.start();
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0)
    && attachments.every(item => item.status === 'ready' && !attachmentBlocked) && !disabled && !sendBlocked && !pending;

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same file
    if (disabled || !ownerRef.current) return;
    for (const file of files) void draft.addAttachment(file, uploadFile);
  }

  return (
    <>
      {sendError && (
        <button type="button" className="chat-input-notice" onClick={draft.dismissError}>
          {sendError}
        </button>
      )}
      {voiceError && (
        <button type="button" className="chat-input-notice" onClick={() => setVoiceError(null)}>
          {voiceError}
        </button>
      )}
      {attachments.length > 0 && <div className="chat-staged-list">{attachments.map(staged => {
        const attachmentUrl = staged.attachment ? attachmentHref(staged.attachment.url) : undefined;
        const preview = staged.attachment && filePreview(staged.attachment);
        return <div key={staged.generation} className="chat-staged-attachment" role="group" aria-label="暂存附件">
          {attachmentUrl && preview === 'image' ? (
            <a href={attachmentUrl} target="_blank" rel="noopener noreferrer" className="chat-staged-image">
              <img src={attachmentUrl} alt={staged.name} />
            </a>
          ) : attachmentUrl && preview === 'video' ? <video controls preload="metadata" src={attachmentUrl} aria-label={staged.name} />
            : <span className="chat-staged-icon"><Icon name="file" size={24} /></span>}
          <div className="chat-staged-meta">
            {attachmentUrl ? (
              <a href={fileDownloadUrl(staged.attachment!.url)} download={staged.name} className="chat-staged-name">{staged.name}</a>
            ) : <span className="chat-staged-name">{staged.name}</span>}
            <span className="chat-staged-status" aria-live="polite">
              {staged.status === 'uploading' ? '上传中…（尚未发送）'
                : staged.status === 'failed' ? staged.error
                : `已暂存 · ${staged.size ?? 0} B · 随消息发送`}
            </span>
            {staged.attachment?.mime && <span className="chat-staged-status">{staged.attachment.mime}</span>}
            {staged.status === 'failed' && <button type="button" onClick={() => void draft.retryAttachment(staged.generation, uploadFile)}
              aria-label={`重试上传 ${staged.name}`}>重试上传</button>}
            {attachmentBlocked && (
              <span className="chat-staged-status">请先处理上方提问或计划，或移除附件后发送文字。</span>
            )}
          </div>
          <button type="button" className="chat-input-btn attach rp" onClick={() => draft.removeAttachment(staged.generation)}
            aria-label="移除暂存附件" title="移除暂存附件">
            <Icon name="close" size={18} />
          </button>
        </div>;
      })}</div>}
      <div className="chat-input">
      <input ref={fileRef} type="file" multiple hidden onChange={pickFile} />
      <button
        type="button" className="chat-input-btn attach rp"
        disabled={disabled}
        onClick={() => fileRef.current?.click()}
        aria-label={attachments.length ? '添加附件' : '上传文件或图片'} title="最多 20 个附件"
      >
        <Icon name="attach" size={22} />
      </button>
      <textarea
        ref={taRef}
        className="chat-input-message"
        value={text}
        disabled={disabled}
        onChange={(e) => update(e.target.value)}
        placeholder={placeholder ?? '输入消息…'}
        rows={1}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); return; }
          if (e.key === 'Enter' && !e.shiftKey && shouldSubmitOnEnter()) { e.preventDefault(); submit(); }
        }}
      />
      {voiceSupported && (
        <button
          type="button"
          className="chat-input-btn mic rp"
          data-listening={listening ? 'true' : undefined}
          onClick={toggleVoice}
          aria-label={listening ? '停止语音输入' : '语音输入'}
          title={listening ? '停止语音输入' : '语音输入'}
        >
          <Icon name={listening ? 'close' : 'microphone'} size={22} />
        </button>
      )}
      <button
        type="button" className="chat-input-btn send rp" disabled={!canSend} onClick={submit}
        aria-label={busy ? '排队发送' : '发送'}
        title={busy ? '加入队列' : '发送'}
      >
        <Icon name="send" size={22} />
      </button>
      </div>
    </>
  );
}
