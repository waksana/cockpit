import { useEffect, useRef, useState } from 'react';
import { Minimize2 } from 'lucide-react';
import { Thread } from '../components/Thread';
import { Icon } from '../components/Icon';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { applyControlAction, canSteer, controlDesignState, controlScenes, controlSession,
  type ControlAction, type ControlDesignState, type ControlScene } from './control-design-state';

function PreviewAction({ identity, label, waiting = '请求中…', disabled, command, onPerform }: {
  identity: string; label: string; waiting?: string; disabled: boolean;
  command: ControlAction; onPerform: (action: ControlAction) => Promise<boolean>;
}) {
  const operation = useKeyedAction(identity);
  return <div className="control-lab-action">
    <button type="button" className="ck-button" disabled={disabled || operation.busy}
      aria-busy={operation.busy || undefined} onClick={() => { void operation.run(async () => { await onPerform(command); }); }}>
      {operation.busy ? waiting : label}
    </button>
    {operation.error && <span role="alert">{operation.error}</span>}
  </div>;
}

export function ControlDesignLab() {
  const [scene, setScene] = useState<ControlScene>('mixed');
  const [state, setState] = useState(() => controlDesignState('mixed'));
  const current = useRef(state);
  const [hold, setHold] = useState(false);
  const [fail, setFail] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [simulationError, setSimulationError] = useState<string>();
  const pending = useRef<(() => void)[]>([]);
  const generation = useRef(0);
  const serial = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const connected = useCockpit(value => value.connState === 'open' && value.snapshotReady);
  useEffect(() => () => { generation.current++; pending.current.splice(0).forEach(resolve => resolve()); }, []);
  const commit = (next: ControlDesignState) => { current.current = next; setState(next); };
  const choose = (value: ControlScene) => {
    generation.current++;
    pending.current.splice(0).forEach(resolve => resolve());
    setScene(value); setRefreshing(false); setSimulationError(undefined);
    commit(controlDesignState(value, `${value}-${generation.current}`));
    useCockpit.setState({ connState: 'open', snapshotReady: true });
  };
  const perform = async (action: ControlAction) => {
    const owner = generation.current;
    if (hold) await new Promise<void>(resolve => pending.current.push(resolve));
    if (owner !== generation.current) return false;
    if (useCockpit.getState().connState !== 'open') throw new Error('连接已断开，未执行合成操作。');
    if (fail) throw new Error('合成操作失败；对象和历史均未删除。');
    commit(applyControlAction(current.current, action));
    return true;
  };
  const simulate = (action: ControlAction) => {
    try { commit(applyControlAction(current.current, action)); setSimulationError(undefined); }
    catch (error) { setSimulationError(error instanceof Error ? error.message : String(error)); }
  };
  const disabled = !connected || refreshing;
  const tasks = state.tasks.filter(task => task.status === 'running');
  const decision = !!(state.session.ask || state.session.planRequest || state.session.elicitation);
  const queueCount = state.queue.length + state.steering.length;
  const specific = decision || tasks.length || state.compaction || queueCount;
  const session = controlSession(state);
  const action = (key: string, label: string, operation: ControlAction, extraDisabled = false, waiting?: string) =>
    <PreviewAction key={`${session.sessionId}:${key}`} identity={`${session.sessionId}:${key}`}
      label={label} waiting={waiting} disabled={disabled || extraDisabled} command={operation} onPerform={perform} />;
  const controls = <section className="control-lab-controls" aria-label="会话控制区" aria-busy={refreshing}>
    <div className="control-lab-status" aria-label="会话活动">
      <div className="control-lab-indicators">
        {!connected ? <span><Icon name="unknown" size={16} />待同步</span> : <>
          {decision && <span><Icon name="decision" size={16} />待回答</span>}
          {state.compaction && <span><span className="ck-icon" data-icon="compress" aria-hidden="true"><Minimize2 size={16} /></span>
            {state.compaction === 'manual' ? '正在压缩上下文' : '后台压缩上下文'}</span>}
          {state.main && !specific && <span><Icon name="loading" className="spinner" size={16} />正在处理</span>}
          {!state.main && !specific && <span className="control-lab-muted">当前无活动</span>}
          {queueCount > 0 && <span><Icon name="queue" size={16} />{queueCount}</span>}
        </>}
      </div>
      {state.compaction === 'manual' && action('compact', '取消压缩', { type: 'cancel-compaction' }, false, '取消中…')}
      {state.main && !state.compaction && action('main', '停止当前回合', { type: 'stop-main' }, false, '停止中…')}
    </div>
    {tasks.length > 0 && <details className="control-lab-tasks">
      <summary>{(['shell', 'agent'] as const).map(kind => {
        const count = tasks.filter(task => task.kind === kind).length;
        return count ? <span key={kind}><Icon name={kind} size={16} />{kind} {count}</span> : null;
      })}<span className="control-lab-muted">展开任务与操作</span></summary>
      <div className="control-lab-task-list">
        {tasks.map(task => <div className="control-lab-task" key={task.id}>
          <Icon name={task.kind} size={16} /><span className="control-lab-task-name">{task.title}</span>
          <div className="control-lab-actions">
            {task.messageId && <button type="button" className="ck-button" onClick={() => {
              const card = root.current?.querySelector<HTMLElement>(`[data-message-id="${task.messageId}"]`);
              card?.scrollIntoView({ block: 'center' });
              const toggle = card?.querySelector<HTMLButtonElement>('button[aria-expanded]');
              if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
              toggle?.focus({ preventScroll: true });
            }}>查看</button>}
            {action(task.id, '停止', { type: 'stop-task', id: task.id }, false, '停止中…')}
          </div>
        </div>)}
      </div>
    </details>}
    {queueCount > 0 && <section className="control-lab-queue" aria-label="消息队列">
      <header><span>消息队列 {queueCount} 条</span>{action('clear', '清空队列', { type: 'clear-queue' }, false, '清空中…')}</header>
      <div className="control-lab-queued-list">
        {state.queue.map(item => <div className="control-lab-queued" key={item.id}>
          <details><summary>{item.text}</summary><p>{item.text}</p></details>
          <div className="control-lab-actions" title={canSteer(state) ? '送入当前回合，不打断当前任务' : '需要可接收补充消息的主回合；原生问题请在下方回答'}>
            {action(`steer-${item.id}`, '立即发送', { type: 'steer', id: item.id }, !canSteer(state), '发送中…')}
            {action(`remove-${item.id}`, '移除', { type: 'remove', id: item.id })}
          </div>
        </div>)}
        {state.steering.map(item => <div className="control-lab-queued" key={item.id}>
          <p>{item.text}</p><span className="control-lab-muted">等待纳入当前回合</span>
        </div>)}
      </div>
    </section>}
  </section>;
  return <div className="cockpit-shell chat-lab control-design-lab" ref={root}>
    <header className="lab-toolbar">
      <strong>会话控制区 / Chat Lab</strong><span>仅合成数据 · 未接 SDK</span>
      <label>场景 <select className="ck-input" value={scene} onChange={event => {
        const selected = controlScenes.find(([id]) => id === event.target.value);
        if (selected) choose(selected[0]);
      }}>{controlScenes.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
      <button type="button" className="ck-button" onClick={() => choose(scene)}>重置</button>
      <label><input type="checkbox" checked={hold} onChange={event => setHold(event.target.checked)} />保持请求中</label>
      <label><input type="checkbox" checked={fail} onChange={event => setFail(event.target.checked)} />模拟失败</label>
      <button type="button" className="ck-button" onClick={() => pending.current.splice(0).forEach(resolve => resolve())}>释放结果</button>
      <button type="button" className="ck-button" disabled={!connected}
        onClick={() => setRefreshing(value => !value)}>{refreshing ? '返回原状态' : '刷新（保持显示）'}</button>
      <button type="button" className="ck-button" onClick={() => {
        generation.current++;
        pending.current.splice(0).forEach(resolve => resolve());
        useCockpit.setState({ connState: connected ? 'connecting' : 'open', snapshotReady: !connected,
          connectionGeneration: useCockpit.getState().connectionGeneration + 1 });
      }}>{connected ? '模拟断线' : '恢复连接'}</button>
      <button type="button" className="ck-button" disabled={disabled || !state.steering.length || !canSteer(state)}
        onClick={() => simulate({ type: 'consume' })}>模拟纳入回合</button>
      <button type="button" className="ck-button" disabled={disabled || !state.compaction}
        onClick={() => simulate({ type: 'finish-compaction' })}>模拟压缩完成</button>
    </header>
    {simulationError && <p className="lab-receipt" role="alert">{simulationError}</p>}
    <details className="control-lab-events"><summary>合成原生事件（{state.events.length}）</summary>
      <p>立即发送先进入等待区；点击“模拟纳入回合”后才出现 user.message / delivery: steering。下方沿用现有用户气泡。</p>
      <pre>{state.events.length ? JSON.stringify(state.events, null, 2) : '尚未纳入历史；没有伪造“发送成功”系统消息。'}</pre>
    </details>
    <div className="lab-stage">
      <Thread key={session.sessionId} session={session} composerControls={controls} promptBusy={state.main} onLoadMore={() => {}}
        onSend={request => perform(request.intent === 'prompt'
          ? { type: 'send', id: `preview-message-${++serial.current}`, text: request.body.text }
          : { type: 'answer', id: `preview-answer-${++serial.current}`,
            kind: request.intent === 'respondAsk' ? 'ask' : 'plan', requestId: request.body.requestId,
            text: request.intent === 'respondAsk' ? request.body.answer : request.body.message })}
        onRespondAsk={async (requestId, answer) => perform({ type: 'answer', id: `preview-answer-${++serial.current}`,
          kind: 'ask', requestId, text: answer })}
        onRespondPlan={async (requestId, value) => perform({ type: 'answer', id: `preview-plan-${++serial.current}`,
          kind: 'plan', requestId, text: value, resume: value !== 'exit_only', record: false })}
        onRespondElicitation={async (requestId, value) => perform({ type: 'answer', id: `preview-confirm-${++serial.current}`,
          kind: 'elicitation', requestId, text: value, record: false })}
      />
    </div>
  </div>;
}
