import { useId, type RefCallback } from 'react';
import type { ChatSession } from '../net/types';
import { controlIndicators, type SessionControlAction, type SessionControls } from '../lib/sessionControls';
import { useKeyedAction } from '../lib/useKeyedResource';
import { Icon } from './Icon';
import { SessionActivity } from './SessionActivity';

function ControlAction({ identity, label, waiting = '请求中…', disabled, controlRef, onAction }: {
  identity: string; label: string; waiting?: string; disabled: boolean;
  controlRef: RefCallback<HTMLElement>; onAction: () => void | Promise<void>;
}) {
  const action = useKeyedAction(identity);
  return <div className="chat-execution-actions chat-control-action">
    <button ref={controlRef} type="button" className="ck-button" disabled={disabled || action.busy}
      aria-busy={action.busy || undefined} onClick={() => { void action.run(onAction); }}>
      {action.busy ? waiting : label}
    </button>
    {action.error && <span role="alert">{action.error}</span>}
  </div>;
}

export function SessionControlBar({ session, controls, connected, expanded, disabled, onToggle, onAction, onView, controlRef }: {
  session: ChatSession; controls: SessionControls; connected: boolean; expanded: boolean; disabled: boolean;
  onToggle: () => void; onAction: (action: SessionControlAction) => Promise<void>;
  onView: (messageId: string) => void; controlRef: RefCallback<HTMLElement>;
}) {
  const listId = useId();
  const prune = useKeyedAction(`${session.sessionId}:controls:prune`);
  const items = controlIndicators(session, controls, connected);
  const canSteer = controls.main && !controls.compaction && !session.ask && !session.planRequest && !session.elicitation;
  const queueCount = (session.queue?.length ?? 0) + controls.steering.length;
  const active = controls.main || controls.compaction || queueCount > 0 || controls.tasks.some(task => task.status === 'running')
    || session.ask || session.planRequest || session.elicitation;
  const action = (key: string, label: string, command: SessionControlAction, blocked = false, waiting?: string) =>
    <ControlAction key={key} identity={`${session.sessionId}:controls:${key}`} label={label} waiting={waiting}
      disabled={disabled || blocked} controlRef={controlRef} onAction={() => onAction(command)} />;
  return <section className="chat-controls" aria-label="会话控制区">
    <div className="chat-execution-head chat-controls-header">
      <button className="ck-button chat-controls-toggle" type="button" aria-expanded={expanded} aria-controls={listId}
        aria-label={`展开或收起会话状态列表：${items.map(item => item.label).join('，')}`} onClick={() => {
          onToggle();
          if (expanded && !disabled) void prune.run(() => onAction({ type: 'prune-tasks' }));
        }}>
        <SessionActivity items={items} />
        <Icon name={expanded ? 'down' : 'chevron_right'} size={16} />
      </button>
      {active && action('all', '停止', { type: 'stop-all' }, false, '停止中…')}
    </div>
    {prune.error && <p className="chat-error" role="alert">{prune.error}</p>}
    <div id={listId} className="chat-controls-list" hidden={!expanded}>
      {(['agent', 'shell'] as const).map(kind => {
        const entries = controls.tasks.filter(task => task.kind === kind);
        return entries.length ? <section className="chat-queue" key={kind} aria-label={kind === 'agent' ? 'Agent 列表' : 'Terminal 列表'}>
          <header className="chat-controls-title">{kind === 'agent' ? 'Agent' : 'Terminal'}</header>
          {entries.map(task => <div className="chat-queue-item chat-controls-task" key={task.id} data-task-id={task.id}>
            <Icon name={kind} size={16} />
            <span className="chat-controls-task-name">{task.title}{task.status === 'cancelled' && <span className="chat-controls-muted"> · 已停止</span>}</span>
            <div className="chat-controls-actions">
              {task.messageId && session.messages.some(message => message.id === task.messageId) &&
                <ControlAction identity={`${session.sessionId}:view:${task.id}`} label="查看" disabled={false}
                  controlRef={controlRef} onAction={() => onView(task.messageId!)} />}
              {task.status === 'running' ? action(task.id, '停止', { type: 'stop-task', id: task.id }, false, '停止中…')
                : action(task.id, '移除', { type: 'remove-task', id: task.id })}
            </div>
          </div>)}
        </section> : null;
      })}
      {controls.compaction === 'manual' && <section className="chat-queue">
        <div className="chat-queue-item chat-controls-task">
          <span className="chat-controls-task-name">手动压缩上下文</span>
          {action('compact', '取消压缩', { type: 'cancel-compaction' }, false, '取消中…')}
        </div>
      </section>}
      {queueCount > 0 && <section className="chat-queue" aria-label="消息队列">
        <header className="chat-controls-title"><span>队列 {queueCount}</span>
          {action('clear', '清空队列', { type: 'clear-queue' }, false, '清空中…')}</header>
        {session.queue?.map(item => <div className="chat-queue-item" key={item.id}>
          <details className="chat-queue-entry"><summary className="chat-queue-text">{item.text}</summary></details>
          <div className="chat-controls-actions" title={canSteer ? '送入当前回合，不打断当前任务' : '当前没有可接收补充消息的主回合'}>
            {action(`steer:${item.id}`, '立即发送', { type: 'steer', id: item.id }, !canSteer, '发送中…')}
            {action(`remove:${item.id}`, '移除', { type: 'remove', id: item.id })}
          </div>
        </div>)}
        {controls.steering.map(item => <div className="chat-queue-item" key={item.id}>
          <span className="chat-queue-text chat-controls-task-name">{item.text}</span>
          <span className="chat-controls-muted">等待纳入当前回合</span>
        </div>)}
      </section>}
    </div>
  </section>;
}
