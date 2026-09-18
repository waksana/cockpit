import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnchoredMenu } from './AnchoredMenu';
import { Icon } from './Icon';
import type { GlobalNavigationProps } from '@cockpit/module-api';
import { useModuleElement } from './ModuleComponents';

export function GlobalNavigation({ children }: Pick<GlobalNavigationProps, 'children'>) {
  const navigate = useNavigate();
  return useModuleElement('globalNavigation', GlobalNavigationBase, { children, items: [
    { id: 'cockpit.mcp', label: '全局 MCP', icon: <Icon name="mcp" size={24} />, onClick: () => { void navigate('/mcp'); } },
    { id: 'cockpit.skills', label: '全局 Skills', icon: <Icon name="skills" size={24} />, onClick: () => { void navigate('/skills'); } },
  ] });
}
function GlobalNavigationBase({ children, items }: GlobalNavigationProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button ref={triggerRef} type="button" className="ck-icon-button rp sidebar-hamburger"
      aria-label="全局导航" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="menu" size={24} />
    </button>
    {children}
    {open && <AnchoredMenu triggerRef={triggerRef} align="left"
      items={items.map(({ icon, ...item }) => ({ ...item, iconContent: icon }))} onClose={() => setOpen(false)} />}
  </>;
}
