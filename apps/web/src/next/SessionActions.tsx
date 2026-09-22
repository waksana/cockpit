import { MoreHorizontal } from 'lucide-react';
import {
  Button, ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@cockpit/ui';
import { Fragment, type ReactNode } from 'react';
import type { SessionMeta } from '../net/types';
import { useCockpit } from '../net/store';
import { sessionActionItems, type SessionActionHandlers } from '../lib/sessionActions';
import { useRegisteredMenu } from './modules';

function ActionItems({ session, handlers, context = false }: {
  session: SessionMeta; handlers: SessionActionHandlers; context?: boolean;
}) {
  const connected = useCockpit(state => state.connState === 'open' && state.snapshotReady);
  const items = useRegisteredMenu(sessionActionItems(session, connected, handlers),
    { menu: 'session', sessionId: session.sessionId });
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  return items.map(item => <Fragment key={item.id ?? item.label}>
    {item.separatorBefore && <Separator />}
    <Item disabled={item.disabled} variant={item.destructive ? 'destructive' : 'default'} onSelect={item.onClick}>
      {item.iconContent && <span aria-hidden="true">{item.iconContent}</span>}{item.label}
    </Item>
  </Fragment>);
}

export function SessionActions({ session, handlers }: { session: SessionMeta; handlers: SessionActionHandlers }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`${session.title}的操作`}>
      <MoreHorizontal aria-hidden="true" />
    </Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><ActionItems session={session} handlers={handlers} /></DropdownMenuContent>
  </DropdownMenu>;
}

export function SessionContextMenu({ session, handlers, children }: {
  session: SessionMeta; handlers: SessionActionHandlers; children: ReactNode;
}) {
  return <ContextMenu><ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
    <ContextMenuContent><ActionItems session={session} handlers={handlers} context /></ContextMenuContent>
  </ContextMenu>;
}
