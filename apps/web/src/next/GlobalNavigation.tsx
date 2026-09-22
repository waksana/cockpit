import { useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Menu } from 'lucide-react';
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@cockpit/ui';
import { moduleRuntime } from '../lib/moduleRuntime';
import { useRegisteredMenu } from './modules';

export function GlobalNavigation({ moduleBootstrap }: { moduleBootstrap: 'loading' | 'settled' }) {
  const items = useRegisteredMenu([], { menu: 'global' });
  const unavailable = useSyncExternalStore(moduleRuntime.subscribe,
    moduleRuntime.getUnavailablePresentations, moduleRuntime.getUnavailablePresentations);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="全局导航">
      <Menu aria-hidden="true" />
    </Button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="next-navigation-menu">
      <DropdownMenuLabel>Cockpit</DropdownMenuLabel>
      <DropdownMenuItem asChild><Link to="/">会话</Link></DropdownMenuItem>
      <DropdownMenuItem asChild><Link to="/mcp">全局 MCP</Link></DropdownMenuItem>
      <DropdownMenuItem asChild><Link to="/skills">全局 Skills</Link></DropdownMenuItem>
      <DropdownMenuSeparator />
      {items.map(item => <DropdownMenuItem key={item.id ?? item.label} disabled={item.disabled}
        variant={item.destructive ? 'destructive' : 'default'} onSelect={item.onClick}>
        {item.iconContent && <span aria-hidden="true">{item.iconContent}</span>}{item.label}
      </DropdownMenuItem>)}
      {items.length > 0 && <DropdownMenuSeparator />}
      {moduleBootstrap === 'settled' && unavailable.length > 0 && <DropdownMenuLabel className="next-navigation-note">
        {unavailable.map(module => module.name).join('、')}仅提供经典界面；这不代表模块后端已停用。
      </DropdownMenuLabel>}
      <DropdownMenuItem asChild><a href="/">打开经典界面 <ArrowUpRight aria-hidden="true" /></a></DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
