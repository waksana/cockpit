import { useRef, useState } from 'react';
import { Sidebar } from '../components/Sidebar';
import { Thread } from '../components/Thread';
import { useCockpit } from '../net/store';
import type { ChatSession } from '../net/types';
import { activityFixture } from './activity-fixtures';
import { activityDesignSessions } from './activity-design-fixtures';

export function ActivityDesignLab() {
  const [sessions, setSessions] = useState(activityDesignSessions);
  const [selected, setSelected] = useState('design-processing');
  const [refreshing, setRefreshing] = useState(false);
  const [hold, setHold] = useState(false);
  const [fail, setFail] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const connected = useCockpit(state => state.connState === 'open');
  const session = sessions.find(value => value.sessionId === selected)!;
  const change = (id: string, patch: Partial<ChatSession>) =>
    setSessions(values => values.map(value => value.sessionId === id ? { ...value, ...patch } : value));
  const choose = (id: string) => {
    setSelected(id);
    setRefreshing(false);
    useCockpit.setState({ activityRefreshingIds: [] });
  };
  const result = (kind: 'idle' | 'shell' | 'ask' | 'error') => {
    const replacement = activityDesignSessions().find(value => value.sessionId === `design-${kind}`)!;
    change(selected, { ...replacement, sessionId: selected, title: session.title, activityDisplay: undefined });
    setRefreshing(false);
    useCockpit.setState({ activityRefreshingIds: [] });
  };
  const runControl = async (id: string, interrupt: boolean) => {
    if (hold) await new Promise<void>(resolve => { pending.current = resolve; });
    if (fail) throw new Error('合成操作失败：没有调用真实会话。');
    setSessions(values => values.map(value => {
      if (value.sessionId !== id) return value;
      const tasks = value.activity?.tasks ?? { activeAgents: 0, activeShells: 0, unknown: 0 };
      const remaining = !!(tasks.activeAgents || tasks.activeShells);
      return { ...value, status: remaining || interrupt ? 'running' : 'idle', ask: null, planRequest: null, elicitation: null,
        queue: interrupt ? value.queue : [], activity: activityFixture({ tasks, hasActiveWork: remaining,
          queue: interrupt ? value.activity?.queue ?? activityFixture().queue : activityFixture().queue }) };
    }));
  };
  return <div className="cockpit-shell chat-lab activity-design-lab">
    <header className="lab-toolbar">
      <strong>活动与工具设计预览</strong>
      <span>设计评审 · 仅合成数据 · 无后端</span>
      <label>场景 <select className="ck-input" value={selected} onChange={event => choose(event.target.value)}>
        {sessions.map(value => <option key={value.sessionId} value={value.sessionId}>{value.title}</option>)}
      </select></label>
      <button className="ck-button" disabled={refreshing || !connected} onClick={() => {
        change(selected, { activity: null, activityDisplay: session.activity
          ? { previous: { status: session.status, activity: session.activity } } : session.activityDisplay });
        setRefreshing(true);
        useCockpit.setState({ activityRefreshingIds: [selected] });
      }}>开始刷新（保持画面）</button>
      {refreshing && <span role="status">刷新已暂停，下面保持原样；选择一个返回结果：</span>}
      {refreshing && <>
        <button className="ck-button" onClick={() => result('idle')}>返回空闲</button>
        <button className="ck-button" onClick={() => result('shell')}>返回 shell</button>
        <button className="ck-button" onClick={() => result('ask')}>返回待回答</button>
        <button className="ck-button" onClick={() => result('error')}>读取失败</button>
      </>}
      <button className="ck-button" onClick={() => {
        useCockpit.setState({ connState: connected ? 'connecting' : 'open', snapshotReady: !connected });
      }}>{connected ? '模拟断线' : '恢复连接'}</button>
      <label><input type="checkbox" checked={hold} onChange={event => setHold(event.target.checked)} />保持操作请求</label>
      <label><input type="checkbox" checked={fail} onChange={event => setFail(event.target.checked)} />操作失败</label>
      <button className="ck-button" onClick={() => { pending.current?.(); pending.current = null; }}>释放操作结果</button>
      <button className="ck-button" onClick={() => {
        setSessions(activityDesignSessions()); choose('design-processing');
        useCockpit.setState({ connState: 'open', snapshotReady: true });
      }}>重置</button>
    </header>
    <div className="activity-design-layout">
      <aside className="activity-design-list" aria-label="活动状态对照">
        <p>点击会话查看输入区；问号和其他明确状态优先，转圈只兜底。</p>
        <Sidebar sessions={sessions} activeId={selected} query="" connected={connected} snapshotReady
          onSelect={choose} getMenuItems={() => []} />
      </aside>
      <section className="activity-design-chat" aria-label="当前会话设计">
        <header className="lab-toolbar"><strong>{session.title}</strong>
          <span>工具行可展开原始名称与输入输出；subagent 保持独立卡片。</span></header>
        <Thread session={session} onLoadMore={() => {}}
          onCancel={() => runControl(selected, false)}
          onInterrupt={async () => { await runControl(selected, true); return { ok: true, interrupted: true }; }}
          onSend={async request => {
            if (fail) throw new Error('合成发送失败。');
            if (request.intent === 'respondAsk' || request.intent === 'planSupersede') {
              change(selected, { ask: null, planRequest: null, activity: activityFixture({ processing: true, abortable: true }) });
            }
            return true;
          }}
          onRespondAsk={async () => {
            change(selected, { ask: null, activity: activityFixture({ processing: true, abortable: true }) }); return true;
          }}
          onRespondPlan={async () => { change(selected, { planRequest: null }); return true; }}
          onRespondElicitation={async () => { change(selected, { elicitation: null }); return true; }}
          onRemoveQueued={id => change(selected, { queue: session.queue?.filter(item => item.id !== id) })}
        />
      </section>
    </div>
  </div>;
}
