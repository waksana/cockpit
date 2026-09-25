// Modal dialog — scrim and centered card. Supports
// a confirm (optional destructive) and an optional single text input.
// Dismisses on scrim tap / Escape / cancel unless an action is pending.

import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useNativeDialog } from '../lib/useNativeDialog';
import { UxErrorNotifications } from './UxErrorNotifications';
import { StateNotice } from './StateNotice';
import { OperationErrorResult, OperationResult } from './OperationResult';
import { Button } from './Button';

// Both the lazy placeholder and the loaded picker own the same modal boundary.
export function DirectoryModal({ children, busy = false, onCancel }: {
  children: ReactNode; busy?: boolean; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useNativeDialog(ref);
  const titleId = useId();
  const modal = (
    <dialog ref={ref} className="dialog-scrim directory-modal host-modal ck-modal" aria-labelledby={titleId} aria-busy={busy}
      onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
      onClick={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <div className="dialog-card dirpicker ck-surface">
        <h3 id={titleId} className="dialog-title ck-heading" tabIndex={-1} data-dialog-focus
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
  children?: ReactNode;
  // When provided, renders a text input seeded with this value; the confirm
  // handler receives the entered text.
  input?: { placeholder?: string; initial?: string; optional?: boolean };
  confirmDisabled?: boolean;
  // A caller-owned result sentence (already worded with lib/copy) and its state.
  error?: string;
  errorState?: 'failed' | 'unknown';
  pending?: boolean;
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
  title, message, children, input, confirmLabel = '确定', destructive, confirmDisabled, error, errorState = 'unknown', pending = false,
  actionKey, onConfirm, onSuccess, onCancel,
}: DialogProps) {
  const [value, setValue] = useState(input?.initial ?? '');
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useNativeDialog(dialogRef);
  const identity = useId();
  const action = useKeyedAction(`dialog:${identity}:${actionKey ?? ''}`);
  const busy = action.busy || pending;
  const hasInput = input !== undefined;
  const inputInvalid = hasInput && !input.optional && !value.trim();

  const confirm = async () => {
    if (busy) return;
    if (!action.connected || confirmDisabled || inputInvalid) return;
    await action.run(() => onConfirm(value), () => {
      onSuccess?.();
      onCancel();
    });
  };
  const cancel = () => {
    if (!busy) onCancel();
  };

  return (
    <dialog ref={dialogRef} className="dialog-scrim host-modal ck-modal" aria-label={title} aria-busy={busy}
      aria-describedby={message ? `${identity}-message` : undefined}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); cancel(); }}
      onClick={event => { if (event.target === event.currentTarget) cancel(); }}>
      <div className="dialog-card ck-surface">
        <h3 className="dialog-title ck-heading" data-dialog-focus>{title}</h3>
        {message && <p id={`${identity}-message`} className="dialog-message">{message}</p>}
        {children}
        {input && (
          <input
            className="dialog-input ck-input"
            type="text"
            aria-label={input.placeholder || title}
            value={value}
            placeholder={input.placeholder}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void confirm(); }
            }}
          />
        )}
        {error ? <OperationResult state={errorState}>{error}</OperationResult>
          : action.error && <OperationErrorResult label={confirmLabel} error={action.error} cause={action.errorCause} />}
        {!action.connected && (
          <StateNotice>等待连接…请在连接恢复后核对操作结果。</StateNotice>
        )}
        <div className="dialog-actions ck-actions">
          <Button disabled={busy} onClick={cancel}>取消</Button>
          <Button
            variant="primary"
            danger={destructive}
            disabled={busy || !action.connected || confirmDisabled || inputInvalid}
            onClick={() => { void confirm(); }}
          >
            {busy ? '处理中…' : confirmLabel}
          </Button>
        </div>
      </div>
      <UxErrorNotifications withinDialog />
    </dialog>
  );
}
