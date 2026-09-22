import { useId, type RefCallback } from 'react';
import type { ChatSession } from '../net/types';
import { controlIndicators, type SessionControlAction, type SessionControls } from '../lib/sessionControls';
import { useKeyedAction } from '../lib/useKeyedResource';
import { Icon, type IconName } from './Icon';
import { SessionActivity } from './SessionActivity';
import { CopyButton } from './CopyButton';

function ControlAction({ identity, label, icon, waiting = '请求中…', disabled, controlRef, onAction }: {
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

export function SessionControlBar({ session, controls, connected, expanded, disabled, onToggle, onAction, onView, controlRef }: {
  session: ChatSession; controls: SessionControls; connected: boolean; expanded: boolean; disabled: boolean;
  onToggle: () => void; onAction: (action: SessionControlAction) => Promise<void>;
  onView: (messageId: string) => void; controlRef: RefCallback<HTMLElement>;
}) {
  const listId = useId();
  const prune = useKeyedAction(`${session.sessionId}:controls:prune`);
  const items = controlIndicators(session, controls, connected);
  const groupItems = connected ? items : controlIndicators(session, controls, true)
    .map(item => ({ ...item, label: `待同步，上次显示：${item.label}` }));
  const canSteer = controls.main && !controls.compaction && !session.ask && !session.planRequest && !session.elicitation;
  const queueCount = (session.queue?.length ?? 0) + controls.steering.length;
  const active = controls.main || controls.compaction || queueCount > 0 || controls.tasks.some(task => task.status === 'running')
    || session.ask || session.planRequest || session.elicitation;
  const relocated = new Set(expanded ? ['agent', 'shell', 'queue'] : []);
  const headerItems = items.filter(item => !relocated.has(item.key));
  const action = (key: string, label: string, icon: IconName, command: SessionControlAction, blocked = false, waiting?: string) =>
    <ControlAction key={key} identity={`${session.sessionId}:controls:${key}`} label={label} icon={icon} waiting={waiting}
      disabled={disabled || blocked} controlRef={controlRef} onAction={() => onAction(command)} />;
  return <section className="chat-controls" aria-label="会话控制区">
    <div className="chat-execution-head chat-controls-header">
      <button className="ck-button chat-controls-toggle" type="button" aria-expanded={expanded} aria-controls={listId}
        aria-label={`展开或收起会话状态列表：${items.map(item => item.label).join('，')}`} onClick={() => {
          onToggle();
          if (expanded && !disabled) void prune.run(() => onAction({ type: 'prune-tasks' }));
        }}>
        <SessionActivity items={headerItems} />
      </button>
      {active && action('all', '停止本会话当前工作并清空队列', 'stop', { type: 'stop-all' }, false, '停止中…')}
    </div>
    {prune.error && <p className="chat-error" role="alert">{prune.error}</p>}
    <div id={listId} className="chat-controls-list" hidden={!expanded}>
      {(['agent', 'shell'] as const).map(kind => {
        const entries = controls.tasks.filter(task => task.kind === kind);
        return entries.length ? <section className="chat-queue" key={kind} aria-label={kind === 'agent' ? 'Agent 列表' : 'Terminal 列表'}>
          <header className="chat-controls-title"><span className="chat-controls-heading">
            <SessionActivity items={[groupItems.find(item => item.key === kind) ?? {
              key: kind, icon: kind, count: 0, label: kind === 'agent' ? '活动 agent 0' : '后台 shell 0',
            }]} /><span>{kind === 'agent' ? 'Agent' : 'Terminal'}</span>
          </span></header>
          {entries.map(task => <div className="chat-queue-item chat-controls-task" key={task.id} data-task-id={task.id}>
            <span className="chat-controls-task-name">{task.title}{task.status === 'cancelled' && <span className="chat-controls-muted"> · 已停止</span>}</span>
            <div className="chat-controls-actions">
              <CopyButton text={task.title} label={`复制任务名称：${task.title}`} variant="icon" />
              {task.messageId && session.messages.some(message => message.id === task.messageId) &&
                <ControlAction identity={`${session.sessionId}:view:${task.id}`} label={`查看任务记录：${task.title}`} icon="view" disabled={false}
                  controlRef={controlRef} onAction={() => onView(task.messageId!)} />}
              {task.status === 'running' ? action(task.id, `停止任务：${task.title}`, 'stop', { type: 'stop-task', id: task.id }, false, '停止中…')
                : action(task.id, `移除任务记录：${task.title}`, 'close', { type: 'remove-task', id: task.id })}
            </div>
          </div>)}
        </section> : null;
      })}
      {controls.compaction === 'manual' && <section className="chat-queue">
        <div className="chat-queue-item chat-controls-task">
          <span className="chat-controls-task-name">手动压缩上下文</span>
          {action('compact', '取消压缩', 'stop', { type: 'cancel-compaction' }, false, '取消中…')}
        </div>
      </section>}
      {queueCount > 0 && <section className="chat-queue" aria-label="消息队列">
        <header className="chat-controls-title"><span className="chat-controls-heading">
          <SessionActivity items={[groupItems.find(item => item.key === 'queue') ?? {
            key: 'queue', icon: 'queue', count: queueCount, label: `待处理消息 ${queueCount}`,
          }]} /><span>队列</span>
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
