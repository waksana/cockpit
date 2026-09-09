import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { useCockpit } from '../net/store';
import { AnchoredMenu } from './AnchoredMenu';
import { Icon } from './Icon';

const NotificationSettings = lazy(() => import('./NotificationSettings')
  .then((module) => ({ default: module.NotificationSettings })));

type GlobalSection = 'mcp' | 'skills' | 'trash' | 'files';

export function GlobalNavigation() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const {
    notifications, enableNotifications, refreshNotifications, disableNotifications, testNotifications,
  } = useCockpit(useShallow((s) => ({
    notifications: s.notifications, enableNotifications: s.enableNotifications,
    refreshNotifications: s.refreshNotifications, disableNotifications: s.disableNotifications,
    testNotifications: s.testNotifications,
  })));

  const openSection = (section: GlobalSection) => { void navigate(`/${section}`); };
  useLayoutEffect(() => {
    if (pathname === '/') triggerRef.current?.focus();
  }, [pathname]);

  return (
    <>
      <button ref={triggerRef} type="button" className="btn-icon rp sidebar-hamburger"
        aria-label="全局导航" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="menu" size={24} />
      </button>
      {open && (
        <AnchoredMenu triggerRef={triggerRef} align="left" items={[
          { label: '文件', icon: 'file', onClick: () => openSection('files') },
          { label: '全局 MCP', icon: 'mcp', onClick: () => openSection('mcp') },
          { label: '全局 Skills', icon: 'skills', onClick: () => openSection('skills') },
          { label: '垃圾桶', icon: 'delete', onClick: () => openSection('trash') },
          {
            label: '通知设置', icon: notifications.ready ? 'check' : 'reload',
            onClick: () => {
              setNotificationsOpen(true);
              void refreshNotifications();
            },
          },
        ]} onClose={() => setOpen(false)} />
      )}
      {notificationsOpen && (
        <Suspense fallback={null}>
          <NotificationSettings state={notifications} onRefresh={refreshNotifications}
            onEnable={enableNotifications} onDisable={disableNotifications} onTest={testNotifications}
            onClose={() => setNotificationsOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
