// Responsive master-detail shell. Layout in styles/components/shell.scss.
// Geometry: fixed visual viewport, flex row (master | detail). Below the
// 925px dock line only one pane shows at a time (list ↔ chat), driven by
// `mobileVisible`; at/above it both dock side-by-side.

import { createContext, useContext, type ReactNode } from 'react';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useVisualViewport } from '../lib/useVisualViewport';

const CoveredPanes = createContext(false);

export function Shell({ children, ariaLabel, infoOpen }: { children: ReactNode; ariaLabel: string; infoOpen?: boolean }) {
  useVisualViewport();
  const wide = useMediaQuery('(min-width: 1200px)');
  return (
    <CoveredPanes value={Boolean(infoOpen && !wide)}>
      <section className="cockpit-shell" data-info-open={infoOpen ? 'true' : 'false'} aria-label={ariaLabel}>{children}</section>
    </CoveredPanes>
  );
}

export function MasterPane({
  children, ariaLabel, mobileVisible, header, overlay,
}: {
  children: ReactNode; ariaLabel: string; mobileVisible: boolean; header?: ReactNode; overlay?: ReactNode;
}) {
  const docked = useMediaQuery('(min-width: 925px)');
  const covered = useContext(CoveredPanes);
  const hidden = covered || (!docked && !mobileVisible);
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
  const covered = useContext(CoveredPanes);
  const hidden = covered || (!docked && !mobileVisible);
  return (
    <section className="detail-pane" data-visible={mobileVisible ? 'true' : 'false'} aria-label={ariaLabel}
      inert={hidden} aria-hidden={hidden || undefined}>
      {header}
      <div className="detail-pane-body">{children}</div>
    </section>
  );
}
