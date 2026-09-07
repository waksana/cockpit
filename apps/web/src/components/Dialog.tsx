// Modal dialog — tweb popup contract (scrim + centered card, scale-in). Supports
// a confirm (optional destructive) and an optional single text input (for rename).
// Dismisses on scrim tap / Escape / cancel.

import { useEffect, useRef, useState } from 'react';

export interface DialogProps {
  title: string;
  message?: string;
  // When provided, renders a text input seeded with this value; the confirm
  // handler receives the entered text.
  input?: { placeholder?: string; initial?: string };
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function Dialog({ title, message, input, confirmLabel = '确定', cancelLabel = '取消', destructive, onConfirm, onCancel }: DialogProps) {
  const [value, setValue] = useState(input?.initial ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const confirm = () => {
    if (input && !value.trim()) return;
    onConfirm(value);
  };

  useEffect(() => {
    if (input) { inputRef.current?.focus(); inputRef.current?.select(); }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dialog-scrim" onPointerDown={onCancel}>
      <div className="dialog-card" role="dialog" aria-modal="true" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
        <h3 className="dialog-title">{title}</h3>
        {message && <p className="dialog-message">{message}</p>}
        {input && (
          <input
            ref={inputRef}
            className="dialog-input"
            type="text"
            value={value}
            placeholder={input.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } }}
          />
        )}
        <div className="dialog-actions">
          <button type="button" className="dialog-btn rp" onClick={onCancel}>{cancelLabel}</button>
          <button
            type="button"
            className={`dialog-btn primary rp${destructive ? ' danger' : ''}`}
            disabled={!!input && !value.trim()}
            onClick={confirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
