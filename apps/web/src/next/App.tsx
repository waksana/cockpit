import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Menu, Plus, Search, Settings } from 'lucide-react';
import {
  Alert, AlertDescription, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger, Input,
} from '@cockpit/ui';
import { useCockpit } from '../net/store';
import { createSessionMetadataSelector } from '../lib/sessionSelectors';
import { recordLocation, useUp } from '../lib/nav';
import { sessionNavigation, sessionPath, sessionRoute, type SessionPanel } from '../lib/routeOwnership';
import { moduleRuntime } from '../lib/moduleRuntime';
import { observeModuleView } from '../lib/moduleView';
import type { SessionActionHandlers } from '../lib/sessionActions';
import { filterSessions } from '../pages/session-list';
import { Conversation } from './conversation/Conversation';
import { SessionSettings } from './settings/SessionSettings';
import { Resources } from './resources/Resources';
import { SessionActions, SessionContextMenu } from './SessionActions';
import { NewSessionDialog } from './NewSessionDialog';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { Errors } from './Feedback';
import { SessionStatus, useRegisteredMenu } from './modules';
import './styles.css';

function GlobalItems() {
  const items = useRegisteredMenu([], { menu: 'global' });
  return <>
    {items.map(item => <DropdownMenuItem key={item.id ?? item.label} disabled={item.disabled}
      variant={item.destructive ? 'destructive' : 'default'} onSelect={item.onClick}>
      {item.iconContent && <span aria-hidden="true">{item.iconContent}</span>}{item.label}
    </DropdownMenuItem>)}
    {items.length > 0 && <DropdownMenuSeparator />}
    <DropdownMenuItem asChild><a href="/">打开经典界面 <ArrowUpRight aria-hidden="true" /></a></DropdownMenuItem>
  </>;
}

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
  const activeId = useCockpit(state => state.activeId);
  const active = sessions.find(session => session.sessionId === route.sessionId);
  const [query, setQuery] = useState('');
  const [creation, setCreation] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<{ id: string; name: string; routeKey: string } | null>(null);
  const unavailable = useSyncExternalStore(moduleRuntime.subscribe, moduleRuntime.getUnavailablePresentations, moduleRuntime.getUnavailablePresentations);
  const focusedId = route.panel === null ? route.sessionId : null;
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
    const destination = Array.from(document.querySelectorAll<HTMLElement>('.next-main, .next-session-nav'))
      .find(element => element.getClientRects().length > 0);
    destination?.focus();
  }, [location.key]);
  const select = (id: string) => {
    const destination = sessionNavigation(location.pathname, id);
    void navigate(destination.to, { replace: destination.replace });
  };
  const handlers: SessionActionHandlers = {
    openPanel: (id, panel) => { void navigate(sessionPath(id, panel), { replace: route.panel !== null }); },
    reload: id => { void useCockpit.getState().reloadSession(id).catch(() => {}); },
    delete: id => {
      const session = useCockpit.getState().sessions.find(value => value.sessionId === id);
      if (session) setDeletion({ id, name: session.title, routeKey: location.key });
    },
  };
  const sessionWorkspace = home || !!route.sessionId && !route.panel;
  const createOpen = creation === location.key;
  const deleteOpen = deletion?.routeKey === location.key ? deletion : null;
  const visible = filterSessions(sessions, query);
  const tabs: [SessionPanel, string][] = [['info', '一般与模型'], ['mcp', 'MCP'], ['skills', 'Skills']];
  return <div className="next-app">
    <header className="next-app-header">
      <Link className="next-brand" to="/">Cockpit</Link>
      <nav aria-label="工作区">
        <NavLink to="/" end>会话</NavLink>
        <NavLink to="/mcp">全局 MCP</NavLink>
        <NavLink to="/skills">全局 Skills</NavLink>
      </nav>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="扩展与界面">
        <Menu aria-hidden="true" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><GlobalItems /></DropdownMenuContent>
      </DropdownMenu>
    </header>
    {!connected && <div className="next-connection" role="status">连接已断开，正在重新连接。保留内容仅供参考；草稿仍可编辑。</div>}
    {moduleBootstrap === 'settled' && unavailable.length > 0 && <details className="next-classic-only">
      <summary>部分扩展仅提供经典界面</summary>
      <p>{unavailable.map(module => module.name).join('、')}尚未提供新界面；这不代表模块后端已停用。<a href="/">前往经典界面</a></p>
    </details>}
    <div className={`next-workspace${sessionWorkspace ? ' next-session-workspace' : ''}`} data-conversation={!!route.sessionId && !route.panel}>
      {sessionWorkspace && <aside className="next-session-nav" aria-label="会话列表" tabIndex={-1}>
        <div className="next-session-nav-heading"><h1>会话</h1><Button size="sm" disabled={!connected || !snapshotReady}
          onClick={() => setCreation(location.key)}><Plus aria-hidden="true" />新建会话</Button></div>
        <div className="next-search"><Search aria-hidden="true" /><Input type="search" aria-label="搜索会话、目录或 ID"
          placeholder="搜索会话、目录或 ID" value={query} onChange={event => setQuery(event.target.value)}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div>
        <ul className="next-session-list" aria-busy={!snapshotReady}>
          {visible.map(session => <li key={session.sessionId}>
            <SessionContextMenu session={session} handlers={handlers}>
              <div className="next-session-row" data-active={session.sessionId === route.sessionId}>
                <Link to={sessionPath(session.sessionId)} replace={route.sessionId !== null}
                  aria-current={session.sessionId === route.sessionId ? 'page' : undefined}>
                  <span className="next-session-title">{session.title}</span>
                  <span className="next-session-directory">{session.cwd || '工作目录未提供'}</span>
                  <SessionStatus sessionId={session.sessionId} status={session.status}
                    needsDecision={!!(session.ask || session.planRequest || session.elicitation)} />
                </Link>
                <SessionActions session={session} handlers={handlers} />
              </div>
            </SessionContextMenu>
          </li>)}
        </ul>
        {!visible.length && <p className="next-empty-list" role="status">{!snapshotReady ? '正在同步会话…'
          : query.trim() ? '没有匹配的会话。' : '还没有会话。选择工作目录开始。'}</p>}
      </aside>}
      <main className="next-main" tabIndex={-1}>
        {route.sessionId ? !active ? <div className="next-page-empty">
          <h1>{snapshotReady ? '会话不存在或已被删除' : '正在同步会话…'}</h1>
          <Button variant="outline" asChild><Link to="/">返回会话列表</Link></Button>
        </div> : route.panel ? <>
          <div className="next-page-toolbar">
            <Button variant="ghost" onClick={() => up(sessionPath(active.sessionId))}><ArrowLeft aria-hidden="true" />返回对话</Button>
            <SessionActions session={active} handlers={handlers} />
          </div>
          <nav className="next-settings-tabs" aria-label="会话设置">
            {tabs.map(([panel, label]) => <NavLink key={panel} to={sessionPath(active.sessionId, panel)} replace>{label}</NavLink>)}
          </nav>
          <div className="next-page-scroll"><SessionSettings sessionId={active.sessionId} panel={route.panel} /></div>
        </> : <>
          <header className="next-conversation-header">
            <Button className="next-list-back" variant="ghost" size="icon" aria-label="返回会话列表" onClick={() => up('/')}>
              <ArrowLeft aria-hidden="true" /></Button>
            <div className="next-conversation-identity"><h1>{active.title}</h1>
              <p>{active.cwd || '工作目录未提供'}{active.currentModelId && <> · {active.currentModelId}</>}</p></div>
            <Button variant="outline" asChild><Link to={sessionPath(active.sessionId, 'info')}><Settings aria-hidden="true" /><span>设置</span></Link></Button>
            <SessionActions session={active} handlers={handlers} />
          </header>
          <Conversation sessionId={active.sessionId} moduleBootstrap={moduleBootstrap} />
        </> : resourceSection ? <>
          <div className="next-page-toolbar"><Button variant="ghost" onClick={() => up(resourceMatch?.params.item ? `/${resourceSection}` : '/')}>
            <ArrowLeft aria-hidden="true" />{resourceMatch?.params.item ? '返回资源列表' : '返回会话'}</Button></div>
          <div className="next-page-scroll"><Resources section={resourceSection} item={resourceMatch?.params.item ?? null} /></div>
        </> : home ? <div className="next-page-empty next-welcome">
          <p className="next-muted">工作区</p><h2>让对话成为工作的起点</h2><p>选择一个会话继续，或选择工作目录开始新会话。</p>
          <Button disabled={!connected || !snapshotReady} onClick={() => setCreation(location.key)}>新建会话</Button>
        </div> : <div className="next-page-empty"><Alert><AlertDescription>页面不存在。</AlertDescription></Alert>
          <Button asChild><Link to="/">返回会话</Link></Button></div>}
      </main>
    </div>
    {!createOpen && !deleteOpen && <Errors />}
    {createOpen && <NewSessionDialog key={location.key} onClose={() => setCreation(null)} onCreated={select} />}
    {deleteOpen && <DeleteSessionDialog key={`${deleteOpen.routeKey}:${deleteOpen.id}`} sessionId={deleteOpen.id} name={deleteOpen.name}
      onClose={() => setDeletion(null)} onDeleted={() => { if (route.sessionId === deleteOpen.id) void navigate('/', { replace: true }); }} />}
  </div>;
}
