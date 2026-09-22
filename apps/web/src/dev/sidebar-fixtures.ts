import { createElement } from 'react';
import type { ActivateFrontend } from '@cockpit/module-api';
import type { SessionRole } from '@cockpit/protocol';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { activityFixture } from './activity-fixtures';
import { workspaceSessions } from './workspace-fixtures';

export function sidebarSessions(now = Date.now()) {
  const roles: SessionRole[] = [
    { moduleId: 'fixture', moduleName: 'Fixture', roleId: 'owner', name: 'Owner' },
    { moduleId: 'fixture', moduleName: 'Fixture', roleId: 'executor', name: 'Executor' },
  ];
  const sessions = workspaceSessions(now);
  return sessions.map((session, index) => ({
    ...session,
    title: [
      'Short',
      '这是用于确认经典会话列表标题最多显示两行的合成长中文标题以及完整名称保留',
      'SyntheticContinuousEnglishTitleWithoutSpacesForNarrowSidebarLayout'.repeat(2),
      'Unloaded',
      'Refreshing activity',
      'Activity error',
    ][index],
    cwd: index === 2 ? `/workspace/${'long-directory-'.repeat(8)}` : session.cwd,
    loaded: index !== 3,
    status: index === 3 ? 'unloaded' as const : index === 5 ? 'error' as const : session.status,
    roles: index === 1 ? roles : index === 3 ? [roles[1]] : [],
    appliedRoles: index === 1 ? [roles[0]] : [],
    activity: index === 1 ? activityFixture({
      processing: true, hasActiveWork: true,
      tasks: { activeAgents: 2, activeShells: 1, unknown: 0 },
    }) : null,
    ask: index === 1 ? { requestId: 'sidebar-question', question: 'Synthetic decision', choices: ['OK'] } : null,
    activityDisplay: index === 4 ? {
      previous: { status: 'running' as const, activity: activityFixture({ processing: true }) },
    } : undefined,
    error: index === 5 ? 'Synthetic activity failure' : null,
  }));
}

export function createSidebarModuleFixture() {
  const digest = 'b'.repeat(64);
  return new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'sidebar-fixture', name: 'Synthetic unread', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/sidebar-fixture/${digest}/api`, entry: `/_modules/assets/sidebar-fixture/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate: (() => ({
      apiVersion: 2,
      components: [{
        id: 'unread', boundary: 'sessionStatus', wrap: Base => props => createElement(Base, {
          ...props, children: createElement('span', {
            'data-sidebar-unread': props.sessionId, 'aria-label': '7 unread', className: 'ck-badge',
          }, '7', props.children),
        }),
      }],
    })) satisfies ActivateFrontend }),
  });
}
