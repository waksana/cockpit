import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useCockpit } from '../../net/store';
import { sessionSettingsBlockReason, type SessionSettingsAction } from '../../lib/sessionSettingsActions';
import { sessionNavigation } from '../../lib/routeOwnership';
import { useSessionReload } from './useSessionReload';
import { Dialog } from '../../components/Dialog';
import { SectionHeading } from '../../components/UI';
import { StateNotice } from '../../components/StateNotice';

const labels = { unload: '卸载会话', compact: '压缩上下文', fork: '分叉会话' };
const messages = {
  unload: '释放会话运行资源，不删除已持久化的聊天历史。定时任务会暂停；冷恢复使用原生默认配置，临时 MCP / Skill 选择可能不保留。从未发消息的空会话可能消失，不会自动创建替代会话。',
  compact: '汇总模型上下文，不删除页面或已持久化的聊天历史。此操作无法撤销。可选填写希望重点保留的内容，但不能保证文字或事实一定保留。',
  fork: '分叉完整当前历史，创建未加载的新会话，不发送消息。新会话仍共享工作目录和文件，不是隔离的代码工作区，也不是完整运行配置克隆。不创建分支、工作树或分配 Task。未完成的历史边界、活动定时任务或继承的定时任务历史会被原生拒绝。',
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
    error={operation?.error ? `结果未确认：${operation.error}。请先核对会话列表和原生记录；此对话框不会重复发送。` : undefined}
    input={action === 'compact' ? { placeholder: '希望重点保留的内容（可选）', optional: true } : undefined}
    onCancel={onClose} onConfirm={async value => {
      if (submitted.current) throw new Error('结果尚未确认，请先核对会话列表和原生记录；此对话框不会重复发送。');
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
  const outcome = operation?.outcome;
  return <section className="info-section">
    <SectionHeading className="info-section-name">会话操作</SectionHeading>
    <div className="info-section-content">
      <div className="ck-actions">
        {(session?.loaded || reload.pending) && <button type="button" className="ck-button rp"
          disabled={!!reload.blockedReason || !!reason} aria-busy={reload.pending}
          title={reload.blockedReason || reason} onClick={reload.reload}>
          {reload.pending ? '正在重新加载会话…' : '重新加载会话'}
        </button>}
        {(Object.keys(labels) as SessionSettingsAction[]).map(action => <button key={action} type="button"
          className="ck-button rp" disabled={!!reason} title={reason}
          aria-busy={operation?.pending && operation.action === action}
          onClick={() => setDialog(action)}>
          {operation?.pending && operation.action === action ? `${labels[action]}处理中…` : labels[action]}
        </button>)}
      </div>
      {reason && !operation?.pending && !reload.pending && <StateNotice>{reason}</StateNotice>}
      {operation?.error && <StateNotice kind="error">
        {labels[operation.action]}结果未确认：{operation.error}。请先核对会话列表和原生记录，不要盲目重试。
      </StateNotice>}
      {outcome?.action === 'unload' && <StateNotice>
        {!outcome.present ? '原生会话已不存在，未创建替代会话。'
          : outcome.loaded ? '原生仍报告会话已加载，未确认卸载。' : '会话已卸载，已持久化的聊天历史仍可查看。'}
      </StateNotice>}
      {outcome?.action === 'compact' && <>
        <StateNotice kind={outcome.result.success ? 'info' : 'error'}>
          {outcome.result.success ? '原生上下文压缩完成' : '原生报告压缩未成功，请核对可能的部分变化'}；
          移除 {outcome.result.tokensRemoved} 个令牌、{outcome.result.messagesRemoved} 条上下文消息。聊天历史未删除。
        </StateNotice>
        <details className="info-model-details"><summary>原生压缩结果</summary><pre>{JSON.stringify(outcome.result, null, 2)}</pre></details>
      </>}
      {outcome?.action === 'fork' && <StateNotice>
        已创建新会话：{outcome.sessionId}。未发送消息。{' '}
        <ForkLink sessionId={outcome.sessionId} />
      </StateNotice>}
      {operation?.refreshError && <StateNotice kind="error">
        状态同步未完成：{operation.refreshError}。已返回的原生结果仍保留，请先刷新核对，不要重复提交。
      </StateNotice>}
    </div>
    {dialog && <OperationDialog sessionId={sessionId} action={dialog} onClose={() => setDialog(null)} />}
  </section>;
}
