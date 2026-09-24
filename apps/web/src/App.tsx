// App root. Wires the native session store to the responsive master-detail shell.
// Desktop: sidebar + chat side-by-side. Mobile: list ↔ detail two-level nav.

import { lazy, Suspense, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { Link, Routes, Route, useLocation, useParams } from 'react-router-dom';
import { useCockpit } from './net/store';
import { recordLocation } from './lib/nav';
import { focusedSessionId, SESSION_PANELS } from './lib/routeOwnership';
import { StateNotice } from './components/StateNotice';
import { ManagementShell } from './components/ManagementShell';
import { moduleRuntime } from './lib/moduleRuntime';
import { observeModuleView } from './lib/moduleView';
import { PHONE_QUERY } from './lib/layout';
import { Workspace } from './features/workspace/Workspace';

const ManageWorkspace = lazy(() => import('./components/ManageWorkspace').then((m) => ({ default: m.ManageWorkspace })));

function ManagementRoute() {
  const { pathname } = useLocation();
  const { item } = useParams();
  const section = pathname.startsWith('/skills') ? 'skills' : 'mcp';
  return <Suspense fallback={
    <ManagementShell section={section} item={item ?? null}
      master={<StateNotice kind="loading" placement="pane">加载页面…</StateNotice>}
      detail={<StateNotice kind="loading" placement="pane">加载页面…</StateNotice>} />
  }><ManageWorkspace section={section} /></Suspense>;
}

const phoneSnapshot = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
const serverPhoneSnapshot = () => false;
function subscribePhone(listener: () => void) {
  const query = window.matchMedia?.(PHONE_QUERY);
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

export default function App() {
  const location = useLocation();
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, serverPhoneSnapshot);
  const activeId = useCockpit((s) => s.activeId);
  const setActiveId = useCockpit((s) => s.setActiveId);
  const focusedId = focusedSessionId(location.pathname, phone);
  // Data-layer focus follows visible chat ownership, never the other way around.
  // Global routes and full-page details release the visible chat read.
  useLayoutEffect(() => {
    if (activeId !== focusedId) setActiveId(focusedId);
  }, [activeId, focusedId, setActiveId]);
  useLayoutEffect(() => observeModuleView(moduleRuntime, useCockpit, document), []);
  useEffect(() => { document.title = 'cockpit'; }, []);
  // Single client lifecycle: connect the SSE stream once on mount.
  useEffect(() => useCockpit.getState().init(), []);
  // Track the pathname showing at each history index so useUp() (in lib/nav) can
  // tell when "back" can pop to the real parent vs. must synthesize it. Runs for
  // every navigation across BOTH Workspace and ManageWorkspace.
  useLayoutEffect(() => { recordLocation(location.pathname); }, [location.key, location.pathname]);
  // Session routes share Workspace; global management has its own route shell.
  // Changing a panel preserves Workspace, while visible chat ownership decides
  // whether ConnectedThread is mounted. Neither shell owns native resource data.
  return (
      <Routes>
      <Route path="/" element={<Workspace />} />
      <Route path="/mcp" element={<ManagementRoute />} />
      <Route path="/mcp/:item" element={<ManagementRoute />} />
      <Route path="/skills" element={<ManagementRoute />} />
      <Route path="/skills/:item" element={<ManagementRoute />} />
      <Route path="/session/:sessionId" element={<Workspace />} />
      {SESSION_PANELS.map(panel => (
        <Route key={panel} path={`/session/:sessionId/${panel}`} element={<Workspace />} />
      ))}
      <Route path="*" element={<div className="detail-empty">
        <div><p>页面不存在。</p><Link className="ck-button ck-primary" to="/">返回列表</Link></div>
      </div>} />
      </Routes>
  );
}
