// Shared layout and resource controls for session settings, MCP and Skills.

import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useMediaQuery } from '../lib/useMediaQuery';
import { PaneHeader } from './PaneHeader';
import { StateNotice } from './StateNotice';
import { useClippedText } from '../lib/useClippedText';

export function ExpandableText({ text, label, className = '' }: {
  text: string; label: string; className?: string;
}) {
  const id = useId();
  const { ref, clipped } = useClippedText(text, 2);
  const [expandedText, setExpandedText] = useState<string | null>(null);
  const expanded = expandedText === text;
  return <div className={`panel-expandable ${className}`.trim()}>
    <span ref={ref} id={id} className="panel-expandable-text" data-expanded={expanded || undefined}>{text}</span>
    {clipped && <button type="button" className="panel-expandable-toggle ck-button"
      aria-label={`${expanded ? '收起' : '展开'}${label}`} aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpandedText(expanded ? null : text)}>{expanded ? '收起' : '展开全文'}</button>}
  </div>;
}

// The shell for a per-session detail sub-page rendered in the info-panel slot:
// the same header (close + title) and scrollable body as SessionInfoPanel.
export function PanelCloseButton({ onClose }: { onClose: () => void }) {
  const phone = useMediaQuery('(max-width: 599px)');
  return (
    <button className="ck-icon-button rp" type="button" aria-label={phone ? '返回对话' : '关闭'} onClick={onClose}>
      <Icon name={phone ? 'back' : 'close'} size={24} />
    </button>
  );
}

export function PanelPageShell({ title, onClose, loading, children, bodyClassName = '' }: {
  title: string;
  onClose: () => void;
  loading?: boolean;
  children?: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <>
      <PaneHeader leading={<PanelCloseButton onClose={onClose} />}
        title={<span className="info-panel-title" title={title}>{title}</span>} />
      <div className={`info-panel-body scrollable ${bodyClassName}`.trim()}>
        {loading
          ? <StateNotice kind="loading" placement="pane">加载中…</StateNotice>
          : children}
      </div>
    </>
  );
}

export function ResourceStatus({ status, failed, pending, placement = 'inline' }: {
  status: string | null; failed?: boolean; pending?: boolean; placement?: 'inline' | 'pane';
}) {
  return status ? <StateNotice kind={failed ? 'error' : pending ? 'loading' : 'info'} placement={placement}>{status}</StateNotice> : null;
}

export function RefreshButton({ onClick, disabled, pending }: {
  onClick: () => void; disabled?: boolean; pending: boolean;
}) {
  return <button className="ck-icon-button rp manage-action" type="button" aria-label="刷新"
    onClick={onClick} disabled={disabled} aria-busy={pending}>
    {pending ? <Icon name="loading" className="spinner" size={16} /> : <Icon name="reload" size={20} />}
  </button>;
}

export function SessionResume({ sessionId, required, onResumed }: {
  sessionId: string; required: boolean; onResumed?: () => void;
}) {
  const session = useCockpit((s) => s.sessions.find((item) => item.sessionId === sessionId));
  const loadSession = useCockpit((s) => s.loadSession);
  const action = useKeyedAction(`resume:${sessionId}`);
  const descriptionId = useId();
  if (!required) return null;
  const resume = () => action.run(async () => {
    const current = useCockpit.getState().sessions.find((item) => item.sessionId === sessionId);
    if (!current || current.closing || current.status === 'running' || current.compacting) return;
    await loadSession(sessionId);
  }, onResumed);
  return (
    <div className="session-resume" role="group" aria-label="会话未加载">
      <p id={descriptionId} className="session-resume-message" role="status">会话未加载。恢复后可查看这些设置；聊天历史仍可直接查看。</p>
      <button type="button" className="dialog-btn ck-button rp"
        disabled={!action.connected || !session || session.closing || session.status === 'running' || session.compacting || action.busy}
        aria-busy={action.busy}
        aria-describedby={descriptionId}
        onClick={() => { void resume(); }}>{action.busy ? '恢复中…' : '恢复会话'}</button>
      {action.error && <ResourceStatus status={`恢复失败：${action.error}`} failed />}
    </div>
  );
}
