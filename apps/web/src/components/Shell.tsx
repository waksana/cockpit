import { useEffect, useRef, type ReactNode } from 'react';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useNativeDialog } from '../lib/useNativeDialog';
import { INSPECTOR_DOCK_QUERY, MASTER_DOCK_QUERY } from '../lib/layout';
import { PaneBody } from './PaneHeader';

// Slots contain presentation only. Routes and resource state belong to callers.
export function Shell({ master, main, inspector, overlays, ariaLabel }: {
  master?: ReactNode; main: ReactNode; inspector?: ReactNode; overlays?: ReactNode; ariaLabel: string;
}) {
  return (
    <section className="cockpit-shell" aria-label={ariaLabel}>
      {master}{main}{inspector}{overlays}
    </section>
  );
}

export function MasterPane({
  children, ariaLabel, mobileVisible, header, overlay,
}: {
  children: ReactNode; ariaLabel: string; mobileVisible: boolean; header?: ReactNode; overlay?: ReactNode;
}) {
  const docked = useMediaQuery(MASTER_DOCK_QUERY);
  const hidden = !docked && !mobileVisible;
  return (
    <aside className="master-pane" data-visible={mobileVisible ? 'true' : 'false'} aria-label={ariaLabel}
      inert={hidden} aria-hidden={hidden || undefined}>
      {header}
      <PaneBody className="master-pane-scroll" padded={false}>{children}</PaneBody>
      {overlay}
    </aside>
  );
}

export function DetailPane({
  children, ariaLabel, mobileVisible, header,
}: {
  children: ReactNode; ariaLabel: string; mobileVisible: boolean; header?: ReactNode;
}) {
  const docked = useMediaQuery(MASTER_DOCK_QUERY);
  const hidden = !docked && !mobileVisible;
  return (
    <section className="detail-pane" data-visible={mobileVisible ? 'true' : 'false'} aria-label={ariaLabel}
      inert={hidden} aria-hidden={hidden || undefined}>
      {header}
      <PaneBody className="detail-pane-body" scroll={false} padded={false}>{children}</PaneBody>
    </section>
  );
}

// This is an optional inspector, not a universal page/modal wrapper. It keeps
// one mounted frame while the browser switches between modal and docked modes.
export function InspectorPane({ children, ariaLabel, onClose, modalFooter }: {
  children: ReactNode; ariaLabel: string; onClose: () => void; modalFooter?: ReactNode;
}) {
  const frame = useRef<HTMLDialogElement | null>(null);
  const wide = useMediaQuery(INSPECTOR_DOCK_QUERY);
  useNativeDialog(frame, !wide);
  useEffect(() => {
    if (!wide) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector(':modal')) return;
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, wide]);

  return <dialog ref={frame} className="inspector-pane host-modal ck-modal" aria-label={ariaLabel}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (!wide && event.target === event.currentTarget) onClose(); }}>
    <div className="inspector-surface" tabIndex={-1} data-dialog-focus
      ref={surface => { if (surface) surface.autofocus = true; }}>{children}</div>
    {!wide && modalFooter}
  </dialog>;
}
