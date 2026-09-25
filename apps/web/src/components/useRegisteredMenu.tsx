import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { ModuleMenuTarget } from '@cockpit/module-api/frontend';
import { useCockpit } from '../net/store';
import { ModuleErrorBoundary, type MenuTargetSource } from '../lib/moduleRuntime';
import { useModuleRuntime } from './ModuleComponents';
import type { MenuItem } from './ContextMenu';

const GLOBAL_SOURCE: MenuTargetSource = { isCurrent: () => true, subscribe: () => () => {} };

class MenuOwner {
  private active = false;
  readonly source: MenuTargetSource;
  readonly target?: ModuleMenuTarget;
  constructor(target?: ModuleMenuTarget) {
    this.target = target;
    this.source = target?.menu !== 'session' ? GLOBAL_SOURCE : {
      isCurrent: () => {
        const state = useCockpit.getState();
        return state.snapshotReady && state.connState === 'open'
          && state.sessions.some(session => session.sessionId === target.sessionId);
      },
      subscribe: useCockpit.subscribe,
    };
  }
  isOpen = () => this.active;
  hasTarget = () => this.target?.menu !== 'session'
    || useCockpit.getState().sessions.some(session => this.target?.menu === 'session' && session.sessionId === this.target.sessionId);
  mount = () => {
    this.active = true;
    return () => { this.active = false; };
  };
}

export function useRegisteredMenu(native: MenuItem[], target?: ModuleMenuTarget): MenuItem[] {
  const runtime = useModuleRuntime();
  const menu = target?.menu;
  const sessionId = target?.menu === 'session' ? target.sessionId : undefined;
  const owner = useMemo(() => new MenuOwner(menu === 'session' && sessionId !== undefined
    ? { menu, sessionId } : menu === 'global' ? { menu } : undefined), [menu, sessionId]);
  useLayoutEffect(() => owner.mount(), [owner]);
  useSyncExternalStore(runtime.subscribeMenus, runtime.getMenuRevision, runtime.getMenuRevision);
  useSyncExternalStore(owner.source.subscribe, owner.source.isCurrent, owner.source.isCurrent);
  if (!owner.target) return native;
  const items: MenuItem[] = [
    ...native.map(item => ({
      ...item, id: JSON.stringify(['native', item.id ?? item.label]),
      disabled: !!item.disabled || !owner.hasTarget(),
      onClick: () => {
        if (!owner.isOpen() || !owner.hasTarget() || item.disabled) {
          runtime.report(new Error('Menu target is no longer available'));
          return;
        }
        item.onClick();
      },
    })),
    ...runtime.menuItems(owner.target, owner.source, owner.isOpen).map(({ icon, ...item }, index) => ({
      ...item,
      separatorBefore: index === 0 || item.separatorBefore,
      iconContent: icon === undefined ? undefined : <ModuleErrorBoundary key={item.id}
        fallback={null} onFailure={runtime.report}>{icon}</ModuleErrorBoundary>,
    })),
  ];
  return items.map((item, index) => ({ ...item, separatorBefore: index > 0 && item.separatorBefore }));
}
