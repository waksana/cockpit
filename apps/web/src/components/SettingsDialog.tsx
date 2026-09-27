import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDefaultModelSettings } from '../features/settings/useDefaultModelSettings';
import { useNativeDialog } from '../lib/useNativeDialog';
import { AboutSettings } from './AboutSettings';
import { DefaultModelSettings } from './DefaultModelSettings';
import { IconButton } from './Button';
import { UxErrorNotifications } from './UxErrorNotifications';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const model = useDefaultModelSettings();
  useNativeDialog(ref);
  const dialog = <dialog ref={ref} className="dialog-scrim settings-dialog host-modal ck-modal" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-card settings-card ck-surface">
      <header className="settings-header">
        <h2 id={titleId} className="ck-heading" tabIndex={-1} data-dialog-focus
          ref={heading => { if (heading) heading.autofocus = true; }}>设置</h2>
        <IconButton icon="close" label="关闭设置" onClick={onClose} />
      </header>
      <div className="settings-body">
        <div className="settings-sections"><DefaultModelSettings settings={model} /></div>
        <AboutSettings />
      </div>
    </div>
    <UxErrorNotifications withinDialog />
  </dialog>;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
