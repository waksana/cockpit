// Responsive master-detail shell. Layout in styles/components/shell.scss.
// Geometry: fixed inset-0, height 100dvh, flex row (master | detail). Below the
// 925px dock line only one pane shows at a time (list ↔ chat), driven by
// `mobileVisible`; at/above it both dock side-by-side.

import type { ReactNode } from 'react';
import { useMediaQuery } from '../lib/useMediaQuery';

export function Shell({ children, ariaLabel, infoOpen }: { children: ReactNode; ariaLabel: string; infoOpen?: boolean }) {
  return (
    <section className="cockpit-shell" data-info-open={infoOpen ? 'true' : 'false'} aria-label={ariaLabel}>{children}</section>
  );
}

export function MasterPane({
  children, ariaLabel, mobileVisible, header, overlay,
}: {
  children: ReactNode; ariaLabel: string; mobileVisible: boolean; header?: ReactNode; overlay?: ReactNode;
}) {
  const docked = useMediaQuery('(min-width: 925px)');
  const hidden = !docked && !mobileVisible;
  return (
    <aside className="master-pane" data-visible={mobileVisible ? 'true' : 'false'} aria-label={ariaLabel}
      inert={hidden} aria-hidden={hidden || undefined}>
      {header}
      <div className="master-pane-scroll scrollable">{children}</div>
      {overlay}
    </aside>
  );
}

export function DetailPane({
  children, ariaLabel, mobileVisible, header,
}: {
  children: ReactNode; ariaLabel: string; mobileVisible: boolean; header?: ReactNode;
}) {
  const docked = useMediaQuery('(min-width: 925px)');
  const hidden = !docked && !mobileVisible;
  return (
    <section className="detail-pane" data-visible={mobileVisible ? 'true' : 'false'} aria-label={ariaLabel}
      inert={hidden} aria-hidden={hidden || undefined}>
      {header}
      <div className="detail-pane-body">{children}</div>
    </section>
  );
}
