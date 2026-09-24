import { useId, useRef, useState } from 'react';
import { useControlComposer } from '../../lib/useControlComposer';
import { useRemovedControlFocus } from '../../lib/useRemovedControlFocus';

// Fold state for the input card and the shared control bar. The fold survives
// ordinary updates; a new request or idle input opens afresh.
export function useInputCard({ sessionId, foldIdentity, hasInputHeader, sharedControls, draftId, decisionKey }: {
  sessionId: string; foldIdentity: readonly unknown[]; hasInputHeader: boolean;
  sharedControls: boolean; draftId: string; decisionKey?: string;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const bodyId = useId();
  const foldKey = JSON.stringify([sessionId, ...foldIdentity, hasInputHeader]);
  const [fold, setFold] = useState({ key: foldKey, folded: false });
  if (fold.key !== foldKey) setFold({ key: foldKey, folded: false });
  const open = fold.key !== foldKey || !fold.folded;
  const [controlsDisclosure, setControlsDisclosure] = useState<{ decision?: string; open: boolean }>({ open: true });
  const controlsOpen = decisionKey && decisionKey !== controlsDisclosure.decision ? true : controlsDisclosure.open;
  const releaseEditorSize = useControlComposer(cardRef, sharedControls, draftId, decisionKey);
  const executionControlRef = useRemovedControlFocus(sessionId, cardRef);
  return {
    cardRef, bodyId, open, controlsOpen, releaseEditorSize, executionControlRef,
    toggle: () => setFold({ key: foldKey, folded: open }),
    toggleControls: () => { setControlsDisclosure({ decision: decisionKey, open: !controlsOpen }); },
  };
}
