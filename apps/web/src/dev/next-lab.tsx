import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@cockpit/ui';
import App from '../next/App';
import { ConversationView } from '../next/conversation/ConversationView';
import { useCockpit } from '../net/store';
import { installHostLeaveProtection } from '../lib/hostLeave';
import { sessionPath, sessionRoute } from '../lib/routeOwnership';
import { scenarios, type Scenario } from './chat-fixtures';
import { installNextLabFixture, nextSessionId, type NextLabFixture } from './next-lab-fixtures';
import { isLabDocumentLink } from './next-lab-isolation';
import type { ModuleLabControls } from './next-lab-module-transport';
import { moduleRuntime } from '../lib/moduleRuntime';
import { nextUi } from '../next/ui';
import { reportUxError, describeReason } from '../lib/errorReporter';
import '@cockpit/ui/styles.css';
import '../next/styles.css';
import '../next/conversation/styles.css';
import './next-lab.css';

export interface FirstContent {
  sessionId: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  bottomGap: number;
}
export interface NextLabControls extends NextLabFixture {
  modules?: ModuleLabControls;
  navigate(path: string): void;
  choose(scene: Scenario): string;
  deliverHistory(lateFrame?: boolean, short?: boolean): void;
  onFirstContent(callback: (event: FirstContent) => void): () => void;
  firstContent: FirstContent[];
}
declare global { interface Window { nextLab: NextLabControls } }

if (!import.meta.env.DEV || import.meta.env.COCKPIT_CHAT_LAB !== true) {
  throw new Error('The next lab is dev-only; enable COCKPIT_CHAT_LAB=1.');
}
const query = new URLSearchParams(location.search);
const fixture = installNextLabFixture(useCockpit);
const initialScene = scenarios.find(([id]) => id === query.get('scene'))?.[0];
const initialId = initialScene ? fixture.scene(initialScene) : nextSessionId;
const component = query.get('view') === 'conversation';
const initialBootstrap = query.get('bootstrap') === 'loading' || query.get('modules') === '1' ? 'loading' : 'settled';
const firstContent: FirstContent[] = [];
const listeners = new Set<(event: FirstContent) => void>();

export function ComponentScene({ id, scene, moduleBootstrap }: { id: string; scene?: Scenario; moduleBootstrap: 'loading' | 'settled' }) {
  const session = useCockpit(state => state.sessions.find(value => value.sessionId === id));
  useLayoutEffect(() => { useCockpit.getState().setActiveId(id); }, [id]);
  if (!session) return <p role="status">Synthetic session was deleted.</p>;
  const actions = useCockpit.getState();
  return <ConversationView session={session} moduleBootstrap={moduleBootstrap} readOnly={scene === 'readonly'}
    onSend={actions.sendDraft}
    onRespondAsk={(request, answer, freeform) => actions.respondAsk(id, request, answer, freeform)}
    onRespondPlan={(request, action) => actions.respondPlan(id, request, action)}
    onRespondElicitation={(request, action) => actions.respondElicitation(id, request, action)}
    onRemoveQueued={item => actions.removeQueued(id, item)}
    onCancel={() => actions.cancel(id)} onInterrupt={() => actions.interrupt(id)}
    onLoadMore={() => actions.loadMore(id)} onRetryHistory={() => actions.retryHistory(id)} />;
}

