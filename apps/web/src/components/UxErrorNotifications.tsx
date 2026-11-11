import { useSyncExternalStore } from 'react';
import { dismissUxError, getUxErrors, subscribeUxErrors } from '../lib/errorReporter';
import { Button } from './Button';
import { moduleRuntime } from '../lib/moduleRuntime';
import { ModuleDiagnosticHistory } from './ModuleDiagnosticHistory';

export function UxErrorNotifications({ withinDialog = false }: { withinDialog?: boolean }) {
  const errors = useSyncExternalStore(subscribeUxErrors, getUxErrors, getUxErrors);
  const diagnostics = moduleRuntime.diagnostics;
  const history = useSyncExternalStore(diagnostics.subscribe, diagnostics.getSnapshot, diagnostics.getSnapshot);
  const showHistory = history.errors.length > 0 && !history.dismissed;
  const dismiss = (action: () => void, button: HTMLButtonElement) => {
    if (document.activeElement === button) {
      const card = button.closest('.ux-error-notification, .module-diagnostic-notification');
      const buttons = Array.from(button.closest('aside')?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .filter(candidate => !card?.contains(candidate));
      const fallback = buttons[0]
        ?? button.closest('dialog')?.querySelector<HTMLElement>('[data-dialog-focus]')
        ?? document.querySelector<HTMLElement>('.inspector-pane[open] .inspector-surface')
        ?? document.querySelector<HTMLElement>('.cockpit-shell');
      if (fallback) {
        if (!fallback.hasAttribute('tabindex') && fallback.tagName !== 'BUTTON') fallback.tabIndex = -1;
        fallback.focus();
      }
    }
    action();
  };
  if (!errors.length && !showHistory) return null;

  return (
    <aside className="ux-error-notifications" data-dialog-notices={withinDialog || undefined} aria-label="本地错误通知">
      {showHistory && <div className="module-diagnostic-notification ck-surface">
        <ModuleDiagnosticHistory history={history} />
        <Button className="ux-error-notification-dismiss" aria-label="关闭模块诊断提示"
          onClick={event => dismiss(diagnostics.dismiss, event.currentTarget)}
          onKeyDown={event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            dismiss(diagnostics.dismiss, event.currentTarget);
          }}>关闭</Button>
      </div>}
      {errors.map((error) => (
        <div key={error.id} className="ux-error-notification ck-surface">
          <div className="ux-error-notification-content" role="alert">
            <strong>操作或界面出错</strong>
            <p className="user-select-text">{error.message}</p>
          </div>
          <Button
            className="ux-error-notification-dismiss"
            aria-label="关闭错误通知"
            onClick={(event) => dismiss(() => dismissUxError(error.id), event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              dismiss(() => dismissUxError(error.id), event.currentTarget);
            }}
          >
            关闭
          </Button>
        </div>
      ))}
    </aside>
  );
}
