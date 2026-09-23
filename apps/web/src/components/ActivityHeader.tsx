import type { ReactNode } from 'react';
import { Disclosure } from './Disclosure';

// Chat activity rows keep their own icon in the leading slot of the shared disclosure.
export function ActivityHeader({ icon, title, status, accessibleStatus = status, className = '', disclosure }: {
  icon: ReactNode;
  title: string;
  status?: string;
  accessibleStatus?: string;
  className?: string;
  disclosure?: { open: boolean; onToggle: () => void; controls?: string };
}) {
  const leading = <span className="activity-icon">{icon}</span>;
  const content = <>
    <span className="activity-title" title={title}>{title}</span>
    {status && <span className="activity-status">{status}</span>}
  </>;
  return disclosure
    ? <Disclosure className={`activity-head ${className}`.trim()} open={disclosure.open} onToggle={disclosure.onToggle}
        controls={disclosure.controls} name={`细节：${title}${accessibleStatus ? ` · ${accessibleStatus}` : ''}`}
        leading={leading}>{content}</Disclosure>
    : <div className={`activity-head ${className}`}>{leading}{content}</div>;
}
