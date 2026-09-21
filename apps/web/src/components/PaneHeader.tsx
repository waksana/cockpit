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

// A page body owns scrolling unless its content already has a scroll owner
// (for example Thread). Headers and overlays are always outside that owner.
export function PaneBody({ children, className = '', scroll = true, padded = true }: {
  children: ReactNode; className?: string; scroll?: boolean; padded?: boolean;
}) {
  return <div className={`pane-body${scroll ? ' scrollable' : ''}${className ? ` ${className}` : ''}`}
    data-scroll={scroll} data-padded={padded}>{children}</div>;
}
