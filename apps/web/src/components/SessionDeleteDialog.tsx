import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionDeletionPlan, SessionUnbindApproval } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { useModalFocus } from '../lib/useModalFocus';

type DeleteSession = (sessionId: string, confirm: true, unbind?: SessionUnbindApproval) => Promise<void>;

// Kept testable without a DOM so transport uncertainty and retry identity use the same rules as the modal.
// eslint-disable-next-line react-refresh/only-export-components
export function createDeletionAttempt(sessionId: string, fallbackOperationId: string) {
  let pending = false, sent = false;
  let operationId: string | undefined;
  let submittedPlan: SessionDeletionPlan | undefined;
  const blockedReason = (plan?: SessionDeletionPlan): string | null => {
    if (!plan || plan.sessionId !== sessionId) return '尚未取得此会话的有效删除预览。';
    if (pending || plan.state === 'working') return '服务仍在处理此操作，请读取最新状态，不要重复发送。';
    if (plan.state === 'unknown') return '操作结果未知，请先核对服务状态；不会重试不确定的删除。';
    if (plan.state === 'deleted') return '服务记录此会话已删除，不再发送删除请求。';
    if (sent && (plan === submittedPlan || !operationId || plan.operationId !== operationId
      || !['failed', 'unbound'].includes(plan.state ?? ''))) {
      return '上次删除未获确认。请读取最新状态；仅可继续服务确认的原操作。';
    }
    return null;
  };
  return {
    get pending() { return pending; },
    blockedReason,
    async run(plan: SessionDeletionPlan, remove: DeleteSession) {
      const blocked = blockedReason(plan);
      if (blocked) throw new Error(blocked);
      const unbind = plan.modules.length || plan.operationId ? {
        planId: plan.planId, operationId: operationId ?? plan.operationId ?? fallbackOperationId,
      } : undefined;
      operationId = unbind?.operationId;
      submittedPlan = plan;
      pending = true;
      sent = true;
      try { await remove(sessionId, true, unbind); }
      finally { pending = false; }
    },
  };
}

interface Props {
  sessionId: string;
  name: string;
  onCancel: () => void;
  onSuccess: () => void;
}

export function SessionDeleteDialog(props: Props) {
  const dialog = <SessionDeleteDialogContent key={props.sessionId} {...props} />;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

function SessionDeleteDialogContent({ sessionId, name, onCancel, onSuccess }: Props) {
  const previewDeleteSession = useCockpit(s => s.previewDeleteSession);
  const deleteSession = useCockpit(s => s.deleteSession);
  const identity = useId();
  const [attempt] = useState(() => createDeletionAttempt(sessionId, crypto.randomUUID()));
  const [revision, setRevision] = useState(0);
  const load = useCallback((signal: AbortSignal) => previewDeleteSession(sessionId, signal), [previewDeleteSession, sessionId]);
  const preview = useKeyedResource(`delete-preview:${identity}:${sessionId}`, load, revision);
  const action = useKeyedAction(`delete:${identity}:${sessionId}`);
  const busy = action.busy || attempt.pending;
  const blockedReason = attempt.blockedReason(preview.data);
  const canConfirm = preview.valid && !busy && !blockedReason;
  const confirm = () => {
    if (!canConfirm || !preview.data) return;
    const plan = preview.data;
    void action.run(async () => {
      try { await attempt.run(plan, deleteSession); }
      catch (error) {
        // Only re-read progress. A retry of the mutation always needs a new explicit click.
        setRevision(value => value + 1);
        throw error;
      }
    }, () => { onSuccess(); onCancel(); });
  };
  return <SessionDeleteDialogView name={name} sessionId={sessionId} plan={preview.data}
    status={preview.status} error={action.error} busy={busy} refreshing={preview.pending}
    canConfirm={canConfirm} blockedReason={blockedReason}
    onConfirm={confirm} onCancel={onCancel} onRefresh={() => { void preview.refresh(); }} />;
}

interface ViewProps {
  sessionId: string;
  name: string;
  plan?: SessionDeletionPlan;
  status?: string | null;
  error?: string | null;
  busy: boolean;
  refreshing?: boolean;
  canConfirm: boolean;
  blockedReason?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onRefresh: () => void;
}

const stateLabels = {
  working: '正在解除关联或删除会话',
  unbound: '关联已解除，会话删除尚未确认',
  failed: '操作失败，已完成的解除关联步骤会保留',
  unknown: '操作结果未知，不能当作已解除关联或已删除',
  deleted: '会话已删除',
};

export function SessionDeleteDialogView({
  sessionId, name, plan, status, error, busy, refreshing, canConfirm, blockedReason, onConfirm, onCancel, onRefresh,
}: ViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const identity = useId();
  useModalFocus(ref);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!busy) onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);
  const cancel = () => { if (!busy) onCancel(); };
  return <div className="dialog-scrim" onPointerDown={cancel}>
    <div ref={ref} tabIndex={-1} className="dialog-card" role="dialog" aria-modal="true" aria-label="永久删除会话"
      aria-busy={busy || refreshing} aria-describedby={`${identity}-notice`}
      style={{ maxHeight: 'calc(100dvh - 2rem)', overflowY: 'auto', overflowWrap: 'anywhere' }}
      onPointerDown={event => event.stopPropagation()}>
      <h3 className="dialog-title">永久删除会话</h3>
      <p className="dialog-message" id={`${identity}-notice`}>
        永久删除「{name}」及其 Copilot 会话历史，此操作不可恢复。托管文件和工作目录不会被删除。
      </p>
      <p className="dialog-message">会话：{sessionId}</p>
      {status && <p className="dialog-message" role="status">{status}</p>}
      {plan && status && <p className="dialog-message">以下为上次读取的预览；最新状态尚未确认。</p>}
      {plan && <>
        {plan.modules.length > 0 ? <>
          <p className="dialog-message">以下模块声明了会话解除关联能力，将先解除关联，再删除会话：</p>
          <ul className="dialog-message">{plan.modules.map(module => <li key={module.moduleId}>
            {module.name || module.moduleId} · {module.version}
          </li>)}</ul>
        </> : <p className="dialog-message">没有需要解除关联的模块。</p>}
        {plan.state && <p className="dialog-message" role="status">{stateLabels[plan.state]}</p>}
        {!!plan.completedModules?.length && <p className="dialog-message">
          已完成解除关联：{plan.completedModules.map(id => plan.modules.find(module => module.moduleId === id)?.name ?? id).join('、')}
        </p>}
        {plan.operationId && <p className="dialog-message">操作：{plan.operationId}</p>}
        {plan.error && <p className="dialog-message dialog-error" role="alert">{plan.error}</p>}
      </>}
      {blockedReason && <p className="dialog-message" role="status">{blockedReason}</p>}
      {error && <p className="dialog-message dialog-error" role="alert">删除未获确认：{error}。不会自动重试。</p>}
      <div className="dialog-actions" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="dialog-btn rp" disabled={busy} onClick={cancel}>取消</button>
        <button type="button" className="dialog-btn rp" disabled={busy || refreshing} onClick={onRefresh}>读取最新状态</button>
        <button type="button" className="dialog-btn primary rp danger" disabled={!canConfirm || busy}
          onClick={onConfirm}>{busy ? '处理中…' : plan?.modules.length ? '解除关联并删除会话' : '永久删除'}</button>
      </div>
    </div>
  </div>;
}
