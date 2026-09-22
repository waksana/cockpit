import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus } from 'lucide-react';
import { Alert, AlertDescription, Button, Input } from '@cockpit/ui';
import { useCockpit } from '../net/store';
import { createSessionMetadataSelector } from '../lib/sessionSelectors';
import { recordLocation, useUp } from '../lib/nav';
import { detailsNavigation, focusedSessionId, sessionNavigation, sessionPath, sessionRoute } from '../lib/routeOwnership';
import { MASTER_DOCK_QUERY, PHONE_QUERY } from '../lib/layout';
import { useMediaQuery } from '../lib/useMediaQuery';
import { moduleRuntime } from '../lib/moduleRuntime';
import { observeModuleView } from '../lib/moduleView';
import type { SessionActionHandlers } from '../lib/sessionActions';
import { filterSessions } from '../pages/session-list';
import { Conversation } from './conversation/Conversation';
import { Resources } from './resources/Resources';
import { SessionActions } from './SessionActions';
import { SessionList } from './SessionList';
import { SessionInspector } from './SessionInspector';
import { GlobalNavigation } from './GlobalNavigation';
import { NewSessionDialog } from './NewSessionDialog';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { Errors } from './Feedback';
import './styles.css';

export default function App({ moduleBootstrap }: { moduleBootstrap: 'loading' | 'settled' }) {
  const location = useLocation();
  const navigate = useNavigate();
  const up = useUp();
  const route = sessionRoute(location.pathname);
  const resourceMatch = matchPath('/:section/:item?', location.pathname);
  const resourceSection = resourceMatch?.params.section === 'mcp' || resourceMatch?.params.section === 'skills'
    ? resourceMatch.params.section : null;
  const home = location.pathname === '/';
  const selector = useMemo(() => createSessionMetadataSelector(), []);
  const sessions = useCockpit(selector);
  const snapshotReady = useCockpit(state => state.snapshotReady);
  const connected = useCockpit(state => state.connState === 'open');
  const globalModels = useCockpit(state => state.globalModels);
  const activeId = useCockpit(state => state.activeId);
  const active = sessions.find(session => session.sessionId === route.sessionId);
  const phone = useMediaQuery(PHONE_QUERY);
  const masterDocked = useMediaQuery(MASTER_DOCK_QUERY);
  const [query, setQuery] = useState('');
  const [creation, setCreation] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<{ id: string; name: string; routeKey: string } | null>(null);
  const focusedId = focusedSessionId(location.pathname, phone);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const previousPanel = useRef(route.panel);
  const previousRoute = useRef(location.key);
  useLayoutEffect(() => {
    if (activeId !== focusedId) useCockpit.getState().setActiveId(focusedId);
  }, [activeId, focusedId]);
  useLayoutEffect(() => observeModuleView(moduleRuntime, useCockpit, document), []);
  useEffect(() => useCockpit.getState().init(), []);
  useEffect(() => { document.title = 'Cockpit'; }, []);
  useLayoutEffect(() => { recordLocation(location.pathname); }, [location.key, location.pathname]);
  useLayoutEffect(() => {
    if (previousRoute.current === location.key) return;
    previousRoute.current = location.key;
    const focused = document.activeElement;
    if (focused !== document.body && focused instanceof HTMLElement && focused.getClientRects().length > 0) return;
    const destinations = home ? ['.next-session-nav', '.next-main'] : ['.next-main', '.next-session-nav'];
    const destination = destinations.map(selector => document.querySelector<HTMLElement>(selector))
      .find(element => element && element.getClientRects().length > 0);
    destination?.focus();
  }, [location.key, home]);
  useEffect(() => {
    if (previousPanel.current && !route.panel) {
      const trigger = panelTrigger.current;
      const focused = document.activeElement;
      if ((focused === document.body || focused?.matches('.next-main'))
        && trigger?.isConnected && trigger.getClientRects().length && !trigger.closest('[inert]')) {
        trigger.focus({ preventScroll: true });
      }
    }
    previousPanel.current = route.panel;
  }, [route.panel]);
  const select = (id: string) => {
    const destination = sessionNavigation(location.pathname, id);
    void navigate(destination.to, { replace: destination.replace });
  };
  const handlers: SessionActionHandlers = {
    openPanel: (id, panel) => {
      const focused = document.activeElement;
      const menu = focused?.closest('[role="menu"]');
      const triggerId = menu?.getAttribute('aria-labelledby');
      panelTrigger.current = focused instanceof HTMLElement && !menu ? focused
        : (triggerId ? document.getElementById(triggerId) : null)
          ?? Array.from(document.querySelectorAll<HTMLElement>('.next-session-row'))
            .find(row => row.dataset.sessionId === id)?.querySelector('a')
          ?? document.querySelector<HTMLElement>('.next-conversation-identity');
      const destination = detailsNavigation(location.pathname, id, panel);
      void navigate(destination.to, { replace: destination.replace });
    },
    delete: id => {
      const session = useCockpit.getState().sessions.find(value => value.sessionId === id);
      if (session) setDeletion({ id, name: session.title, routeKey: location.key });
    },
  };
  const sessionWorkspace = home || !!route.sessionId;
  const createOpen = creation === location.key;
  const deleteOpen = deletion?.routeKey === location.key ? deletion : null;
  const visible = filterSessions(sessions, query);
  const modelLabel = active && ((active.availableModels ?? globalModels).find(model => model.modelId === active.currentModelId)?.name
    ?? active.currentModelId);
  return <div className="next-app">
    {!connected && <div className="next-connection" role="status">连接已断开，正在重新连接。保留内容仅供参考；草稿仍可编辑。</div>}
    <div className={`next-workspace${sessionWorkspace ? ' next-session-workspace' : ''}`}
      data-conversation={!!route.sessionId} data-panel={!!(active && route.panel)}>
      {sessionWorkspace && <aside className="next-session-nav" aria-label="会话列表" tabIndex={-1}
        inert={!masterDocked && !!route.sessionId}>
        <header className="next-session-nav-heading">
          <GlobalNavigation key={location.key} moduleBootstrap={moduleBootstrap} />
          <div className="next-search"><Input type="search" aria-label="搜索会话、目录或 ID"
            placeholder="搜索会话或目录…" value={query} onChange={event => setQuery(event.target.value)}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
        </header>
        <SessionList sessions={visible} activeId={route.sessionId} snapshotReady={snapshotReady} handlers={handlers} />
        {!visible.length && <p className="next-empty-list" role="status">{!snapshotReady ? '正在同步会话…'
          : query.trim() ? '没有匹配的会话。' : '还没有会话。选择工作目录开始。'}</p>}
        <div className="next-session-create"><Button disabled={!connected || !snapshotReady}
          onClick={() => setCreation(location.key)}><Plus aria-hidden="true" />新建会话</Button></div>
      </aside>}
      <main className="next-main" tabIndex={-1} inert={sessionWorkspace && !masterDocked && !route.sessionId}>
        {route.sessionId ? !active ? <div className="next-page-empty">
          <h1>{snapshotReady ? '会话不存在或已被删除' : '正在同步会话…'}</h1>
          <Button variant="outline" asChild><Link to="/">返回会话列表</Link></Button>
        </div> : <>
          <header className="next-conversation-header">
            <Button className="next-list-back" variant="ghost" size="icon" aria-label="返回会话列表" onClick={() => up('/')}>
              <ArrowLeft aria-hidden="true" /></Button>
            <Button variant="ghost" className="next-conversation-identity"
              aria-label={`查看会话信息：${active.title}`} onClick={() => handlers.openPanel(active.sessionId, 'info')}>
              <span className="next-conversation-title">{active.title}</span>
              {modelLabel && <span className="next-conversation-model">{modelLabel}</span>}
            </Button>
            <SessionActions session={active} handlers={handlers} />
          </header>
          {focusedId === active.sessionId && <Conversation sessionId={active.sessionId} moduleBootstrap={moduleBootstrap} />}
        </> : resourceSection ? <>
          <div className="next-page-toolbar"><GlobalNavigation key={location.key} moduleBootstrap={moduleBootstrap} />
            <Button variant="ghost" onClick={() => up(resourceMatch?.params.item ? `/${resourceSection}` : '/')}>
            <ArrowLeft aria-hidden="true" />{resourceMatch?.params.item ? '返回资源列表' : '返回会话'}</Button></div>
          <div className="next-page-scroll"><Resources section={resourceSection} item={resourceMatch?.params.item ?? null} /></div>
        </> : home ? <div className="next-page-empty next-welcome">
          <p>选择一个会话，或新建会话。</p>
        </div> : <div className="next-page-empty"><Alert><AlertDescription>页面不存在。</AlertDescription></Alert>
          <Button asChild><Link to="/">返回会话</Link></Button></div>}
      </main>
      {active && route.panel && <SessionInspector key={active.sessionId} sessionId={active.sessionId}
        panel={route.panel} onClose={() => up(sessionPath(active.sessionId))} />}
    </div>
    {!createOpen && !deleteOpen && !(active && route.panel) && <Errors />}
    {createOpen && <NewSessionDialog key={location.key} onClose={() => setCreation(null)} onCreated={select} />}
    {deleteOpen && <DeleteSessionDialog key={`${deleteOpen.routeKey}:${deleteOpen.id}`} sessionId={deleteOpen.id} name={deleteOpen.name}
      onClose={() => setDeletion(null)} onDeleted={() => { if (route.sessionId === deleteOpen.id) void navigate('/', { replace: true }); }} />}
  </div>;
}
