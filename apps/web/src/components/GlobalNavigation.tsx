import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnchoredMenu } from './AnchoredMenu';
import { IconButton } from './Button';
import { SettingsDialog } from './SettingsDialog';

export function GlobalNavigation() {
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return <>
    <IconButton ref={triggerRef} className="sidebar-hamburger" icon="menu" label="全局导航"
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} />
    {open && <AnchoredMenu triggerRef={triggerRef} align="left"
      moduleTarget={{ menu: 'global' }} items={[
        { id: 'settings', label: '设置', icon: 'settings', onClick: () => setSettingsOpen(true) },
        { id: 'mcp', label: '全局 MCP', icon: 'mcp', onClick: () => { void navigate('/mcp'); } },
        { id: 'skills', label: '全局 Skills', icon: 'skills', onClick: () => { void navigate('/skills'); } },
      ]} onClose={() => setOpen(false)} />}
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
  </>;
}
