import { useSyncExternalStore } from 'react';
import { dismissUxError, getUxErrors, subscribeUxErrors } from '../lib/errorReporter';

export function UxErrorNotifications() {
  const errors = useSyncExternalStore(subscribeUxErrors, getUxErrors, getUxErrors);
  const dismiss = (id: number, button: HTMLButtonElement) => {
    if (document.activeElement === button) {
      const buttons = Array.from(button.closest('aside')?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const index = buttons.indexOf(button);
      const fallback = buttons[index + 1] ?? buttons[index - 1]
        ?? document.querySelector<HTMLElement>('.info-panel[data-open="true"]')
        ?? document.querySelector<HTMLElement>('.cockpit-shell');
      if (fallback) {
        if (!fallback.hasAttribute('tabindex') && fallback.tagName !== 'BUTTON') fallback.tabIndex = -1;
        fallback.focus();
      }
    }
    dismissUxError(id);
  };
  if (!errors.length) return null;

  return (
    <aside className="ux-error-notifications" aria-label="本地错误通知">
      {errors.map((error) => (
        <div key={error.id} className="ux-error-notification">
          <div className="ux-error-notification-content" role="alert">
            <strong>操作或界面出错</strong>
            <p className="user-select-text">{error.message}</p>
          </div>
          <button
            type="button"
            className="btn ux-error-notification-dismiss"
            aria-label="关闭错误通知"
            onClick={(event) => dismiss(error.id, event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              dismiss(error.id, event.currentTarget);
            }}
          >
            关闭
          </button>
        </div>
      ))}
    </aside>
  );
}
