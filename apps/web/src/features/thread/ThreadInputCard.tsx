import type { ReactNode } from 'react';
import type { ChatSession } from '../../net/types';
import type { SessionDraft } from '../../lib/textDraft';
import type { sessionActivityIndicators } from '../../lib/sessionActivity';
import type { useRemovedControlFocus } from '../../lib/useRemovedControlFocus';
import { Button, IconButton } from '../../components/Button';
import { ComposerNotices } from '../../components/Composer';
import { CopyButton } from '../../components/CopyButton';
import { Disclosure, TextClamp } from '../../components/Disclosure';
import { Icon } from '../../components/Icon';
import { SessionActivity } from '../../components/SessionActivity';
import type { ThreadExecution } from './useThreadExecution';

type ControlRef = ReturnType<typeof useRemovedControlFocus>;

// Errors and uncertain results above the input card, each shown once in scope.
export function ThreadInputNotices({ session, readOnly, authoritative, activityRefreshing, execution, draft, onRetryControls, onRetryHistory }: {
  session: ChatSession; readOnly: boolean; authoritative: boolean; activityRefreshing: boolean;
  execution: ThreadExecution; draft: SessionDraft; onRetryControls?: () => void; onRetryHistory?: () => void;
}) {
  const { interruptResult, interruptAction, stopAction } = execution;
  return (
    <div className="chat-input-notices">
      {!readOnly && session.controlsError && <p className="chat-error" role="alert">
        活动列表读取失败：{session.controlsError}
        {onRetryControls && <Button disabled={!authoritative || activityRefreshing}
          onClick={onRetryControls}>重试</Button>}
      </p>}
      {session.error && <p className="chat-error" role="alert">错误: {session.error}
        {onRetryHistory && session.materialized && !session.historyStale && <Button
          onClick={onRetryHistory}>重试同步</Button>}
      </p>}
      {interruptResult && <p className="chat-interrupt-status" tabIndex={0} aria-label="打断结果" role={interruptAction.error ? 'alert' : 'status'}>
        {interruptResult}
      </p>}
      {stopAction.error && <p className="chat-interrupt-status" role="alert">
        停止结果未确认：{stopAction.error}
      </p>}
      {!readOnly && <ComposerNotices draft={draft} />}
    </div>
  );
}

// The input card's fold row: execution summary plus stop/interrupt actions.
export function ExecutionHead({ hidden, open, bodyId, label, progress, activityItems, foldedDraft, operationsActive, execution, controlRef, onToggle, onInterrupt, onCancel }: {
  hidden: boolean; operationsActive: boolean; open: boolean; bodyId: string; label: string; progress: ReactNode;
  activityItems: ReturnType<typeof sessionActivityIndicators>; foldedDraft: boolean;
  execution: ThreadExecution; controlRef: ControlRef; onToggle: () => void;
  onInterrupt?: () => Promise<unknown>; onCancel?: () => void | Promise<void>;
}) {
  const { showStop, showInterrupt, interruptAction, stopAction, stopDisabled, stopPending, notAbortable, queueCount } = execution;
  return (
    <div className="chat-execution-head" hidden={hidden}>
      <Disclosure className="chat-execution-toggle" open={open} onToggle={onToggle}
        controls={bodyId} name={`输入卡片：${label}`}>
        <span className="chat-execution-label" role="status" title={label}
          aria-label={label}>
          {progress && <span className="chat-execution-progress">{progress}</span>}
          <SessionActivity items={activityItems} />
        </span>
        {foldedDraft && <span className="chat-folded-draft">有草稿</span>}
      </Disclosure>
      {(showStop || showInterrupt) && <span className="chat-execution-actions" role="group" aria-label="执行操作">
        {showInterrupt && <Button ref={controlRef} className="chat-interrupt"
          disabled={!interruptAction.connected || (operationsActive && !interruptAction.busy)}
          aria-disabled={interruptAction.busy || undefined}
          onClick={() => {
            void interruptAction.run(async () => {
              await onInterrupt!();
            });
          }}>{interruptAction.busy ? '正在请求…' : '打断并处理队列'}</Button>}
        {showStop && <Button ref={controlRef} className="chat-typing-stop" danger disabled={stopDisabled}
          aria-disabled={stopPending || undefined} aria-busy={stopPending || undefined}
          onClick={() => {
            if (!stopDisabled && !stopPending) void stopAction.run(async () => { await onCancel?.(); });
          }}>
          <Icon name="stop" size={16} />
          {stopPending ? '正在停止…' : notAbortable ? '当前不可中断' : queueCount > 0 ? '停止并清空队列' : '停止'}
        </Button>}
      </span>}
    </div>
  );
}

// Queued prompts, each removable and copyable in place.
export function QueuedMessages({ queue, connected, controlRef, onRemove }: {
  queue: ChatSession['queue']; connected: boolean; controlRef: ControlRef; onRemove?: (itemId: string) => void;
}) {
  return (
    <div className="chat-queue" aria-label="排队中的消息">
      {queue?.map((q) => (
        <div key={q.id} className="chat-queue-item">
          <TextClamp className="chat-queue-entry" text={q.text} label="排队消息" lines={1} />
          <div className="chat-queue-copy"><CopyButton text={q.text} label="复制排队消息" /></div>
          <IconButton ref={controlRef} className="chat-queue-remove" icon="close" iconSize={16} disabled={!connected || !onRemove}
            label={`移除排队消息：${q.text}`} onClick={() => onRemove?.(q.id)} />
        </div>
      ))}
    </div>
  );
}
