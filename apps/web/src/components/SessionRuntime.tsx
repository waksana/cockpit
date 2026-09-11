import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCockpit } from '../net/store';
import type { ChatSession } from '../net/types';
import { Dialog, type DialogProps } from './Dialog';
import { PanelPageShell, ResourceStatus, SessionResume } from './SessionPanelKit';

type SessionRuntimeProps = { session: ChatSession; onClose: () => void };
type RuntimeOperation = 'compact' | 'rewind' | 'reload' | 'unload';

export function SessionRuntime(props: SessionRuntimeProps) {
  return <RuntimeDetails key={props.session.sessionId} {...props} />;
}

function RuntimeDetails({ session, onClose }: SessionRuntimeProps) {
  const sid = session.sessionId;
  const { compactSession, rewindSession, reloadSession, unloadSession } = useCockpit(useShallow((s) => ({
    compactSession: s.compactSession,
    rewindSession: s.rewindSession,
    reloadSession: s.reloadSession,
    unloadSession: s.unloadSession,
  })));
  const { connected, status, loaded, compacting, error } = useCockpit(useShallow((s) => {
    const current = s.sessions.find((item) => item.sessionId === sid);
    return {
      connected: s.connState === 'open',
      status: current?.status,
      loaded: current?.loaded ?? false,
      compacting: current?.compacting ?? false,
      error: current?.error,
    };
  }));
  const [dialog, setDialog] = useState<DialogProps | null>(null);
  const busy = status === 'running' || compacting;
  const disabled = !connected || !status || busy || dialog !== null;
  const statusLabel = compacting ? '压缩中' : status
    ? { unloaded: '未加载', idle: '空闲', running: '运行中', error: '错误' }[status]
    : '会话不可用';

  const confirmRuntime = (action: () => Promise<void>, requireLoaded = false) => {
    const state = useCockpit.getState();
    const current = state.sessions.find((item) => item.sessionId === sid);
    if (state.connState !== 'open') throw new Error('未连接，请在连接恢复后重试。');
    if (!current) throw new Error('会话已不可用。');
    if (current.status === 'running' || current.compacting) throw new Error('会话正在运行或压缩，请等待完成后重试。');
    if (requireLoaded && !current.loaded) throw new Error('会话已卸载，无需再次卸载。');
    return action();
  };
  const openDialog = (operation: RuntimeOperation, props: Omit<DialogProps, 'actionKey' | 'onCancel'>) => {
    setDialog({ ...props, actionKey: `runtime:${sid}:${operation}`, onCancel: () => setDialog(null) });
  };

  const compact = () => openDialog('compact', {
    title: '压缩上下文',
    message: '将对话压缩成摘要，释放上下文窗口；较早细节会被精简，无法撤销。未加载的会话会先恢复运行时。',
    confirmLabel: '压缩',
    onConfirm: () => confirmRuntime(() => compactSession(sid)),
  });
  const rewind = () => {
    const current = useCockpit.getState().sessions.find((item) => item.sessionId === sid);
    const historyReady = current?.materialized && !current.historyStale && !current.loadingHistory;
    const lastUser = current?.messages.findLast((message) => message.role === 'user' && !message.subtype);
    if (!historyReady || !lastUser) {
      openDialog('rewind', {
        title: '无法回退',
        message: !historyReady
          ? '对话历史尚未加载或已过期。请先返回对话等待加载完成，再回到运行时重试。'
          : '当前已加载的对话中没有可回退的用户消息。',
        confirmLabel: '知道了',
        acknowledgementOnly: true,
        onConfirm: () => {},
      });
      return;
    }
    openDialog('rewind', {
      title: '撤销上一轮',
      message: '移除最后一条用户消息及其后的对话，无法撤销。默认不改动文件；勾选文件回退时可能因不受支持而被拒绝。',
      confirmLabel: '回退',
      destructive: true,
      rollbackFiles: false,
      onConfirm: (_value, rollbackFiles) => confirmRuntime(() => {
        const latest = useCockpit.getState().sessions.find((item) => item.sessionId === sid);
        if (!latest?.materialized || latest.historyStale || latest.loadingHistory) {
          throw new Error('对话历史已过期，请先返回对话等待加载完成，再重新选择回退。');
        }
        const latestUser = latest.messages.findLast((message) => message.role === 'user' && !message.subtype);
        if (latestUser?.id !== lastUser.id) throw new Error('对话已有更新，请取消并重新选择要回退的轮次。');
        return rewindSession(sid, lastUser.id, rollbackFiles);
      }),
    });
  };
  const reload = () => openDialog('reload', {
    title: '重载会话',
    message: '重新加载会话运行时，保留对话历史。',
    confirmLabel: '重载',
    onConfirm: () => confirmRuntime(() => reloadSession(sid)),
  });
  const unload = () => openDialog('unload', {
    title: '卸载会话',
    message: '释放运行时，保留已持久化的对话历史。从未发送消息的空原生会话可能消失，不会自动重建。定时任务会暂停；后台 shell 可能继续运行，卸载后可能无法再通过任务接口访问。',
    confirmLabel: '卸载',
    onConfirm: () => confirmRuntime(() => unloadSession(sid), true),
  });

  return (
    <>
      <PanelPageShell title={`运行维护 · ${session.title}`} onClose={onClose}>
        <section className="info-section" aria-label="运行时状态">
          <div className="info-section-name">运行时状态</div>
          <div className="info-section-content info-controls">
            <div className="info-option-row">
              <span className="info-option-label">状态</span>
              <span className="info-option-hint" role="status">{statusLabel}</span>
            </div>
            <div className="info-option-row">
              <span className="info-option-label">运行时</span>
              <span className="info-option-hint">{!status ? '不可用' : loaded ? '已加载' : '未加载'}</span>
            </div>
            <ResourceStatus status={!connected ? '等待连接…状态可能已过期，连接恢复前无法操作。' : null} />
            <ResourceStatus status={error ?? null} failed />
            {busy && <p className="info-option-hint">会话正在运行或压缩，完成后才能执行运行时操作。</p>}
          </div>
        </section>
        <section className="info-section" aria-label="运行时操作">
          <div className="info-section-name">运行时操作</div>
          <div className="info-section-content info-controls">
            <SessionResume sessionId={sid} required={Boolean(status) && !loaded} />
            <div className="info-option-row">
              <span className="info-option-hint">将对话压缩成摘要，释放上下文窗口</span>
              <button type="button" className="dialog-btn rp" disabled={disabled} onClick={compact}>压缩</button>
            </div>
            <div className="info-option-row">
              <span className="info-option-hint">回退到最后一条用户消息之前</span>
              <button type="button" className="dialog-btn rp" disabled={disabled} onClick={rewind}>回退</button>
            </div>
            {(!status || loaded) && <div className="info-option-row">
              <span className="info-option-hint">重新加载运行时，恢复保存的对话</span>
              <button type="button" className="dialog-btn rp" disabled={disabled} onClick={reload}>重载</button>
            </div>}
            <div className="info-option-row">
              <span className="info-option-hint">释放运行时，保留历史；定时任务暂停</span>
              <button type="button" className="dialog-btn rp" disabled={disabled || !loaded} onClick={unload}>卸载</button>
            </div>
          </div>
        </section>
        <p className="info-option-hint">原生运行时空闲 30 分钟后会卸载，已持久化的历史仍保留；从未发送消息的空会话可能消失，不会自动重建。置顶或查看历史不会使运行时常驻。</p>
        <p className="info-option-hint">卸载期间定时任务暂停，恢复后重新计算执行时间。后台 shell 可能继续运行，卸载后可能无法再通过任务接口访问。</p>
      </PanelPageShell>
      {dialog && <Dialog {...dialog} />}
    </>
  );
}
