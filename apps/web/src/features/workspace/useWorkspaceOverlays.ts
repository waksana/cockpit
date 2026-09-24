import { useState } from 'react';

// Transient Workspace overlays. Every navigation closes them; the detail menu
// also closes when its session disappears.
export function useWorkspaceOverlays(locationKey: string, hasActive: boolean) {
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  if (detailMenuOpen && !hasActive) setDetailMenuOpen(false);
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; name: string } | null>(null);
  const [dirPicker, setDirPicker] = useState(false);
  const [overlayRoute, setOverlayRoute] = useState(locationKey);
  if (overlayRoute !== locationKey) {
    setOverlayRoute(locationKey);
    setDeleteTarget(null);
    setDirPicker(false);
    setDetailMenuOpen(false);
  }
  return { detailMenuOpen, setDetailMenuOpen, deleteTarget, setDeleteTarget, dirPicker, setDirPicker };
}
