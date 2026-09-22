import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Thread } from '../components/Thread';
import { Icon } from '../components/Icon';
import { PaneHeader } from '../components/PaneHeader';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { controlIndicators } from '../lib/sessionControls';
import { SessionActivity } from '../components/SessionActivity';
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

const decisionKey = (state: ControlDesignState) => state.session.ask?.requestId
  ?? state.session.planRequest?.requestId ?? state.session.elicitation?.requestId;

export function ControlDesignLab() {
  const [scene, setScene] = useState<ControlScene>(() => {
    const value = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('case');
    return controlScenes.find(([id]) => id === value)?.[0] ?? 'mixed';
  });
  const [state, setState] = useState(() => controlDesignState(scene));
  const current = useRef(state);
  const [hold, setHold] = useState(false);
  const [fail, setFail] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [simulationError, setSimulationError] = useState<string>();
  const [disclosure, setDisclosure] = useState<{ request?: string; open: boolean }>({ open: true });
  const [editorSize, setEditorSize] = useState<{ height: number; fixed: boolean }>();
  const [baselineSpinner, setBaselineSpinner] = useState(false);
  const pending = useRef<(() => void)[]>([]);
  const generation = useRef(0);
  const serial = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const connected = useCockpit(value => value.connState === 'open' && value.snapshotReady);
  useEffect(() => () => { generation.current++; pending.current.splice(0).forEach(resolve => resolve()); }, []);
  const commit = (next: ControlDesignState) => {
    if (decisionKey(next) !== decisionKey(current.current)) {
      const height = root.current?.querySelector('.chat-input-message')?.getBoundingClientRect().height;
      if (height) setEditorSize({ height, fixed: true });
    }
    current.current = next; setState(next);
  };
  const choose = (value: ControlScene) => {
    generation.current++;
    pending.current.splice(0).forEach(resolve => resolve());
    setScene(value); setRefreshing(false); setSimulationError(undefined);
    setDisclosure({ open: true }); setEditorSize(undefined); setBaselineSpinner(false);
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
  const request = decisionKey(state);
  const expanded = request && disclosure.request !== request ? true : disclosure.open;
  useLayoutEffect(() => {
    if (!request) return;
    // A new questionnaire opens at its answer, once and before paint. Later
    // task updates must not move a user who is reading the questionnaire.
    const body = root.current?.querySelector('.chat-input-card-body');
    if (body) body.scrollTop = body.scrollHeight;
  }, [request]);
  const queueCount = state.queue.length + state.steering.length;
  const statusLabel = !connected ? '待同步' : [
    decision && '待回答', state.compaction && '正在压缩上下文',
    ...(['agent', 'shell'] as const).flatMap(kind => {
      const count = tasks.filter(task => task.kind === kind).length;
      return count ? [`${kind} ${count}`] : [];
    }),
    queueCount > 0 && `队列 ${queueCount}`,
  ].filter(Boolean).join('，') || (state.main ? '正在处理' : '当前无活动');
  const session = controlSession(state);
  const action = (key: string, label: string, operation: ControlAction, extraDisabled = false, waiting?: string) =>
    <PreviewAction key={`${session.sessionId}:${key}`} identity={`${session.sessionId}:${key}`}
      label={label} waiting={waiting} disabled={disabled || extraDisabled} command={operation} onPerform={perform} />;
  const controls = <section className="control-lab-controls" aria-label="会话控制区" aria-busy={refreshing}>
    <div className="chat-execution-head control-lab-header">
      <button type="button" className="control-lab-toggle ck-button" aria-label={`展开或收起会话状态列表：${statusLabel}`} title={statusLabel}
        aria-expanded={expanded} aria-controls="control-lab-list" onClick={() => {
          setDisclosure({ request, open: !expanded });
          if (expanded) commit(applyControlAction(current.current, { type: 'prune-tasks' }));
        }}>
        <SessionActivity items={controlIndicators(session, state, connected)} />
        <Icon name={expanded ? 'down' : 'chevron_right'} size={16} />
      </button>
      {(state.main || tasks.length > 0 || state.compaction || queueCount > 0) &&
        action('all', '停止', { type: 'stop-all' }, false, '停止中…')}
    </div>
    <div id="control-lab-list" className="control-lab-list" hidden={!expanded}>
    {(['agent', 'shell'] as const).map(kind => {
      const entries = state.tasks.filter(task => task.kind === kind);
      return entries.length ? <section className="chat-queue" aria-label={kind === 'agent' ? 'Agent 列表' : 'Terminal 列表'} key={kind}>
        <header className="control-lab-section-title">{kind === 'agent' ? 'Agent' : 'Terminal'}</header>
        {entries.map(task => <div className="chat-queue-item control-lab-task" key={task.id} data-task-id={task.id}>
          <Icon name={task.kind} size={16} /><span className="control-lab-task-name">{task.title}
            {task.status !== 'running' && <span className="control-lab-muted"> · 已停止</span>}</span>
          <div className="control-lab-actions">
            {task.messageId && <button type="button" className="ck-button" onClick={() => {
              const card = root.current?.querySelector<HTMLElement>(`[data-message-id="${task.messageId}"]`);
              card?.scrollIntoView({ block: 'center' });
              const toggle = card?.querySelector<HTMLButtonElement>('button[aria-expanded]');
              if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
              toggle?.focus({ preventScroll: true });
            }}>查看</button>}
            {task.status === 'running'
              ? action(task.id, '停止', { type: 'stop-task', id: task.id }, false, '停止中…')
              : action(task.id, '移除', { type: 'remove-task', id: task.id })}
          </div>
        </div>)}
      </section> : null;
    })}
    {state.compaction === 'manual' && <div className="chat-queue-item">
      <span className="control-lab-task-name">手动压缩上下文</span>
      {action('compact', '取消压缩', { type: 'cancel-compaction' }, false, '取消中…')}
    </div>}
    {queueCount > 0 && <section className="chat-queue control-lab-queue" aria-label="消息队列">
      <header className="control-lab-section-title"><span>队列 {queueCount}</span>{action('clear', '清空队列', { type: 'clear-queue' }, false, '清空中…')}</header>
        {state.queue.map(item => <div className="chat-queue-item control-lab-queued" key={item.id}>
          <details className="chat-queue-entry"><summary className="chat-queue-text">{item.text}</summary></details>
          <div className="control-lab-actions" title={canSteer(state) ? '送入当前回合，不打断当前任务' : '需要可接收补充消息的主回合；原生问题请在下方回答'}>
            {action(`steer-${item.id}`, '立即发送', { type: 'steer', id: item.id }, !canSteer(state), '发送中…')}
            {action(`remove-${item.id}`, '移除', { type: 'remove', id: item.id })}
          </div>
        </div>)}
        {state.steering.map(item => <div className="chat-queue-item control-lab-queued" key={item.id}>
          <span className="chat-queue-text">{item.text}</span><span className="control-lab-muted">等待纳入当前回合</span>
        </div>)}
    </section>}
    </div>
  </section>;
  return <div className="cockpit-shell chat-lab control-design-lab" ref={root}
    data-controls-open={expanded} data-decision={decision || undefined}
    data-editor-sized={!!editorSize || undefined} data-editor-fixed={editorSize?.fixed || undefined}
    data-spinner-baseline={baselineSpinner || undefined}
    style={editorSize ? { '--control-editor-height': `${editorSize.height}px` } as CSSProperties : undefined}
    onChange={event => {
      if (event.target instanceof HTMLTextAreaElement) setEditorSize(value => value?.fixed ? { ...value, fixed: false } : value);
    }}>
    <PaneHeader className="chat-topbar" title={<span className="pane-title">会话控制区预览</span>} />
    <details className="control-design-options">
      <summary>Chat Lab 场景与模拟 · 仅合成数据</summary>
    <header className="lab-toolbar">
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
      <button type="button" className="ck-button" disabled={disabled || decision}
        onClick={() => simulate({ type: 'question', id: `preview-question-${++serial.current}` })}>出现问卷（不换会话）</button>
      {scene === 'tool-loading' && <>
        <label><input type="checkbox" checked={baselineSpinner} onChange={event => setBaselineSpinner(event.target.checked)} />对比修复前图标</label>
        <button type="button" className="ck-button" onClick={() => simulate({ type: 'finish-tool' })}>工具完成</button>
      </>}
    </header>
    {simulationError && <p className="lab-receipt" role="alert">{simulationError}</p>}
    <details className="control-lab-events"><summary>合成原生事件（{state.events.length}）</summary>
      <p>立即发送先进入等待区；点击“模拟纳入回合”后才出现 user.message / delivery: steering。下方沿用现有用户气泡。</p>
      <pre>{state.events.length ? JSON.stringify(state.events, null, 2) : '尚未纳入历史；没有伪造“发送成功”系统消息。'}</pre>
    </details>
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
