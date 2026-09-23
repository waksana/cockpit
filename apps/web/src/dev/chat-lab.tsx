import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import type { ChatMessage } from '@cockpit/protocol';
import { Thread } from '../components/Thread';
import { ChatHeader } from '../components/ChatHeader';
import { AnchoredMenu } from '../components/AnchoredMenu';
import { sessionActionItems } from '../lib/sessionActions';
import { UxErrorNotifications } from '../components/UxErrorNotifications';
import { getDraftSession, getSessionDraft } from '../lib/draftSelection';
import { installNativeDialogFocus } from '../lib/nativeDialogFocus';
import { useCockpit } from '../net/store';
import { fixtureSession, scenarios, type Scenario } from './chat-fixtures';
import { orderedFixture } from './ordered-fixtures';
import { Sidebar } from '../components/Sidebar';
import '../styles/index.scss';
import '../components/UxErrorNotifications.scss';
import './chat-lab.scss';

if (!import.meta.env.DEV || import.meta.env.COCKPIT_CHAT_LAB !== true) {
  throw new Error('Start the isolated chat lab with COCKPIT_CHAT_LAB=1.');
}
const removeDialogFocus = installNativeDialogFocus(document);
import.meta.hot?.dispose(removeDialogFocus);

// Component scenes have no transport. The workspace scene below mounts the real
// App with an isolated store; unhandled HTTP is rejected by the Vite lab server too.
useCockpit.setState({ connState: 'open', snapshotReady: true });

