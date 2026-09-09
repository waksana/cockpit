// Modal dialog — tweb popup contract (scrim + centered card, scale-in). Supports
// a confirm (optional destructive) and an optional single text input.
// Dismisses on scrim tap / Escape / cancel unless an action is pending.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useModalFocus } from '../lib/useModalFocus';

// Both the lazy placeholder and the loaded picker own the same modal boundary.
export function DirectoryModal({ children, busy = false, onCancel }: {
  children: ReactNode; busy?: boolean; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (event.target instanceof Element && event.target.closest('.ux-error-notifications'))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);
  const modal = (
    <div className="dialog-scrim directory-modal" onPointerDown={() => { if (!busy) onCancel(); }}>
      <div ref={ref} tabIndex={-1} className="dialog-card dirpicker" role="dialog" aria-modal="true"
        aria-label="选择工作目录" aria-busy={busy} onPointerDown={event => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}

export interface DialogProps {
  title: string;
  message?: string;
  // When provided, renders a text input seeded with this value; the confirm
  // handler receives the entered text.
  input?: { placeholder?: string; initial?: string };
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  rollbackFiles?: boolean;
  actionKey?: string;
  // Informational dialogs only dismiss; they never invoke a mutation.
  acknowledgementOnly?: boolean;
  onConfirm: (value: string, rollbackFiles: boolean) => void | Promise<void>;
  onSuccess?: () => void;
  onCancel: () => void;
}

export function Dialog(props: DialogProps) {
  const dialog = <DialogContent key={props.actionKey} {...props} />;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

function DialogContent({
  title, message, input, confirmLabel = '确定', cancelLabel = '取消', destructive,
  rollbackFiles, actionKey, acknowledgementOnly = false, onConfirm, onSuccess, onCancel,
}: DialogProps) {
  const [value, setValue] = useState(input?.initial ?? '');
  const [shouldRollbackFiles, setShouldRollbackFiles] = useState(rollbackFiles ?? false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(dialogRef);
  const identity = useId();
  const action = useKeyedAction(`dialog:${identity}:${actionKey ?? ''}`);
  const hasInput = input !== undefined;

  const confirm = async () => {
    if (action.busy) return;
    if (acknowledgementOnly) {
      onCancel();
      return;
    }
    if (!action.connected || (hasInput && !value.trim())) return;
    await action.run(() => onConfirm(value, shouldRollbackFiles), () => {
      onSuccess?.();
      onCancel();
    });
  };
  const cancel = () => {
    if (!action.busy) onCancel();
  };

  useEffect(() => {
    if (hasInput) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [hasInput]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!action.busy) onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [action.busy, onCancel]);

  return (
    <div className="dialog-scrim" onPointerDown={cancel}>
      <div ref={dialogRef} tabIndex={-1} className="dialog-card" role="dialog" aria-modal="true" aria-label={title} aria-busy={action.busy}
        aria-describedby={message ? `${identity}-message` : undefined} onPointerDown={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">{title}</h3>
        {message && <p id={`${identity}-message`} className="dialog-message">{message}</p>}
        {input && (
          <input
            ref={inputRef}
            className="dialog-input"
            type="text"
            value={value}
            placeholder={input.placeholder}
            disabled={action.busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void confirm(); }
            }}
          />
        )}
        {rollbackFiles !== undefined && (
          <label className="dialog-message dialog-checkbox">
            <input type="checkbox" checked={shouldRollbackFiles} disabled={action.busy}
              onChange={(e) => setShouldRollbackFiles(e.target.checked)} />
            同时回退文件（可能不受支持；不勾选时仅回退对话）
          </label>
        )}
        {action.error && <p className="dialog-message dialog-error" role="alert">操作失败：{action.error}</p>}
        {!action.connected && !acknowledgementOnly && (
          <p className="dialog-message" role="status">等待连接…连接恢复后可重试。</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn rp" disabled={action.busy} onClick={cancel}>{cancelLabel}</button>
          <button
            type="button"
            className={`dialog-btn primary rp${destructive ? ' danger' : ''}`}
            disabled={action.busy || (!acknowledgementOnly && (!action.connected || (hasInput && !value.trim())))}
            onClick={() => { void confirm(); }}
          >
            {action.busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
