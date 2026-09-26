import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { loadServiceIdentity } from '../net/api';
import { useKeyedResource } from '../lib/useKeyedResource';
import { useNativeDialog } from '../lib/useNativeDialog';
import { Button, RefreshButton } from './Button';
import { ResourceStatus } from './StateNotice';

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useNativeDialog(ref);
  const resource = useKeyedResource('service-identity', loadServiceIdentity);
  const identity = resource.usable ? resource.data : undefined;
  const dialog = <dialog ref={ref} className="dialog-scrim host-modal ck-modal" aria-label="关于 Cockpit"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-card ck-surface">
      <h3 className="dialog-title ck-heading" data-dialog-focus>关于 Cockpit</h3>
      <ResourceStatus status={resource.status} failed={resource.failed} pending={resource.pending} />
      {identity && <dl className="runtime-identity">
        <dt>版本</dt><dd>{identity.version}</dd>
        <dt>源提交</dt><dd>{identity.sourceSha ?? '不可用'}</dd>
      </dl>}
      <div className="dialog-actions ck-actions">
        <RefreshButton disabled={!resource.connected || resource.pending} pending={resource.pending}
          onClick={() => { void resource.refresh(); }} />
        <Button onClick={onClose}>关闭</Button>
      </div>
    </div>
  </dialog>;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
