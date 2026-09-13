import { useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnchoredMenu } from './AnchoredMenu';
import { Icon } from './Icon';

export function GlobalNavigation() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (pathname === '/') triggerRef.current?.focus();
  }, [pathname]);
  return <>
    <button ref={triggerRef} type="button" className="btn-icon rp sidebar-hamburger"
      aria-label="全局导航" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="menu" size={24} />
    </button>
    {open && <AnchoredMenu triggerRef={triggerRef} align="left" items={[
      { label: '全局 MCP', icon: 'mcp', onClick: () => { void navigate('/mcp'); } },
      { label: '全局 Skills', icon: 'skills', onClick: () => { void navigate('/skills'); } },
    ]} onClose={() => setOpen(false)} />}
  </>;
}
