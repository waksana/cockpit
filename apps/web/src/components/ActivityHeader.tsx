import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function ActivityHeader({ icon, title, status, className = '', disclosure }: {
  icon: ReactNode;
  title: string;
  status?: string;
  className?: string;
  disclosure?: { open: boolean; onToggle: () => void };
}) {
  const content = <>
    <span className="activity-icon">{icon}</span>
    <span className="activity-title" title={title}>{title}</span>
    {status && <span className="activity-status">{status}</span>}
    {disclosure && <span className="activity-chevron"><Icon name={disclosure.open ? 'up' : 'down'} size={14} /></span>}
  </>;
  return disclosure
    ? <button type="button" className={`activity-head ${className}`} aria-expanded={disclosure.open}
        aria-label={`${disclosure.open ? '收起' : '展开'}细节：${title}${status ? ` · ${status}` : ''}`}
        onClick={disclosure.onToggle}>{content}</button>
    : <div className={`activity-head ${className}`}>{content}</div>;
}
