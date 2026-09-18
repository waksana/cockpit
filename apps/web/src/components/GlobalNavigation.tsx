import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnchoredMenu } from './AnchoredMenu';
import { Icon } from './Icon';
import type { GlobalNavigationProps } from '@cockpit/module-api';
import { useModuleElement } from './ModuleComponents';

export function GlobalNavigation(props: GlobalNavigationProps) {
  return useModuleElement('globalNavigation', GlobalNavigationBase, props);
}
function GlobalNavigationBase({ children }: GlobalNavigationProps) {
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={triggerRef} type="button" className="ck-icon-button rp sidebar-hamburger"
      aria-label="全局导航" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="menu" size={24} />
    </button>
    {children}
    {open && <AnchoredMenu triggerRef={triggerRef} align="left" items={[
      { label: '全局 MCP', icon: 'mcp', onClick: () => { void navigate('/mcp'); } },
      { label: '全局 Skills', icon: 'skills', onClick: () => { void navigate('/skills'); } },
    ]} onClose={() => setOpen(false)} />}
  </>;
}