export function NextLab({ moduleBootstrap, modules }: { moduleBootstrap: 'loading' | 'settled'; modules?: ModuleLabControls }) {
  const navigate = useNavigate();
  const location = useLocation();
  const stage = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState(initialScene);
  const [componentId, setComponentId] = useState(initialId);
  const [notice, setNotice] = useState('');
  const id = component ? componentId : sessionRoute(location.pathname).sessionId ?? initialId;
  const currentId = useRef(id);
  const frames = useRef(new Set<number>());
  const seen = useRef(new Set<string>());
  useLayoutEffect(() => { currentId.current = id; }, [id]);
  const deliverHistory = (lateFrame = false, short = false) => {
    const owner = currentId.current;
    const generation = fixture.generation(owner);
    const deliver = () => {
      if (useCockpit.getState().sessions.some(session => session.sessionId === owner)) {
        flushSync(() => fixture.initialHistory(owner, short, generation));
      }
    };
    if (!lateFrame) deliver();
    else {
      const frame = requestAnimationFrame(() => { frames.current.delete(frame); deliver(); });
      frames.current.add(frame);
    }
  };
  const choose = (value: Scenario) => {
    const selected = fixture.scene(value);
    currentId.current = selected;
    setScene(value);
    setComponentId(selected);
    void navigate(sessionPath(selected));
    return selected;
  };
  useLayoutEffect(() => {
    window.nextLab = {
      ...fixture, choose, deliverHistory, firstContent, modules,
      navigate: path => {
        if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Use a MemoryRouter path');
        void navigate(path);
      },
      onFirstContent: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    };
  });
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;
    // MutationObserver runs after the production layout effects, before paint;
    // sample the first content commit, not a later "looks correct" RAF.
    const sample = () => {
      const viewport = root.querySelector<HTMLElement>('.next-messages');
      const sessionId = viewport?.closest('[data-conversation-session]')?.getAttribute('data-conversation-session');
      if (!sessionId) return;
      const key = `${sessionId}:${fixture.generation(sessionId)}`;
      if (seen.current.has(key) || !viewport?.querySelector('[data-message-frame]')) return;
      seen.current.add(key);
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const event = { sessionId, scrollTop, scrollHeight, clientHeight, bottomGap: scrollHeight - clientHeight - scrollTop };
      firstContent.push(event);
      for (const callback of listeners) callback(event);
    };
    const observer = new MutationObserver(sample);
    observer.observe(root, { childList: true, subtree: true });
    sample();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!scene || !['initial-history', 'history-progressive'].includes(scene)) return;
    const owner = component ? componentId : sessionRoute(location.pathname).sessionId;
    if (!owner || owner !== componentId || !useCockpit.getState().sessions.some(session =>
      session.sessionId === owner && !session.materialized)) return;
    const timer = window.setTimeout(() => {
      if (currentId.current === owner) window.nextLab.deliverHistory(query.get('frame') === '1', query.get('short') === '1');
    }, 300);
    return () => window.clearTimeout(timer);
  }, [scene, componentId, location.pathname]);
  useEffect(() => {
    const ownedFrames = frames.current;
    return () => { ownedFrames.forEach(cancelAnimationFrame); listeners.clear(); };
  }, []);
  useEffect(() => {
    const guard = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      // MemoryRouter has already prevented its own link's default navigation.
      // Production classic/external anchors must not leave this isolated lab.
      if (event.defaultPrevented || !link || isLabDocumentLink(link.getAttribute('href')!, window.location.href)) return;
      event.preventDefault();
      setNotice('Synthetic lab blocked document navigation outside /chat-lab.html. Use the in-memory workspace links.');
    };
    document.addEventListener('click', guard);
    document.addEventListener('auxclick', guard);
    return () => {
      document.removeEventListener('click', guard);
      document.removeEventListener('auxclick', guard);
    };
  }, []);
  return <div className="next-lab">
    <details className="next-lab-controls" open={query.get('compact') !== '1'}>
      <summary>Synthetic next UI lab controls (no backend or saved browser data)</summary>
      <div className="next-lab-toolbar">
        <a href="/chat-lab.html?ui=next&scene=workspace">App workspace</a>
        <a href="/chat-lab.html?ui=next&view=conversation&scene=all">Conversation component</a>
        <label>Scene <select value={scene ?? 'workspace'} onChange={event => {
          const selected = scenarios.find(([value]) => value === event.target.value);
          if (selected) choose(selected[0]);
          else { setScene(undefined); void navigate('/'); }
        }}><option value="workspace">Workspace</option>
          {scenarios.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label><input type="checkbox" onChange={event => fixture.operations.hold(event.target.checked)} /> Hold operations</label>
        <Button variant="outline" onClick={() => fixture.operations.release('success')}>Release</Button>
        <Button variant="outline" onClick={() => fixture.operations.release('fail')}>Fail pending</Button>
        <Button variant="outline" onClick={() => fixture.operations.release('uncertain')}>Uncertain pending</Button>
        <label>Future outcomes <select onChange={event => {
          const value = event.target.value;
          if (value === 'success' || value === 'fail' || value === 'uncertain') fixture.operations.outcome(value);
        }}><option>success</option><option>fail</option><option>uncertain</option></select></label>
        <label><input type="checkbox" onChange={event => fixture.createUncertain(event.target.checked)} /> Create with ID, incomplete ACK</label>
        <Button variant="outline" onClick={() => fixture.draft(id, 'Synthetic retained draft')}>Set draft</Button>
        <Button variant="outline" onClick={() => fixture.replaceRequest(id)}>Replace question</Button>
        <Button variant="outline" onClick={() => fixture.append(id, 'Synthetic appended content')}>Append</Button>
        <Button variant="outline" onClick={() => fixture.stream(id)}>Stream step</Button>
        <Button variant="outline" onClick={() => { void fixture.prepend(id); }}>Prepend history</Button>
        <Button variant="outline" onClick={() => deliverHistory(true, query.get('short') === '1')}>History in late RAF</Button>
        <Button variant="outline" onClick={() => fixture.ordered(id, 'streamStep')}>Native stream step</Button>
        <Button variant="outline" onClick={() => fixture.connected(useCockpit.getState().connState !== 'open')}>Toggle connection</Button>
      </div>
    </details>
    {notice && <p role="status">{notice}</p>}
    <div className="next-lab-stage" ref={stage}>
      {component ? <ComponentScene id={componentId} scene={scene} moduleBootstrap={moduleBootstrap} /> : <App moduleBootstrap={moduleBootstrap} />}
    </div>
  </div>;
}

const root = createRoot(document.getElementById('root')!);
const removeLeaveProtection = installHostLeaveProtection(window);
let disposed = false;
let moduleControls: ModuleLabControls | undefined;
function render(moduleBootstrap: 'loading' | 'settled') {
  root.render(
    <MemoryRouter initialEntries={[query.get('path') ?? (initialScene ? sessionPath(initialId) : '/')]}>
      <NextLab moduleBootstrap={moduleBootstrap} modules={moduleControls} />
    </MemoryRouter>,
  );
}
render(initialBootstrap);

// eslint-disable-next-line react-refresh/only-export-components -- This document entry owns module startup.
export function startModuleLab(controls: ModuleLabControls) {
  if (moduleControls) throw new Error('Module lab was already started');
  moduleControls = controls;
  render('loading');
  void moduleRuntime.start('', nextUi).then(() => {
    if (!disposed) render('settled');
  }, error => {
    if (!disposed) reportUxError(`Synthetic module startup failed: ${describeReason(error)}`);
  });
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true;
  root.unmount();
  moduleRuntime.stop();
  void moduleControls?.dispose().catch(error =>
    reportUxError(`Synthetic module cleanup failed: ${describeReason(error)}`));
  fixture.operations.release('fail');
  removeLeaveProtection();
});