export function Lab() {
  const query = new URLSearchParams(location.search);
  const initial = scenarios.find(([id]) => id === query.get('scene'))?.[0] ?? 'all';
  const [scenario, setScenario] = useState<Scenario>(initial);
  const [session, setSession] = useState(() => fixtureSession(initial));
  const [receipt, setReceipt] = useState('仅合成输入；无原生会话、无后端连接。');
  const [fail, setFail] = useState(false);
  const [hold, setHold] = useState(false);
  const pending = useRef<(() => void)[]>([]);
  const generation = useRef(0);
  const counter = useRef(0);
  const ordered = useRef<ReturnType<typeof orderedFixture> | null>(null);
  const historyBusy = useRef(false);
  const historyPage = useRef(0);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const draft = getDraftSession(session.sessionId).current(session);
  const compact = query.get('compact') === '1';
  const narrow = query.get('pane') === 'narrow';
  const shortHistory = query.get('short') === '1';
  const lateFrame = query.get('frame') === '1';

  useEffect(() => () => { generation.current++; pending.current.splice(0).forEach(resolve => resolve()); }, []);

  useEffect(() => {
    if (scenario !== 'initial-history' || session.materialized) return;
    let frame: number | undefined;
    const timer = window.setTimeout(() => {
      const source = fixtureSession(shortHistory ? 'user-time' : 'reading');
      const deliver = () => setSession(value => ({ ...value, materialized: true, loadingHistory: false, hasMore: false,
        messages: source.messages.map(message => ({ ...message,
          origin: message.origin ? { ...message.origin, sessionId: value.sessionId } : undefined,
        })),
      }));
      // Exercise a commit after this frame's RAF callbacks have begun: a newly
      // queued scroll RAF cannot run before this content's first paint.
      if (lateFrame) frame = requestAnimationFrame(() => flushSync(deliver));
      else deliver();
    }, 300);
    return () => {
      window.clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [scenario, session.materialized, shortHistory, lateFrame]);

  function choose(value: Scenario) {
    generation.current++;
    pending.current.splice(0).forEach(resolve => resolve());
    historyBusy.current = false;
    historyPage.current = 0;
    setMoreOpen(false);
    setScenario(value);
    ordered.current = null;
    setSession(fixtureSession(value));
    const nextQuery = new URLSearchParams(location.search);
    nextQuery.set('scene', value);
    history.replaceState(null, '', `/chat-lab.html?${nextQuery}`);
    setReceipt(`场景：${value}。操作不会发送到后端。`);
  }
  function orderedAction(action: 'thought' | 'body' | 'tool' | 'older' | 'duplicate' | 'reconnect' | 'cold' | 'streamStep') {
    ordered.current ??= orderedFixture();
    const snapshot = ordered.current[action]();
    setSession(value => ({ ...value, ...snapshot }));
    setReceipt(`合成原生事件：${action}；经过同一 NativeWindow，无后端请求。`);
  }
  async function action(label: string, apply: () => void): Promise<boolean> {
    const owner = generation.current;
    if (hold) await new Promise<void>(resolve => pending.current.push(resolve));
    if (owner !== generation.current) return false;
    setReceipt(`${fail ? '模拟失败' : '组件回调'}：${label}`);
    if (fail) throw new Error(`Synthetic ${label} failure; no request was sent.`);
    apply();
    return true;
  }
  function append(text: string, role: ChatMessage['role'] = 'assistant', subtype?: ChatMessage['subtype'], replyQuestion?: string) {
    setSession(value => ({ ...value, messages: [...value.messages, {
      id: `lab-add-${++counter.current}`, role, content: text, timestamp: Date.now(), subtype, replyQuestion,
    }] }));
  }
  const loadMore = useCallback(() => {
    if (historyBusy.current) return;
    historyBusy.current = true;
    const owner = generation.current;
    const page = ++historyPage.current;
    const progressive = scenario === 'history-progressive';
    setSession(value => ({ ...value, loadingHistory: true }));
    const deliver = () => {
      if (generation.current !== owner) return;
      setSession(value => ({ ...value, loadingHistory: false, materialized: true, hasMore: progressive && page < 8,
        messages: [...Array.from({ length: progressive ? 2 : 6 }, (_, i): ChatMessage => ({
          id: `older-${page}-${i}`, role: i % 2 ? 'assistant' : 'user',
          content: `更早的消息 ${i + 1}。保留当前可见消息的位置。\n\n这是用于历史插入的合成内容。`,
          timestamp: new Date('2026-09-10T09:30:00').getTime() - page * 6 * 60_000 + i * 60_000,
        })), ...value.messages],
      }));
      setReceipt('一次有界合成历史插入；未读取真实历史。');
      historyBusy.current = false;
    };
    window.setTimeout(() => {
      if (lateFrame) requestAnimationFrame(() => flushSync(deliver));
      else deliver();
    }, 900);
  }, [scenario, setSession, setReceipt, lateFrame]);
  return <div className="cockpit-shell chat-lab" data-compact={compact || undefined}>
    <details className="lab-controls" open={!compact}>
      <summary>合成场景控制</summary>
    <header className="lab-toolbar">
      <strong>Chat Lab / 开发组件场景</strong>
      <a className="ck-button" href="/chat-lab.html?scene=workspace">完整工作区场景</a>
      <label>场景 <select className="ck-input" value={scenario} onChange={e => choose(e.target.value as Scenario)}>
        {scenarios.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
      </select></label>
      <label><input type="checkbox" checked={fail} onChange={e => setFail(e.target.checked)} />模拟失败</label>
      <label><input type="checkbox" checked={hold} onChange={e => setHold(e.target.checked)} />保持请求中</label>
      <button type="button" className="ck-button" onClick={() => pending.current.splice(0).forEach(resolve => resolve())}>释放结果</button>
      <button type="button" className="ck-button" onClick={() => {
        const connected = useCockpit.getState().connState === 'open';
        useCockpit.setState({ connState: connected ? 'connecting' : 'open' });
        setReceipt(connected ? '连接关闭（合成）' : '连接打开（合成）');
      }}>切换连接</button>
      <button type="button" className="ck-button" onClick={() => {
        draft.edit('一段保留的草稿。');
      }}>草稿样例</button>
      <button type="button" className="ck-button" onClick={() => append('新消息到达。正在上翻时应显示新消息入口，不应强跳。')}>追加消息</button>
      <button type="button" className="ck-button" onClick={() => setSession(value => ({ ...value, messages: value.messages.map((m, i) => i === value.messages.length - 1
        ? { ...m, content: `${m.content}更加清楚。流式增量也不应打断上翻阅读。` } : m) }))}>流式一步</button>
      <button type="button" className="ck-button" onClick={() => setSession(value => ({ ...value, status: 'idle', compacting: false, intent: null }))}>结束回合</button>
      {scenario === 'input-states' && <label>输入状态 <select className="ck-input" aria-label="输入状态" defaultValue="reading" onChange={event => {
        const target = scenarios.find(([id]) => id === event.target.value);
        if (!target) throw new Error('Unknown synthetic input state');
        setSession(value => ({ ...fixtureSession(target[0]), sessionId: value.sessionId, messages: value.messages }));
      }}>
        <option value="reading">空闲</option>
        <option value="streaming">执行与队列</option>
        <option value="ask">问题</option>
        <option value="choice-only">问题（不允许自由回答）</option>
        <option value="ask-queued">长问题与队列</option>
        <option value="plan-queued">计划</option>
        <option value="elicitation-queued">工具确认</option>
        <option value="compacting">压缩与禁用</option>
      </select></label>}
      {scenario === 'thought-markdown' && <button type="button" className="ck-button" onClick={() => setSession(value => ({
        ...value, messages: value.messages.map(message => ({ ...message, thought: `${message.thought ?? ''}\n\n新增 **思考片段**。` })),
      }))}>追加思考片段</button>}
      <button type="button" className="ck-button" onClick={loadMore}>插入历史 / 完成加载</button>
      {scenario === 'history-loading' && <button type="button" className="ck-button" onClick={() => setSession(value => ({
        ...value, loadingHistory: !value.loadingHistory,
      }))}>切换分页请求状态</button>}
      <button type="button" className="ck-button" onClick={() => choose(scenario)}>重置场景</button>
      {session.ask && <><button type="button" className="ck-button" onClick={() => setSession(value => ({
        ...value, ask: value.ask ? { ...value.ask, question: `${value.ask.question}\n补充说明：更新同一问题不会自动展开卡片。` } : null,
      }))}>更新当前问题</button><button type="button" className="ck-button" onClick={() => setSession(value => ({
        ...value, ask: value.ask ? { ...value.ask, requestId: `lab-question-${++counter.current}`,
          question: '这是下一个原生问题的合成输入；新问题应使用独立的空白回答草稿。' } : null,
      }))}>下一问题</button></>}
      {scenario === 'ordered-events' && <>
        <button type="button" className="ck-button" onClick={() => orderedAction('thought')}>追加思考事件</button>
        <button type="button" className="ck-button" onClick={() => orderedAction('body')}>追加正文事件</button>
        <button type="button" className="ck-button" onClick={() => orderedAction('tool')}>追加工具事件</button>
        <button type="button" className="ck-button" onClick={() => orderedAction('older')}>前插原生事件</button>
        <button type="button" className="ck-button" onClick={() => orderedAction('duplicate')}>重复事件页</button>
        <button type="button" className="ck-button" onClick={() => orderedAction('streamStep')}>逐条推进流式事件</button>
        <button type="button" className="ck-button" onClick={() => orderedAction('reconnect')}>断线并补全</button>
        <button type="button" className="ck-button" onClick={() => orderedAction('cold')}>同记录冷加载</button>
      </>}
    </header>
    <output className="lab-receipt" aria-live="polite">{receipt}</output>
    </details>
    <div className="lab-stage" data-narrow={narrow || undefined}>
      {scenario.startsWith('activity-') && <Sidebar sessions={[session]} activeId={session.sessionId}
        query="" snapshotReady connected={useCockpit.getState().connState === 'open'}
        onSelect={() => {}} getMenuItems={() => []} />}
      <ChatHeader title={`${session.title} · 长标题与会话入口边界`} modelLabel="Synthetic model · no native connection"
        moreRef={moreRef} moreOpen={moreOpen}
        onBack={() => setReceipt('返回入口回调（导航不在此场景内执行）。')}
        onInfo={() => setReceipt('会话信息入口回调；管理面板由独立组件用例覆盖。')}
        onMore={() => setMoreOpen(true)} />
      <Thread key={scenario} session={session} readOnly={scenario === 'readonly'}
        onLoadMore={loadMore}
        onRetryHistory={() => {
          setReceipt('显式重读回调；未发出网络请求。');
          setSession(value => ({ ...value, historyError: undefined, error: null, historyStale: false, partialHistory: false, incompleteBoundary: false, materialized: true }));
        }}
        onSend={request => action(request.intent, () => {
          if (request.intent === 'prompt') append(request.body.text, 'user');
          if (request.intent === 'respondAsk') {
            setSession(value => ({ ...value, ask: null }));
            append(request.body.answer, 'user', 'ask-reply', session.ask?.question);
          }
          if (request.intent === 'planSupersede') {
            setSession(value => ({ ...value, planRequest: null }));
            append(request.body.message, 'user');
          }
        })}
        onRespondAsk={(id, answer, freeform) => action(`${id} / ${answer} / freeform=${freeform}`, () => {
          setSession(value => ({ ...value, ask: null })); append(answer, 'user', 'ask-reply', session.ask?.question);
        })}
        onRespondPlan={(id, answer) => action(`${id} / ${answer}`, () => setSession(value => ({ ...value, planRequest: null })))}
        onRespondElicitation={(id, answer) => action(`${id} / ${answer}`, () => setSession(value => ({ ...value, elicitation: null })))}
        onRemoveQueued={id => { setReceipt(`移除队列项：${id}`); setSession(value => ({ ...value, queue: value.queue?.filter(q => q.id !== id) })); }}
        onCancel={async () => {
          const owner = generation.current;
          setSession(value => ({ ...value, cancelling: true }));
          try { await action('停止并清空队列（合成）', () => {
            setSession(value => ({
              ...value, cancelling: false, status: value.activity?.tasks.activeShells ? 'running' : 'idle',
              queue: [], ask: null, planRequest: null, elicitation: null,
              activity: value.activity ? { ...value.activity, processing: false, abortable: false,
                hasActiveWork: !!(value.activity.tasks.activeShells || value.activity.tasks.activeAgents),
                queue: { pendingCount: 0, steeringCount: 0, inFlightSteeringCount: 0 } } : null,
            }));
          }); } finally {
            if (owner === generation.current) setSession(value => ({ ...value, cancelling: false }));
          }
        }}
        onInterrupt={async () => {
          await action('打断并保留队列', () => setSession(value => ({
            ...value, status: 'idle', ask: null, planRequest: null, elicitation: null,
          })));
          return { ok: true, interrupted: true };
        }}
      />
      {moreOpen && <AnchoredMenu triggerRef={moreRef} label={session.title} onClose={() => setMoreOpen(false)}
        items={sessionActionItems(session, true, {
          openPanel: (_id, panel) => setReceipt(`面板入口：${panel ?? 'info'}；这里只展示导航回调。`),
          delete: () => setReceipt('删除入口回调；没有调用原生删除。'),
        })} />}
    </div>
    <UxErrorNotifications />
  </div>;
}

const root = createRoot(document.getElementById('root')!);
const scene = new URLSearchParams(location.search).get('scene');
if (scene === 'dialog-focus') {
  const { DialogFocusLab } = await import('./dialog-focus-lab');
  const modules = new URLSearchParams(location.search).get('modules') === '1';
  if (modules) {
    const { moduleRuntime } = await import('../lib/moduleRuntime');
    await moduleRuntime.start('');
    if (!moduleRuntime.getSnapshot().some(module => module.asset.id === 'cockpit-file')) {
      throw new Error('The dialog focus scene requires COCKPIT_LAB_FILE_ROOT when modules=1.');
    }
    window.addEventListener('pagehide', () => moduleRuntime.stop(), { once: true });
  }
  root.render(<DialogFocusLab modules={modules} />);
} else if (scene === 'full-web') {
  const { installFullWebFixture } = await import('./full-web-fixtures');
  const id = installFullWebFixture(useCockpit, new URLSearchParams(location.search).get('case') ?? 'mixed');
  const { default: App } = await import('../App');
  root.render(<MemoryRouter initialEntries={[`/session/${id}`]}><App /><UxErrorNotifications /></MemoryRouter>);
} else if (scene === 'control-design') {
  const { ControlDesignLab } = await import('./control-design-lab');
  root.render(<BrowserRouter><ControlDesignLab /></BrowserRouter>);
} else if (scene === 'activity-design') {
  const { ActivityDesignLab } = await import('./activity-design-lab');
  root.render(<BrowserRouter><ActivityDesignLab /></BrowserRouter>);
} else if (scene === 'workspace' || scene === 'resources' || scene === 'sidebar') {
  const { installWorkspaceFixture, workspaceSessionId, workspaceDraft } = await import('./workspace-fixtures');
  installWorkspaceFixture(useCockpit);
  if (scene === 'sidebar') {
    const { sidebarSessions } = await import('./sidebar-fixtures');
    useCockpit.setState({ sessions: sidebarSessions(), activityRefreshingIds: ['demo-tests'] });
  }
  if (scene === 'resources') {
    const { installResourceFixture } = await import('./resource-fixtures');
    const query = new URLSearchParams(location.search);
    installResourceFixture(useCockpit, query.get('longNames') === '1', {
      empty: query.get('empty') === '1',
      fail: query.get('fail') === '1',
      failMutations: query.get('failMutations') === '1',
      designCases: query.get('case') === 'design',
      beforeRequest: query.get('delay') === '1' ? () => new Promise(resolve => setTimeout(resolve, 1200)) : undefined,
    });
  }
  getSessionDraft(workspaceSessionId).edit(workspaceDraft);
  const { default: App } = await import('../App');
  const page = new URLSearchParams(location.search).get('page');
  const item = new URLSearchParams(location.search).get('item');
  const initialRoute = scene === 'sidebar' ? '/' : scene === 'resources' && (page === 'mcp' || page === 'skills')
    ? `/${page}${item ? `/${encodeURIComponent(item)}` : ''}` : scene === 'resources' && (page === 'session-mcp' || page === 'session-skills')
      ? `/session/${workspaceSessionId}/${page.slice('session-'.length)}` : `/session/${workspaceSessionId}/info`;
  const app = <MemoryRouter initialEntries={[initialRoute]}>
    <App /><UxErrorNotifications />
  </MemoryRouter>;
  if (scene === 'sidebar') {
    const { createSidebarModuleFixture } = await import('./sidebar-fixtures');
    const { ModuleRuntimeProvider } = await import('../components/ModuleComponents');
    const runtime = createSidebarModuleFixture();
    await runtime.start();
    window.addEventListener('pagehide', () => runtime.stop(), { once: true });
    root.render(<ModuleRuntimeProvider runtime={runtime}>{app}</ModuleRuntimeProvider>);
  } else root.render(app);
} else {
  const lab = <BrowserRouter><Lab /></BrowserRouter>;
  if (new URLSearchParams(location.search).get('cards') === '1') {
    const { createAsyncCardFixture } = await import('./initial-history-fixture');
    const { ModuleRuntimeProvider } = await import('../components/ModuleComponents');
    const runtime = createAsyncCardFixture();
    await runtime.start();
    window.addEventListener('pagehide', () => runtime.stop(), { once: true });
    root.render(<ModuleRuntimeProvider runtime={runtime}>{lab}</ModuleRuntimeProvider>);
  } else root.render(lab);
}
