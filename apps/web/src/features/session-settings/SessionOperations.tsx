import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useCockpit } from '../../net/store';
import { sessionSettingsBlockReason, type SessionSettingsAction } from '../../lib/sessionSettingsActions';
import { sessionNavigation } from '../../lib/routeOwnership';
import { useSessionReload } from './useSessionReload';
import { Dialog } from '../../components/Dialog';
import { ActionList, ActionRow, SectionHeading } from '../../components/UI';
import type { IconName } from '../../components/Icon';
import { StateNotice } from '../../components/StateNotice';
import { OperationResult } from '../../components/OperationResult';
import { copy } from '../../lib/copy';

const labels = { unload: '卸载会话', compact: '压缩上下文', fork: '分叉会话' };
const rows: Record<SessionSettingsAction, { icon: IconName; name: string; description: string }> = {
  unload: { icon: 'unload', name: '卸载', description: '释放运行资源，保留聊天历史' },
  compact: { icon: 'compress', name: '压缩上下文', description: '汇总模型上下文，无法撤销' },
  fork: { icon: 'fork', name: '分叉', description: '复制历史到新会话，共享工作目录' },
};
const messages = {
  unload: '释放运行资源，保留聊天历史；定时任务会暂停。恢复时使用默认配置，临时 MCP / Skill 选择可能丢失，从未发消息的空会话可能消失。',
  compact: '汇总模型上下文，聊天历史不删除，无法撤销。可填写希望重点保留的内容，但不保证一定保留。',
  fork: '复制当前历史到一个未加载的新会话，不发送消息。新会话共享工作目录和文件，不创建分支、工作树或 Task；有进行中的回合或定时任务时会被拒绝。',
};

function OperationDialog({ sessionId, action, onClose }: {
  sessionId: string; action: SessionSettingsAction; onClose: () => void;
}) {
  const submitted = useRef(false);
  const operation = useCockpit(s => s.sessionSettingsOperations[sessionId]);
  const session = useCockpit(s => s.sessions.find(row => row.sessionId === sessionId));
  const connected = useCockpit(s => s.connState === 'open' && s.snapshotReady);
  const pending = useCockpit(s => s.reloadingSessionIds.includes(sessionId) || !!s.sessionSettingsOperations[sessionId]?.pending);
  const reason = sessionSettingsBlockReason(session, connected, pending);
  // Our own refresh snapshot advances the connection generation. The store's
  // session-owned outcome still completes this confirmation, not another target.
  useEffect(() => {
    if (submitted.current && operation?.action === action && !operation.pending && operation.outcome) onClose();
  }, [operation, action, onClose]);
  return <Dialog title={labels[action]} message={`${messages[action]}${reason && !pending ? ` ${reason}。` : ''}`} confirmLabel={labels[action]}
    actionKey={`${action}:${sessionId}`} confirmDisabled={!!reason}
    pending={operation?.pending}
    error={operation?.error ? (operation.errorState === 'failed' ? copy.failed(labels[action], operation.error) : copy.unknown(operation.error)) : undefined}
    errorState={operation?.errorState ?? 'unknown'}
    input={action === 'compact' ? { placeholder: '希望重点保留的内容（可选）', optional: true } : undefined}
    onCancel={onClose} onConfirm={async value => {
      if (submitted.current) throw new Error('上次提交仍在确认');
      submitted.current = true;
      await useCockpit.getState().runSessionSettingsAction(sessionId, action, value);
    }} />;
}

function ForkLink({ sessionId }: { sessionId: string }) {
  const { pathname } = useLocation();
  const navigation = sessionNavigation(pathname, sessionId);
  return <Link to={navigation.to} replace={navigation.replace}>打开新会话</Link>;
}

export function SessionOperations({ sessionId }: { sessionId: string }) {
  const [dialog, setDialog] = useState<SessionSettingsAction | null>(null);
  const session = useCockpit(s => s.sessions.find(row => row.sessionId === sessionId));
  const connected = useCockpit(s => s.connState === 'open' && s.snapshotReady);
  const operation = useCockpit(s => s.sessionSettingsOperations[sessionId]);
  const reload = useSessionReload(sessionId);
  const reason = sessionSettingsBlockReason(session, connected, operation?.pending || reload.pending);
  const pending = !!operation?.pending || reload.pending;
  const outcome = operation?.outcome;
  const reloadResult = useCockpit(s => s.sessionReloadResults[sessionId]);
  return <section className="info-section">
    <SectionHeading className="info-section-name">会话操作</SectionHeading>
    <div className="info-section-content info-controls">
      {reason && !pending && <StateNotice>{reason}</StateNotice>}
      <ActionList label="会话操作" disabled={!!reason && !pending}>
        {(session?.loaded || reload.pending) && <ActionRow icon="session_reload" name="重新加载"
          description="重新读取配置并应用角色" busyDescription="正在重新加载…"
          disabled={!!reload.blockedReason || !!reason} busy={reload.pending} onClick={reload.reload} />}
        {(Object.keys(rows) as SessionSettingsAction[]).map(action => <ActionRow key={action} {...rows[action]}
          disabled={!!reason} busy={operation?.pending && operation.action === action}
          onClick={() => setDialog(action)} />)}
      </ActionList>
      {reloadResult && !reload.pending && <OperationResult name="重新加载"
        state={reloadResult.state}>
        {reloadResult.state === 'done' ? copy.done('重新加载会话')
          : reloadResult.state === 'failed' ? copy.failed('重新加载会话', reloadResult.reason ?? '')
            : copy.unknown(reloadResult.reason ?? '')}
      </OperationResult>}
      {operation?.error && <OperationResult name={labels[operation.action]}
        state={operation.errorState ?? 'unknown'}>
        {operation.errorState === 'failed' ? copy.failed(labels[operation.action], operation.error) : copy.unknown(operation.error)}
      </OperationResult>}
      {outcome?.action === 'unload' && <OperationResult
        state={outcome.present && outcome.loaded ? 'unknown' : 'done'}>
        {!outcome.present ? '会话已不存在，未创建替代会话。'
          : outcome.loaded ? copy.unknown('会话仍显示为已加载') : '已卸载会话，聊天历史仍可查看。'}
      </OperationResult>}
      {outcome?.action === 'compact' && <OperationResult
        state={outcome.result.success ? 'done' : 'failed'}>
        {outcome.result.success ? copy.done('压缩上下文') : copy.failed('压缩上下文', '可能已有部分变化，请核对')}：
        移除 {outcome.result.tokensRemoved} 个令牌、{outcome.result.messagesRemoved} 条上下文消息。聊天历史未删除。
      </OperationResult>}
      {outcome?.action === 'fork' && <OperationResult state="done">
        已创建新会话：{outcome.sessionId}。未发送消息。{' '}
        <ForkLink sessionId={outcome.sessionId} />
      </OperationResult>}
      {operation?.refreshError && <OperationResult state="unknown">
        {copy.unknown(`状态同步未完成：${operation.refreshError}`)}
      </OperationResult>}
    </div>
    {dialog && <OperationDialog sessionId={sessionId} action={dialog} onClose={() => setDialog(null)} />}
  </section>;
}
