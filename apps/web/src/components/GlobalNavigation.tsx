import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnchoredMenu } from './AnchoredMenu';
import { Icon } from './Icon';
import { ModuleGlobalActions } from './ModuleContributions';

export function GlobalNavigation() {
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={triggerRef} type="button" className="ck-icon-button rp sidebar-hamburger"
      aria-label="全局导航" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="menu" size={24} />
    </button>
    <ModuleGlobalActions />
    {open && <AnchoredMenu triggerRef={triggerRef} align="left" items={[
      { label: '全局 MCP', icon: 'mcp', onClick: () => { void navigate('/mcp'); } },
      { label: '全局 Skills', icon: 'skills', onClick: () => { void navigate('/skills'); } },
    ]} onClose={() => setOpen(false)} />}
  </>;
}
