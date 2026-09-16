// New-session FAB — tweb .btn-corner compose button (bottom-inline-end of the
// master pane). Opens App's directory picker to choose a working directory.

import { Icon } from './Icon';

export function NewSessionFab({ disabled, onOpen }: {
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="fab-wrap">
      <button
        type="button"
        className="btn-corner ck-icon-button ck-primary rp is-visible"
        aria-label="新建会话"
        disabled={disabled}
        onClick={onOpen}
      >
        <Icon name="compose" size={24} />
      </button>
    </div>
  );
}
