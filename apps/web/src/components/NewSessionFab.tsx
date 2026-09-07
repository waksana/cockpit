// New-session FAB — tweb .btn-corner compose button (bottom-inline-end of the
// master pane). Clicking opens the standard centered Dialog (managed by App) to
// enter a working directory — consistent with rename/compact/delete dialogs.

import { Icon } from './Icon';

export function NewSessionFab({ disabled, onOpen }: {
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="fab-wrap">
      <button
        type="button"
        className="btn-corner rp is-visible"
        aria-label="新建会话"
        disabled={disabled}
        onClick={onOpen}
      >
        <Icon name="compose" size={26} />
      </button>
    </div>
  );
}
