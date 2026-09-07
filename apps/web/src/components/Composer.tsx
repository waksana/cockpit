// Compose box — ported from evo-chat's best-tuned chat composer:
//  - CSS-only autoresize textarea (`field-sizing: content`, capped height)
//  - keyboard-glued at the bottom of the visible viewport (data-compose)
//  - desktop Enter-to-send / Shift+Enter newline; mobile Enter=newline, tap send
//  - never submits during IME (CJK) composition
//  - Cmd/Ctrl+Enter always submits
//  - voice dictation (Web Speech API) appended into the text
//
// Draft safety:
//  - the typed text is seeded from `initialDraft` on mount and persisted via
//    `onPersistDraft` on every change + on unmount, so switching sessions (which
//    remounts this component) never loses unsent text.
//  - `onSend` returns a boolean: true only when the message was actually
//    dispatched on an open socket. We clear the box ONLY then — if the bridge is
//    disconnected the text is kept (and the store surfaces an error), so a send
//    during a connection blip is never silently lost.

import { useEffect, useRef, useState } from 'react';
import { createVoiceController, isVoiceSupported } from '../lib/voice';
import type { VoiceController } from '../lib/voice';
import { useCockpit } from '../net/store';
import { Icon } from './Icon';

function shouldSubmitOnEnter(): boolean {
  return window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? true;
}

interface ComposerProps {
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  initialDraft?: string;
  onPersistDraft?: (text: string) => void;
  onSend: (text: string) => boolean;
  onAttach?: (file: File) => Promise<void>;
  onFocusPin?: () => void;
}

export function Composer({
  disabled, busy, placeholder, initialDraft, onPersistDraft, onSend, onAttach, onFocusPin,
}: ComposerProps) {
  const [text, setText] = useState(initialDraft ?? '');
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const voiceRef = useRef<VoiceController | null>(null);
  const voiceSupported = isVoiceSupported();
  const speechToken = useCockpit((s) => s.speechToken);

  // Persist the latest text on unmount (session switch) so the draft survives a
  // remount. Refs track the live value/callback for the unmount-time read; they
  // are updated in effects (not during render) to satisfy the hooks rules.
  const textRef = useRef(text);
  const persistRef = useRef(onPersistDraft);
  useEffect(() => { textRef.current = text; });
  useEffect(() => { persistRef.current = onPersistDraft; });
  useEffect(() => () => { persistRef.current?.(textRef.current); }, []);

  function update(next: string) {
    setText(next);
    onPersistDraft?.(next);
  }

  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !onFocusPin) return;
    const onFocus = () => requestAnimationFrame(() => onFocusPin());
    ta.addEventListener('focus', onFocus);
    return () => ta.removeEventListener('focus', onFocus);
  }, [onFocusPin]);

  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    // Send works even while a turn is running — the backend enqueues it
    // (CLI-style queue). Only clear the box if actually dispatched on an open
    // socket; otherwise keep the text (store surfaces a "not connected" error).
    const dispatched = onSend(t);
    if (!dispatched) return;
    voiceRef.current?.stop();
    setListening(false);
    update('');
  }

  // Create the voice controller at mount and warm the speech token AHEAD of any
  // tap. iOS requires getUserMedia + AudioContext.resume to run inside the tap
  // gesture (no await first), so the token must already be in hand when start()
  // fires. Errors surface as a transient notice (never a silent no-op).
  useEffect(() => {
    if (!voiceSupported) return;
    const ctrl = createVoiceController({
      onFinal: (chunk) => {
        setText((prev) => {
          const next = prev ? `${prev}${prev.endsWith(' ') ? '' : ' '}${chunk}` : chunk;
          persistRef.current?.(next);
          return next;
        });
      },
      onStateChange: setListening,
      onError: (msg) => { setVoiceError(msg); setListening(false); },
    }, speechToken);
    ctrl.prepare();
    voiceRef.current = ctrl;
    return () => { ctrl.stop(); voiceRef.current = null; };
  }, [voiceSupported, speechToken]);

  function toggleVoice() {
    const ctrl = voiceRef.current;
    if (!ctrl) return;
    setVoiceError(null);
    if (listening) ctrl.stop();
    else ctrl.start();
  }

  const canSend = text.trim().length > 0 && !disabled;

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file || !onAttach || uploading) return;
    setUploading(true);
    try { await onAttach(file); } finally { setUploading(false); }
  }

  return (
    <>
      {voiceError && (
        <button type="button" className="chat-input-notice" onClick={() => setVoiceError(null)}>
          {voiceError}
        </button>
      )}
      <div className="chat-input">
      {onAttach && (
        <>
          <input ref={fileRef} type="file" hidden onChange={pickFile} />
          <button
            type="button" className="chat-input-btn attach rp"
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
            aria-label="上传文件或图片" title="上传文件或图片"
          >
            {uploading ? <span className="spinner" aria-hidden="true" /> : <Icon name="attach" size={22} />}
          </button>
        </>
      )}
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
