import type { ComponentProps, ReactNode } from 'react';
import { ComposerDockContext, ComposerSurfaceContext } from '../lib/publicComponentContext';

export function ComposerSurface({ children }: { children: ReactNode }) {
  return <div className="chat-input-area"><ComposerDockContext.Provider value={true}>{children}</ComposerDockContext.Provider></div>;
}

export function ComposerCard({ children, header, bodyId, bodyHidden, ...props }: ComponentProps<'div'> & {
  header?: ReactNode; bodyId?: string; bodyHidden?: boolean;
}) {
  return <div className="chat-input-card" {...props}>
    {header}
    <div id={bodyId} className="chat-input-card-body" hidden={bodyHidden}>
      <ComposerSurfaceContext.Provider value={true}>{children}</ComposerSurfaceContext.Provider>
    </div>
  </div>;
}
