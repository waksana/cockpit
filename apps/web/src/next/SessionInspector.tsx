import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Button } from '@cockpit/ui';
import { X } from 'lucide-react';
import { INSPECTOR_DOCK_QUERY } from '../lib/layout';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useNativeDialog } from '../lib/useNativeDialog';
import { sessionPath, SESSION_PANELS, SESSION_PANEL_LABELS, type SessionPanel } from '../lib/routeOwnership';
import { SessionSettings } from './settings/SessionSettings';
import { SettingsOverlayContainer } from './settings/overlayContainer';
import { Errors } from './Feedback';

export function SessionInspector({ sessionId, panel, onClose }: {
  sessionId: string; panel: SessionPanel; onClose(): void;
}) {
  const frame = useRef<HTMLDialogElement>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const docked = useMediaQuery(INSPECTOR_DOCK_QUERY);
  // Keep the same form mounted when moving between a docked panel and a modal.
  useNativeDialog(frame, !docked);
  useEffect(() => {
    if (!docked) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector(':modal')
        && !document.querySelector('[role="menu"][data-state="open"], [role="listbox"], [role="dialog"][data-state="open"]')) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [docked, onClose]);
  return <dialog ref={frame} className="next-inspector" aria-label="会话设置"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (!docked && event.target === event.currentTarget) onClose(); }}>
    <div className="next-inspector-surface" tabIndex={-1} data-next-focus
      ref={element => { if (element) element.autofocus = true; }}>
      <header className="next-inspector-header">
        <Button variant="ghost" size="icon" aria-label="关闭会话设置" onClick={onClose}><X aria-hidden="true" /></Button>
        <nav className="next-settings-tabs" aria-label="会话设置分类">
          {SESSION_PANELS.map(value => <NavLink key={value} to={sessionPath(sessionId, value)} replace>
            {SESSION_PANEL_LABELS[value]}
          </NavLink>)}
        </nav>
      </header>
      <SettingsOverlayContainer value={container}>
        <div className="next-page-scroll"><SessionSettings sessionId={sessionId} panel={panel} /></div>
      </SettingsOverlayContainer>
      <Errors />
    </div>
    <div ref={setContainer} />
  </dialog>;
}
