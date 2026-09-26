import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnchoredMenu } from './AnchoredMenu';
import { IconButton } from './Button';
import { DefaultModelDialog } from './DefaultModelDialog';
import { AboutDialog } from './AboutDialog';

export function GlobalNavigation() {
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  return <>
    <IconButton ref={triggerRef} className="sidebar-hamburger" icon="menu" label="全局导航"
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} />
    {open && <AnchoredMenu triggerRef={triggerRef} align="left"
      moduleTarget={{ menu: 'global' }} items={[
        { id: 'default-model', label: '默认新会话模型', icon: 'agent', onClick: () => setModelOpen(true) },
        { id: 'mcp', label: '全局 MCP', icon: 'mcp', onClick: () => { void navigate('/mcp'); } },
        { id: 'skills', label: '全局 Skills', icon: 'skills', onClick: () => { void navigate('/skills'); } },
        { id: 'about', label: '关于 Cockpit', onClick: () => setAboutOpen(true) },
      ]} onClose={() => setOpen(false)} />}
    {modelOpen && <DefaultModelDialog onClose={() => setModelOpen(false)} />}
    {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
  </>;
}
