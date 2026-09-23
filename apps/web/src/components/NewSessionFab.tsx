// New-session FAB — tweb .btn-corner compose button (bottom-inline-end of the
// master pane). Opens App's directory picker to choose a working directory.

import { IconButton } from './Button';

export function NewSessionFab({ disabled, onOpen }: {
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="fab-wrap">
      <IconButton className="btn-corner is-visible" variant="primary" icon="compose" label="新建会话"
        disabled={disabled} onClick={onOpen} />
    </div>
  );
}
