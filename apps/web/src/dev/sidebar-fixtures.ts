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
  const longRoles: SessionRole[] = [
    { moduleId: 'cockpit-task', moduleName: 'Task', roleId: 'executor', name: 'Executor' },
    { moduleId: 'fixture-review', moduleName: 'SyntheticReviewModuleWithLongName', roleId: 'reviewer',
      name: 'IndependentReadOnlyReviewer' },
    { moduleId: 'fixture-docs', moduleName: '文档模块', roleId: 'writer', name: '长名称的文档维护角色' },
  ];
  const sessions = workspaceSessions(now);
  const base = sessions.map((session, index) => ({
    ...session,
    title: [
      'Short',
      '这是用于确认会话列表标题最多显示两行的合成长中文标题以及完整名称保留',
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
  const template = base[5];
  // Extreme two-line cases: every built-in status at once, many long roles, and neither.
  return [...base, {
    ...template, sessionId: 'demo-extreme', lastActivity: now - 90_000_000,
    title: '所有极端情况同时出现：超长标题 SyntheticExtremelyLongTitleThatMustEllipsizeBeforeTheTime',
    cwd: `/workspace/${'extremely-long-directory-name-'.repeat(4)}`,
    status: 'running' as const, error: null, compacting: true,
    roles: longRoles, appliedRoles: [longRoles[0]],
    activity: activityFixture({
      processing: true, hasActiveWork: true,
      tasks: { activeAgents: 12, activeShells: 9, unknown: 1 },
      queue: { pendingCount: 23, steeringCount: 2, inFlightSteeringCount: 0 },
      mcp: { pendingConnectionCount: 4 },
    }),
    ask: null, planRequest: { requestId: 'sidebar-plan', summary: 'Synthetic plan' },
  }, {
    ...template, sessionId: 'demo-roles', lastActivity: now - 7_200_000,
    title: 'Many long roles', cwd: `/workspace/${'role-heavy-directory-'.repeat(3)}`,
    status: 'running' as const, error: null,
    roles: [...longRoles, ...roles], appliedRoles: [...longRoles, roles[0]],
    activity: activityFixture({ hasActiveWork: true, tasks: { activeAgents: 3, activeShells: 0, unknown: 0 } }),
  }, {
    ...template, sessionId: 'demo-plain', lastActivity: now - 200_000_000,
    title: 'Plain', cwd: '/workspace/plain', status: 'idle' as const, error: null,
    roles: [], appliedRoles: [], activity: activityFixture(),
  }];
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
