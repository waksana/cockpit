import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import type { ChatMessage } from '@cockpit/protocol';
import { Thread } from '../components/Thread';
import { ChatHeader } from '../components/ChatHeader';
import { AnchoredMenu } from '../components/AnchoredMenu';
import { sessionActionItems } from '../lib/sessionActions';
import { UxErrorNotifications } from '../components/UxErrorNotifications';
import { getSessionDraft } from '../lib/textDraft';
import { useCockpit } from '../net/store';
import { fixtureSession, scenarios, type Scenario } from './chat-fixtures';
import { orderedFixture } from './ordered-fixtures';
import '../styles/index.scss';
import '../components/UxErrorNotifications.scss';
import './chat-lab.scss';

if (!import.meta.env.DEV || import.meta.env.COCKPIT_CHAT_LAB !== true) {
  throw new Error('Start the isolated chat lab with COCKPIT_CHAT_LAB=1.');
}

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
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const draft = getSessionDraft(session.sessionId);
  const compact = query.get('compact') === '1';
  const narrow = query.get('pane') === 'narrow';

  useEffect(() => () => { generation.current++; pending.current.splice(0).forEach(resolve => resolve()); }, []);

  function choose(value: Scenario) {
    generation.current++;
    pending.current.splice(0).forEach(resolve => resolve());
    historyBusy.current = false;
    setMoreOpen(false);
    setScenario(value);
    ordered.current = null;
    setSession(fixtureSession(value));
    history.replaceState(null, '', `/chat-lab.html?scene=${value}${compact ? '&compact=1' : ''}${narrow ? '&pane=narrow' : ''}`);
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
    setSession(value => ({ ...value, loadingHistory: true }));
    window.setTimeout(() => {
      if (generation.current !== owner) return;
      setSession(value => ({ ...value, loadingHistory: false, materialized: true, hasMore: false,
        messages: [...Array.from({ length: 6 }, (_, i): ChatMessage => ({
          id: `older-${i}`, role: i % 2 ? 'assistant' : 'user',
          content: `更早的消息 ${i + 1}。保留当前可见消息的位置。\n\n这是用于历史插入的合成内容。`,
          timestamp: new Date('2026-09-10T09:30:00').getTime() + i * 60_000,
        })), ...value.messages],
      }));
      setReceipt('一次有界合成历史插入；未读取真实历史。');
      historyBusy.current = false;
    }, 900);
  }, [setSession, setReceipt]);
  return <div className="cockpit-shell chat-lab" data-compact={compact || undefined}>
    <details className="lab-controls" open={!compact}>
      <summary>合成场景控制</summary>
    <header className="lab-toolbar">
      <strong>Chat Lab / 开发组件场景</strong>
      <a href="/chat-lab.html?scene=workspace">完整工作区场景</a>
      <label>场景 <select value={scenario} onChange={e => choose(e.target.value as Scenario)}>
        {scenarios.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
      </select></label>
      <label><input type="checkbox" checked={fail} onChange={e => setFail(e.target.checked)} />模拟失败</label>
      <label><input type="checkbox" checked={hold} onChange={e => setHold(e.target.checked)} />保持请求中</label>
      <button onClick={() => pending.current.splice(0).forEach(resolve => resolve())}>释放结果</button>
      <button onClick={() => {
        const connected = useCockpit.getState().connState === 'open';
        useCockpit.setState({ connState: connected ? 'connecting' : 'open' });
        setReceipt(connected ? '连接关闭（合成）' : '连接打开（合成）');
      }}>切换连接</button>
      <button onClick={() => {
        draft.edit('一段保留的草稿。');
      }}>草稿样例</button>
      <button onClick={() => append('新消息到达。正在上翻时应显示新消息入口，不应强跳。')}>追加消息</button>
      <button onClick={() => setSession(value => ({ ...value, messages: value.messages.map((m, i) => i === value.messages.length - 1
        ? { ...m, content: `${m.content}更加清楚。流式增量也不应打断上翻阅读。` } : m) }))}>流式一步</button>
      <button onClick={() => setSession(value => ({ ...value, status: 'idle', compacting: false, intent: null }))}>结束回合</button>
      <button onClick={loadMore}>插入历史 / 完成加载</button>
      {scenario === 'history-loading' && <button onClick={() => setSession(value => ({
        ...value, loadingHistory: !value.loadingHistory,
      }))}>切换分页请求状态</button>}
      <button onClick={() => choose(scenario)}>重置场景</button>
      {scenario === 'ordered-events' && <>
        <button onClick={() => orderedAction('thought')}>追加思考事件</button>
        <button onClick={() => orderedAction('body')}>追加正文事件</button>
        <button onClick={() => orderedAction('tool')}>追加工具事件</button>
        <button onClick={() => orderedAction('older')}>前插原生事件</button>
        <button onClick={() => orderedAction('duplicate')}>重复事件页</button>
        <button onClick={() => orderedAction('streamStep')}>逐条推进流式事件</button>
        <button onClick={() => orderedAction('reconnect')}>断线并补全</button>
        <button onClick={() => orderedAction('cold')}>同记录冷加载</button>
      </>}
    </header>
    <output className="lab-receipt" aria-live="polite">{receipt}</output>
    </details>
    <div className="lab-stage" data-narrow={narrow || undefined}>
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
        onSend={(text) => action('发送', () => append(text, 'user'))}
        onRespondAsk={(id, answer, freeform) => action(`${id} / ${answer} / freeform=${freeform}`, () => {
          setSession(value => ({ ...value, ask: null })); append(answer, 'user', 'ask-reply', session.ask?.question);
        })}
        onRespondPlan={(id, answer) => action(`${id} / ${answer}`, () => setSession(value => ({ ...value, planRequest: null })))}
        onPlanSupersede={(id, text) => action(`${id} / 新指令`, () => {
          setSession(value => ({ ...value, planRequest: null })); append(text, 'user');
        })}
        onRespondElicitation={(id, answer) => action(`${id} / ${answer}`, () => setSession(value => ({ ...value, elicitation: null })))}
        onRemoveQueued={id => { setReceipt(`移除队列项：${id}`); setSession(value => ({ ...value, queue: value.queue?.filter(q => q.id !== id) })); }}
        onCancel={() => { setReceipt('停止回调：清空队列；没有中断任何真实工作。'); setSession(value => ({
          ...value, status: 'idle', queue: [], ask: null, planRequest: null, elicitation: null,
        })); append('本次执行已取消（合成记录）。', 'system'); }}
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
if (new URLSearchParams(location.search).get('scene') === 'workspace') {
  const { installWorkspaceFixture, workspaceSessionId, workspaceDraft } = await import('./workspace-fixtures');
  installWorkspaceFixture(useCockpit);
  getSessionDraft(workspaceSessionId).edit(workspaceDraft);
  const { default: App } = await import('../App');
  root.render(<MemoryRouter initialEntries={[`/session/${workspaceSessionId}/info`]}>
    <App /><UxErrorNotifications />
  </MemoryRouter>);
} else {
  root.render(<BrowserRouter><Lab /></BrowserRouter>);
}
