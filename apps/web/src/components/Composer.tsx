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
import { fileDownloadUrl, filePreview, formatFileSize } from '../lib/managedFile';
import { hasTransferFiles, readableClipboardHtml, transferFiles } from '../lib/attachmentInput';
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
  const dragDepth = useRef(0);
  const [dragState, setDragState] = useState({ draft, disabled, active: false });
  if (dragState.draft !== draft || dragState.disabled !== disabled) {
    setDragState({ draft, disabled, active: false });
  }
  const voiceRef = useRef<VoiceController | null>(null);
  const voiceSupported = isVoiceSupported();
  const speechToken = useCockpit((s) => s.speechToken);

  useLayoutEffect(() => {
    ownerRef.current = {};
    dragDepth.current = 0;
    return () => { ownerRef.current = null; };
  }, [draft]);

  useLayoutEffect(() => { dragDepth.current = 0; }, [disabled]);

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
  const draggingFiles = !disabled && dragState.draft === draft && dragState.active;
  const setDragging = (active: boolean) => setDragState({ draft, disabled, active });

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow re-picking the same file
    if (disabled || !ownerRef.current) return;
    void draft.addAttachments(files, uploadFile);
  }

  function addTransfer(data: DataTransfer) {
    if (disabled || !ownerRef.current) return;
    try {
      const files = transferFiles(data);
      if (files.length) void draft.addAttachments(files, uploadFile);
      else draft.reportAttachmentError('浏览器未提供可读取的文件，请拖入文件或使用附件按钮。');
    } catch (error) {
      draft.reportAttachmentError(error instanceof Error ? error.message : '无法读取文件，请使用附件按钮。');
    }
  }

  function paste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled || !ownerRef.current || !hasTransferFiles(e.clipboardData)) return;
    addTransfer(e.clipboardData);
    // Let the textarea preserve native plain-text paste, selection and undo.
    // HTML-only file payloads need a readable-text fallback, never HTML insertion.
    if (!e.clipboardData.getData('text/plain')) {
      const html = e.clipboardData.getData('text/html');
      const readable = html && readableClipboardHtml(html);
      if (readable) {
        e.preventDefault();
        const ta = e.currentTarget;
        ta.setRangeText(readable, ta.selectionStart, ta.selectionEnd, 'end');
        update(ta.value);
      }
    }
  }

  return (
    <>
      {sendError && (
        <div className="chat-input-notice" role="alert" tabIndex={0}><span>{sendError}</span>
          <button type="button" onClick={draft.dismissError} aria-label="关闭发送提示"><Icon name="close" size={18} /></button>
        </div>
      )}
      {voiceError && (
        <div className="chat-input-notice" role="alert" tabIndex={0}><span>{voiceError}</span>
          <button type="button" onClick={() => setVoiceError(null)} aria-label="关闭语音提示"><Icon name="close" size={18} /></button>
        </div>
      )}
      {attachments.length > 0 && <div className="chat-staged-list">{attachments.map(staged => {
        const attachmentUrl = staged.attachment ? attachmentHref(staged.attachment.url) : undefined;
        const preview = staged.attachment && filePreview(staged.attachment);
        return <div key={staged.generation} className="chat-staged-attachment" data-status={staged.status} role="group" aria-label={`暂存附件：${staged.name}`}>
          {attachmentUrl && preview === 'image' ? (
            <a href={attachmentUrl} target="_blank" rel="noopener noreferrer" className="chat-staged-image">
              <img src={attachmentUrl} alt={staged.name} />
            </a>
          ) : attachmentUrl && preview === 'video' ? <video controls preload="metadata" src={attachmentUrl} aria-label={staged.name} />
            : <span className="chat-staged-icon"><Icon name="file" size={24} /></span>}
          <div className="chat-staged-meta">
            {attachmentUrl ? (
              <a href={fileDownloadUrl(staged.attachment!.url)} download={staged.name} className="chat-staged-name" title={staged.name}>{staged.name}</a>
            ) : <span className="chat-staged-name" title={staged.name}>{staged.name}</span>}
            <span className="chat-staged-status" aria-live="polite">
              {staged.status === 'uploading' ? '上传中…（尚未发送）'
                : staged.status === 'failed' ? staged.error
                : `已暂存${staged.size !== undefined ? ` · ${formatFileSize(staged.size)}` : ''} · 随消息发送`}
            </span>
            {staged.attachment?.mime && <span className="chat-staged-status">{staged.attachment.mime}</span>}
            {staged.status === 'failed' && staged.retryable !== false && <button type="button" disabled={disabled} onClick={() => void draft.retryAttachment(staged.generation, uploadFile)}
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
      <div className="chat-input" data-file-drag={draggingFiles ? 'true' : undefined}
        onDragEnter={e => {
          if (!hasTransferFiles(e.dataTransfer)) return;
          e.preventDefault();
          dragDepth.current++;
          if (!disabled) setDragging(true);
        }}
        onDragOver={e => {
          if (!hasTransferFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDragEnd={() => { dragDepth.current = 0; setDragging(false); }}
        onDrop={e => {
          dragDepth.current = 0;
          setDragging(false);
          if (!hasTransferFiles(e.dataTransfer)) return;
          e.preventDefault();
          addTransfer(e.dataTransfer);
        }}
      >
      {draggingFiles && <span className="chat-input-drop-hint" role="status">松开以暂存附件（不会自动发送）</span>}
      <input ref={fileRef} type="file" multiple hidden disabled={disabled} onChange={pickFile} />
      <button
        type="button" className="chat-input-btn attach rp"
        disabled={disabled}
        onClick={() => fileRef.current?.click()}
        aria-label={attachments.length ? '添加附件' : '上传文件或图片'} title="选择、粘贴或拖入文件 · 最多 20 个 · 每个 25 MiB"
      >
        <Icon name="attach" size={22} />
      </button>
      <textarea
        ref={taRef}
        className="chat-input-message"
        aria-label="消息输入"
        value={text}
        disabled={disabled}
        onChange={(e) => update(e.target.value)}
        onPaste={paste}
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
          disabled={disabled}
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
        aria-label={pending ? '正在提交' : busy ? '排队发送' : '发送'}
        aria-busy={pending}
        title={pending ? '正在提交，草稿仍可编辑' : busy ? '加入队列' : '发送'}
      >
        <Icon name={pending ? 'sending' : 'send'} size={22} />
      </button>
      </div>
    </>
  );
}
