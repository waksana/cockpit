import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { deliveryAttention, loadDeliveryStatus } from '../lib/deliveryStatus';
import { useKeyedResource } from '../lib/useKeyedResource';
import { useLocation, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { useCockpit } from '../net/store';
import { AnchoredMenu } from './AnchoredMenu';
import { Icon } from './Icon';

const NotificationSettings = lazy(() => import('./NotificationSettings')
  .then((module) => ({ default: module.NotificationSettings })));
const SystemVersions = lazy(() => import('./SystemVersions').then(module => ({ default: module.SystemVersions })));
const ModuleList = lazy(() => import('./Modules').then(module => ({ default: module.ModuleList })));

type GlobalSection = 'mcp' | 'skills' | 'files';

export function GlobalNavigation() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const versions = useKeyedResource('system-versions', loadDeliveryStatus, 0, open || versionsOpen);
  const versionStatus = versions.valid ? versions.data ?? null : null;
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
          { label: `系统 / 版本与更新${deliveryAttention(versionStatus) ? ' · 有待更新或失败' : versions.error ? ' · 状态未知' : ''}`,
            icon: 'reload', onClick: () => setVersionsOpen(true) },
          { label: '文件', icon: 'file', onClick: () => openSection('files') },
          { label: '模块管理', icon: 'skills', onClick: () => setModulesOpen(true) },
          { label: '全局 MCP', icon: 'mcp', onClick: () => openSection('mcp') },
          { label: '全局 Skills', icon: 'skills', onClick: () => openSection('skills') },
          {
            label: '通知设置', icon: notifications.ready ? 'check' : 'reload',
            onClick: () => {
              setNotificationsOpen(true);
              void refreshNotifications();
            },
          },
        ]} onClose={() => setOpen(false)} />
      )}
      {versionsOpen && <Suspense fallback={null}>
        <SystemVersions status={versionStatus} error={versions.connected ? versions.error : 'Cockpit 连接未就绪，运行版本未知'} loading={versions.pending}
          onRefresh={() => { void versions.refresh(); }} onClose={() => setVersionsOpen(false)} />
      </Suspense>}
      {modulesOpen && <Suspense fallback={null}><ModuleList onClose={() => setModulesOpen(false)} /></Suspense>}
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
