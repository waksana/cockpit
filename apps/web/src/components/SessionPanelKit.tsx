// Shared layout and resource controls for session settings, MCP and Skills.

import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { useCockpit } from '../net/store';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useMediaQuery } from '../lib/useMediaQuery';

// The shell for a per-session detail sub-page rendered in the info-panel slot:
// the same header (close + title) and scrollable body as SessionInfoPanel, so a
// moved-out section looks identical to where it used to live. Shows a loading or
// empty placeholder in place of the body when asked.
export function PanelCloseButton({ onClose }: { onClose: () => void }) {
  const phone = useMediaQuery('(max-width: 599px)');
  return (
    <button className="btn-icon rp" type="button" aria-label={phone ? '返回对话' : '关闭'} onClick={onClose}>
      <Icon name={phone ? 'back' : 'close'} size={24} />
    </button>
  );
}

export function PanelPageShell({ title, onClose, loading, empty, children, action }: {
  title: string;
  onClose: () => void;
  loading?: boolean;
  empty?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <>
      <header className="info-panel-header">
        <PanelCloseButton onClose={onClose} />
        <span className="info-panel-title" title={title}>{title}</span>
        {action}
      </header>
      <div className="info-panel-body scrollable">
        {loading
          ? <div className="info-loading"><span className="spinner" /> 加载中…</div>
          : empty != null
            ? <div className="info-empty">{empty}</div>
            : children}
      </div>
    </>
  );
}

export function ResourceStatus({ status, failed }: { status: string | null; failed?: boolean }) {
  return status ? <div className="info-loading" role={failed ? 'alert' : 'status'}>{status}</div> : null;
}

export function SessionResume({ sessionId, required, onResumed }: {
  sessionId: string; required: boolean; onResumed?: () => void;
}) {
  const session = useCockpit((s) => s.sessions.find((item) => item.sessionId === sessionId));
  const loadSession = useCockpit((s) => s.loadSession);
  const action = useKeyedAction(`resume:${sessionId}`);
  if (!required) return null;
  const resume = () => action.run(async () => {
    const current = useCockpit.getState().sessions.find((item) => item.sessionId === sessionId);
    if (!current || current.status === 'running' || current.compacting) return;
    await loadSession(sessionId);
  }, onResumed);
  return (
    <div className="info-section-content">
      <p className="info-option-hint" role="status">会话未加载。恢复后可查看这些设置；聊天历史仍可直接查看。</p>
      <button type="button" className="dialog-btn rp"
        disabled={!action.connected || !session || session.status === 'running' || session.compacting || action.busy}
        onClick={() => { void resume(); }}>{action.busy ? '恢复中…' : '恢复会话'}</button>
      {action.error && <ResourceStatus status={`恢复失败：${action.error}`} failed />}
    </div>
  );
}

export function PermissionPolicy() {
  const policy = useCockpit((s) => s.permissionPolicy);
  return (
    <div className="info-permission" data-permission-policy={policy}>
      <span>工具权限（只读）</span>
      <span>allow-all · 自动批准（所有交互模式）</span>
    </div>
  );
}
