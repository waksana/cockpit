// Modal dialog — scrim and centered card. Supports
// a confirm (optional destructive) and an optional single text input.
// Dismisses on scrim tap / Escape / cancel unless an action is pending.

import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useNativeDialog } from '../lib/useNativeDialog';
import { UxErrorNotifications } from './UxErrorNotifications';

// Both the lazy placeholder and the loaded picker own the same modal boundary.
export function DirectoryModal({ children, busy = false, onCancel }: {
  children: ReactNode; busy?: boolean; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useNativeDialog(ref);
  const titleId = useId();
  const modal = (
    <dialog ref={ref} className="dialog-scrim directory-modal host-modal" aria-labelledby={titleId} aria-busy={busy}
      onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
      onClick={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <div className="dialog-card dirpicker">
        <h3 id={titleId} className="dialog-title" tabIndex={-1} data-dialog-focus
          ref={heading => { if (heading) heading.autofocus = true; }}>新建会话</h3>
        {children}
      </div>
      <UxErrorNotifications withinDialog />
    </dialog>
  );
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}

interface DialogProps {
  title: string;
  message?: string;
  // When provided, renders a text input seeded with this value; the confirm
  // handler receives the entered text.
  input?: { placeholder?: string; initial?: string };
  confirmLabel?: string;
  destructive?: boolean;
  actionKey?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onSuccess?: () => void;
  onCancel: () => void;
}

export function Dialog(props: DialogProps) {
  const dialog = <DialogContent key={props.actionKey} {...props} />;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

function DialogContent({
  title, message, input, confirmLabel = '确定', destructive,
  actionKey, onConfirm, onSuccess, onCancel,
}: DialogProps) {
  const [value, setValue] = useState(input?.initial ?? '');
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useNativeDialog(dialogRef);
  const identity = useId();
  const action = useKeyedAction(`dialog:${identity}:${actionKey ?? ''}`);
  const hasInput = input !== undefined;

  const confirm = async () => {
    if (action.busy) return;
    if (!action.connected || (hasInput && !value.trim())) return;
    await action.run(() => onConfirm(value), () => {
      onSuccess?.();
      onCancel();
    });
  };
  const cancel = () => {
    if (!action.busy) onCancel();
  };

  return (
    <dialog ref={dialogRef} className="dialog-scrim host-modal" aria-label={title} aria-busy={action.busy}
      aria-describedby={message ? `${identity}-message` : undefined}
      onCancel={event => { event.preventDefault(); cancel(); }}
      onClick={event => { if (event.target === event.currentTarget) cancel(); }}>
      <div className="dialog-card">
        <h3 className="dialog-title" data-dialog-focus>{title}</h3>
        {message && <p id={`${identity}-message`} className="dialog-message">{message}</p>}
        {input && (
          <input
            className="dialog-input ck-input"
            type="text"
            aria-label={input.placeholder || title}
            value={value}
            placeholder={input.placeholder}
            disabled={action.busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void confirm(); }
            }}
          />
        )}
        {action.error && <p className="dialog-message dialog-error" role="alert">操作失败：{action.error}</p>}
        {!action.connected && (
          <p className="dialog-message" role="status">等待连接…连接恢复后可重试。</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn ck-button rp" disabled={action.busy} onClick={cancel}>取消</button>
          <button
            type="button"
            className={`dialog-btn ck-button ck-primary primary rp${destructive ? ' danger ck-danger' : ''}`}
            disabled={action.busy || !action.connected || (hasInput && !value.trim())}
            onClick={() => { void confirm(); }}
          >
            {action.busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
      <UxErrorNotifications withinDialog />
    </dialog>
  );
}
