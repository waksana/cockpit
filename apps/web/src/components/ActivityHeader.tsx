import type { ReactNode } from 'react';

export function ActivityHeader({ icon, title, status, accessibleStatus = status, className = '', disclosure }: {
  icon: ReactNode;
  title: string;
  status?: string;
  accessibleStatus?: string;
  className?: string;
  disclosure?: { open: boolean; onToggle: () => void };
}) {
  const content = <>
    <span className="activity-icon">{icon}</span>
    <span className="activity-title" title={title}>{title}</span>
    {status && <span className="activity-status">{status}</span>}
  </>;
  return disclosure
    ? <button type="button" className={`activity-head ${className}`} aria-expanded={disclosure.open}
        aria-label={`${disclosure.open ? '收起' : '展开'}细节：${title}${accessibleStatus ? ` · ${accessibleStatus}` : ''}`}
        onClick={disclosure.onToggle}>{content}</button>
    : <div className={`activity-head ${className}`}>{content}</div>;
}
