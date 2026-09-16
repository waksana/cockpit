import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function StateNotice({ children, kind = 'info', placement = 'inline', className = '' }: {
  children: ReactNode; kind?: 'loading' | 'error' | 'empty' | 'info';
  placement?: 'inline' | 'pane'; className?: string;
}) {
  return <div className={`state-notice ${className}`.trim()} data-kind={kind} data-placement={placement}
    role={kind === 'error' ? 'alert' : 'status'}>
    {kind === 'loading' && <Icon name="loading" className="spinner" size={16} />}
    <div className="state-notice-content">{children}</div>
  </div>;
}
