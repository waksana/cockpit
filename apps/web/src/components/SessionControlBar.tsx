import { useId, type RefCallback } from 'react';
import type { ChatSession } from '../net/types';
import { controlIndicators, type SessionControlAction, type SessionControls } from '../lib/sessionControls';
import { useKeyedAction } from '../lib/useKeyedResource';
import { Icon, type IconName } from './Icon';
import { SessionActivity } from './SessionActivity';
import { CopyButton } from './CopyButton';

export function SessionControlActionButton({ identity, label, icon, waiting = '请求中…', disabled, controlRef, onAction }: {
  identity: string; label: string; icon: IconName; waiting?: string; disabled: boolean;
  controlRef: RefCallback<HTMLElement>; onAction: () => void | Promise<void>;
}) {
  const action = useKeyedAction(identity);
  return <div className="chat-control-action">
    <button ref={controlRef} type="button" className="ck-icon-button" disabled={disabled || action.busy}
      aria-label={action.busy ? waiting : label} title={action.busy ? waiting : label}
      aria-busy={action.busy || undefined} onClick={() => { void action.run(onAction); }}>
      <Icon name={action.busy ? 'loading' : icon} className={action.busy ? 'spinner' : undefined} size={16} />
    </button>
    {action.error && <span role="alert">{action.error}</span>}
  </div>;
}

function TaskEntry({ task, sessionId, disabled, controlRef, onAction }: {
  task: SessionControls['tasks'][number]; sessionId: string; disabled: boolean;
  controlRef: RefCallback<HTMLElement>; onAction: (action: SessionControlAction) => Promise<void>;
}) {
  return <div className="chat-control-entry" data-task-id={task.id}>
    <div className="chat-queue-item chat-controls-task">
      <span className="chat-controls-task-name">{task.title}</span>
      <div className="chat-controls-actions">
        <SessionControlActionButton identity={`${sessionId}:controls:${task.id}`} label={`取消任务：${task.title}`}
          icon="close" waiting="取消中…" disabled={disabled} controlRef={controlRef}
          onAction={() => onAction({ type: 'stop-task', id: task.id })} />
      </div>
    </div>
  </div>;
}

export function SessionControlBar({ session, controls, connected, expanded, disabled, onToggle, onAction, controlRef }: {
  session: ChatSession; controls: SessionControls; connected: boolean; expanded: boolean; disabled: boolean;
  onToggle: () => void; onAction: (action: SessionControlAction) => Promise<void>;
  controlRef: RefCallback<HTMLElement>;
}) {
  const listId = useId();
  const items = controlIndicators(session, controls, connected);
  const groupItems = connected ? items : controlIndicators(session, controls, true)
    .map(item => ({ ...item, label: `待同步，上次显示：${item.label}` }));
  const canSteer = controls.main && !controls.compaction && !session.ask && !session.planRequest && !session.elicitation;
  const queueCount = (session.queue?.length ?? 0) + controls.steering.length;
  const active = controls.main || controls.compaction || queueCount > 0 || controls.tasks.some(task => task.status === 'running')
    || session.ask || session.planRequest || session.elicitation;
  const relocated = new Set(expanded ? ['agent', 'shell', 'queue', 'decision'] : []);
  const headerItems = items.filter(item => !relocated.has(item.key));
  const action = (key: string, label: string, icon: IconName, command: SessionControlAction, blocked = false, waiting?: string) =>
    <SessionControlActionButton key={key} identity={`${session.sessionId}:controls:${key}`} label={label} icon={icon} waiting={waiting}
      disabled={disabled || blocked} controlRef={controlRef} onAction={() => onAction(command)} />;
  if (!items.length || items.length === 1 && items[0].icon === 'radiooff') return null;
  return <section className="chat-controls" aria-label="会话控制区">
    <div className="chat-execution-head chat-controls-header">
      <button className="ck-button chat-controls-toggle" type="button" aria-expanded={expanded} aria-controls={listId}
        aria-label={`展开或收起会话状态列表：${items.map(item => item.label).join('，')}`} onClick={onToggle}>
        <SessionActivity items={headerItems} />
      </button>
      {active && action('all', '停止本会话当前工作并清空队列', 'stop', { type: 'stop-all' }, false, '停止中…')}
    </div>
    <div id={listId} className="chat-controls-list" hidden={!expanded}>
      {(['agent', 'shell'] as const).map(kind => {
        const entries = controls.tasks.filter(task => task.kind === kind && task.status === 'running');
        return entries.length ? <section className="chat-queue" key={kind} aria-label={kind === 'agent' ? 'Agent 列表' : 'Terminal 列表'}>
          <header className="chat-controls-title"><span className="chat-controls-heading">
            <SessionActivity items={[groupItems.find(item => item.key === kind) ?? {
              key: kind, icon: kind, count: 0, label: kind === 'agent' ? '活动 agent 0' : '后台 shell 0',
            }]} names={{ [kind]: kind === 'agent' ? 'Agent' : 'Terminal' }} />
          </span>{action(`clear:${kind}`, `清空 ${kind === 'agent' ? 'Agent' : 'Terminal'}（取消该组任务）`, 'delete',
            { type: 'clear-tasks', kind, ids: entries.map(task => task.id) }, false, '清空中…')}</header>
          {entries.map(task => <TaskEntry key={JSON.stringify([session.sessionId, task.id])} task={task} sessionId={session.sessionId}
            disabled={disabled} controlRef={controlRef}
            onAction={onAction} />)}
        </section> : null;
      })}
      {queueCount > 0 && <section className="chat-queue" aria-label="消息队列">
        <header className="chat-controls-title"><span className="chat-controls-heading">
          <SessionActivity items={[groupItems.find(item => item.key === 'queue') ?? {
            key: 'queue', icon: 'queue', count: queueCount, label: `待处理消息 ${queueCount}`,
          }]} names={{ queue: '队列' }} />
        </span>
          {action('clear', '清空队列', 'delete', { type: 'clear-queue' }, false, '清空中…')}</header>
        {session.queue?.map(item => <div className="chat-queue-item" key={item.id}>
          <details className="chat-queue-entry"><summary className="chat-queue-text">{item.text}</summary></details>
          <div className="chat-controls-actions" title={canSteer ? '送入当前回合，不打断当前任务' : '当前没有可接收补充消息的主回合'}>
            <CopyButton text={item.text} label={`复制排队消息：${item.text}`} variant="icon" />
            {action(`steer:${item.id}`, `立即发送：${item.text}`, 'agent_message', { type: 'steer', id: item.id }, !canSteer, '发送中…')}
            {action(`remove:${item.id}`, `移除排队消息：${item.text}`, 'close', { type: 'remove', id: item.id })}
          </div>
        </div>)}
        {controls.steering.map(item => <div className="chat-queue-item" key={item.id}>
          <span className="chat-queue-text chat-controls-task-name">{item.text}</span>
          <span className="chat-controls-muted">等待纳入当前回合</span>
          <CopyButton text={item.text} label={`复制待纳入消息：${item.text}`} variant="icon" />
        </div>)}
      </section>}
    </div>
  </section>;
}
