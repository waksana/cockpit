import type { ReactNode } from 'react';

export function PaneHeader({ title, leading, actions, className = '' }: {
  title: ReactNode; leading?: ReactNode; actions?: ReactNode; className?: string;
}) {
  return <header className={`pane-header ${className}`.trim()}>
    {leading}
    <div className="pane-header-content">{title}</div>
    {actions}
  </header>;
}
