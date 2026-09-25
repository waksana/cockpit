import { act, render, screen, userEvent, waitFor, within } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import type { ModuleRoleResources } from '@cockpit/protocol';
import { ManageWorkspace } from './ManageWorkspace';
import { SessionMcp, SessionSkills } from './Manage';
import { useCockpit } from '../net/store';
import { cockpitApi, type CockpitApi } from '../net/api';
import { IntentHttpError } from '../net/client';
import type { ChatSession } from '../net/types';

const session: ChatSession = {
  sessionId: 'module-resources', title: 'Module resources', cwd: '/fixture', loaded: true, status: 'idle',
  error: null, queue: [], ask: null, lastActivity: 0, messages: [],
  materialized: true, historyStale: false, hasMore: false, loadingHistory: false,
};

const catalog: ModuleRoleResources[] = [{
  id: 'board', name: 'Board',
  roles: [{ id: 'executor', name: 'Executor' }, { id: 'owner', name: 'Owner' }],
  skills: [
    { id: 'board-tree-id', name: 'board-tree', description: 'Everyone reads this.', roles: ['executor', 'owner'] },
    { id: 'board-owner-id', name: 'board-owner', roles: ['owner'] },
    { id: 'board-native-id', name: 'board-native', roles: ['owner'] },
  ],
  mcpServers: [
    { name: 'board', tools: ['*'], roles: ['executor', 'owner'] },
    { name: 'board-review', tools: ['read', 'report'], roles: ['executor'] },
  ],
}, {
  id: 'notes', name: 'Notes', roles: [{ id: 'reviewer', name: 'Reviewer' }],
  skills: [{ id: 'notes-owner-id', name: 'board-owner', roles: ['reviewer'] }], mcpServers: [],
}];

function setup(t: TestContext, api: Partial<CockpitApi>, state: Partial<ReturnType<typeof useCockpit.getState>> = {}) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No backend request expected'));
  const previous = useCockpit.getState();
  const previousApi = { ...cockpitApi };
  useCockpit.setState({ connState: 'open', connectionGeneration: 1, sessions: [session], resourceRevisions: {}, ...state });
  Object.assign(cockpitApi, api);
  t.after(() => { useCockpit.setState(previous, true); Object.assign(cockpitApi, previousApi); });
}

const renderGlobal = (section: 'mcp' | 'skills', path = `/${section}`) =>
  render(createElement(MemoryRouter, { initialEntries: [path] },
    createElement(Routes, null,
      createElement(Route, { path: '/skills/module/:moduleId/:resourceId', element: createElement(ManageWorkspace) }),
      createElement(Route, { path: '/:section/:item?', element: createElement(ManageWorkspace) }))));

const row = (scope: HTMLElement, name: string) => {
  const rows = scope.querySelectorAll<HTMLElement>(`[data-resource-name="${name}"]`);
  assert.equal(rows.length, 1, `${name} has one row in this group`);
  return rows[0];
};

test('global Skills page groups module-provided skills read-only with derived module · role labels', async t => {
  const toggles: string[] = [];
  setup(t, {
    skillsGlobal: async () => [
      { name: 'native-skill', enabled: true, description: 'native' },
      { name: 'board-native', enabled: false,
        modules: [{ id: 'board', name: 'Board', resourceId: 'board-native-id' }] },
    ],
    skillsSetGlobal: async name => { toggles.push(name); },
    roleResources: async () => catalog,
  });
  renderGlobal('skills');
  const modules = await screen.findByRole('region', { name: '模块提供' });
  const native = screen.getByRole('region', { name: '全局配置' });
  assert.equal(within(modules).queryAllByRole('switch').length, 0, 'module resources cannot be toggled globally');
  assert.equal(within(modules).queryAllByRole('link').length, 3, 'each non-deduplicated module Skill has a detail link');
  assert.doesNotMatch(modules.textContent!, /不能全局关闭|随角色启用|只读|由模块管理/);
  assert.equal(modules.querySelector('.manage-resource-controls'), null, 'no placeholder replaces the absent switch');

  const all = row(modules, 'board-tree');
  assert.equal(all.querySelector('.module-label-name')?.textContent, 'Board');
  assert.equal(all.querySelector('.role-badge-name'), null, 'every role carries it: module name only');
  assert.match(all.textContent!, /Everyone reads this\./);

  const [partial, other] = Array.from(modules.querySelectorAll<HTMLElement>('[data-resource-name="board-owner"]'));
  assert.equal(partial.querySelector('.module-label-name')?.textContent, 'Board');
  assert.equal(partial.querySelector('.role-badge-name')?.textContent, 'Owner');
  assert.equal(other.querySelector('.module-label-name')?.textContent, 'Notes', 'same name from another module stays separate');
  assert.equal(other.querySelector('.role-badge-name'), null, 'single-role module shows its name only');

  assert.equal(modules.querySelector('[data-resource-name="board-native"]'), null,
    'a verified native global entry of the same module is not repeated');
  const nativeRow = row(native, 'board-native');
  await userEvent.setup().click(within(nativeRow).getByRole('switch', { name: '全局默认启用 board-native' }));
  await waitFor(() => assert.deepEqual(toggles, ['board-native']));
  assert.ok(within(row(native, 'native-skill')).getByRole('switch'));
});

test('module Skill opens its verified Markdown detail directly and from the list without native discovery', async t => {
  const reads: Array<[string, string]> = [];
  setup(t, {
    skillsGlobal: async () => [{ name: 'board-native', enabled: false,
      modules: [{ id: 'board', name: 'Board', resourceId: 'board-native-id' }] }],
    roleResources: async () => catalog,
    roleSkillRead: async (moduleId, resourceId) => {
      reads.push([moduleId, resourceId]);
      return {
        id: resourceId, name: 'board-tree', description: 'Everyone reads this.',
        body: '---\nname: board-tree\ndescription: Everyone reads this.\n---\n# Board Tree\n\nVerified body.',
        module: { id: 'board', name: 'Board' },
      };
    },
  });
  const direct = renderGlobal('skills', '/skills/module/board/board-tree-id');
  assert.ok(await screen.findByRole('heading', { name: 'Board Tree' }));
  assert.match(direct.container.textContent!, /Everyone reads this\..*Verified body\./s);
  assert.equal(direct.container.textContent!.match(/Everyone reads this\./g)?.length, 2,
    'one list summary and one detail description; frontmatter is not rendered');
  assert.deepEqual(reads, [['board', 'board-tree-id']]);
  assert.match(direct.container.querySelector('.manage-detail-meta')?.textContent ?? '', /Board/);
  direct.unmount();

  const list = renderGlobal('skills');
  const modules = await screen.findByRole('region', { name: '模块提供' });
  await userEvent.setup().click(within(row(modules, 'board-tree')).getByRole('link'));
  assert.ok(await screen.findByRole('heading', { name: 'Board Tree' }));
  assert.match(list.container.textContent!, /Verified body/);
  assert.deepEqual(reads, [['board', 'board-tree-id'], ['board', 'board-tree-id']]);
});

test('module Skill detail participates in list → detail back and forward history', async t => {
  setup(t, {
    skillsGlobal: async () => [],
    roleResources: async () => catalog,
    roleSkillRead: async (moduleId, resourceId) => ({
      id: resourceId, name: 'board-tree', body: '# History body',
      module: { id: moduleId, name: 'Board' },
    }),
  });
  const router = createMemoryRouter([
    { path: '/skills', element: createElement(ManageWorkspace) },
    { path: '/skills/module/:moduleId/:resourceId', element: createElement(ManageWorkspace) },
  ], { initialEntries: ['/skills'] });
  render(createElement(RouterProvider, { router }));
  const modules = await screen.findByRole('region', { name: '模块提供' });
  await userEvent.setup().click(within(row(modules, 'board-tree')).getByRole('link'));
  assert.ok(await screen.findByRole('heading', { name: 'History body' }));
  await act(() => router.navigate(-1));
  assert.ok(await screen.findByText('选择左侧的一项查看详情。'));
  await act(() => router.navigate(1));
  assert.ok(await screen.findByRole('heading', { name: 'History body' }));
});

test('verified native/module dedupe keeps the native Skill detail authoritative', async t => {
  let moduleReads = 0;
  setup(t, {
    skillsGlobal: async () => [
      { name: 'board-native', enabled: false,
        modules: [{ id: 'board', name: 'Board', resourceId: 'board-native-id' }] },
    ],
    skillsRead: async name => ({ name, enabled: false, body: '# Native authoritative body',
      modules: [{ id: 'board', name: 'Board', resourceId: 'board-native-id' }] }),
    roleResources: async () => catalog,
    roleSkillRead: async () => {
      moduleReads++;
      throw new Error('deduplicated module detail must not be selected');
    },
  });
  const view = renderGlobal('skills');
  const native = await screen.findByRole('region', { name: '全局配置' });
  assert.equal(screen.getByRole('region', { name: '模块提供' })
    .querySelector('[data-resource-name="board-native"]'), null);
  await userEvent.setup().click(within(row(native, 'board-native')).getByRole('link'));
  assert.ok(await screen.findByRole('heading', { name: 'Native authoritative body' }));
  assert.equal(moduleReads, 0);
  assert.match(view.container.querySelector('.manage-detail-header')?.textContent ?? '', /Board.*board-native/);
});

test('module Skill not-found and read failures replace retained body with distinct local states', async t => {
  let outcome: 'ok' | 'missing' | 'failed' = 'ok';
  setup(t, {
    skillsGlobal: async () => [],
    roleResources: async () => catalog,
    roleSkillRead: async (_moduleId, resourceId) => {
      if (outcome === 'missing') throw new IntentHttpError('stale module Skill', 404, 'MODULE_SKILL_NOT_FOUND');
      if (outcome === 'failed') throw new Error('integrity check failed');
      return { id: resourceId, name: 'board-tree', body: '# Earlier body', module: { id: 'board', name: 'Board' } };
    },
  });
  const view = renderGlobal('skills', '/skills/module/board/board-tree-id');
  assert.ok(await screen.findByRole('heading', { name: 'Earlier body' }));

  outcome = 'missing';
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }));
  assert.ok(await screen.findByText('未找到该模块 Skill，模块可能已停用或更新。'));
  assert.doesNotMatch(view.container.textContent!, /Earlier body/);

  outcome = 'failed';
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }));
  assert.ok(await screen.findByText(/加载失败：integrity check failed/));
  assert.doesNotMatch(view.container.textContent!, /Earlier body|未找到该模块 Skill/);
});

test('module Skill empty file and frontmatter-only body have distinct detail states', async t => {
  let body = '';
  setup(t, {
    skillsGlobal: async () => [],
    roleResources: async () => catalog,
    roleSkillRead: async (_moduleId, resourceId) =>
      ({ id: resourceId, name: 'board-tree', body, module: { id: 'board', name: 'Board' } }),
  });
  const view = renderGlobal('skills', '/skills/module/board/board-tree-id');
  assert.ok(await screen.findByText('没有 SKILL.md 内容'));
  body = '---\nname: board-tree\n---\n';
  await userEvent.setup().click(screen.getByRole('button', { name: '刷新' }));
  assert.ok(await screen.findByText('SKILL.md 没有正文'));
  assert.doesNotMatch(view.container.textContent!, /name: board-tree/);
});

test('global MCP page lists module servers with tool subsets and keeps native toggles unchanged', async t => {
  setup(t, {
    mcpGlobal: async () => [{ name: 'native', detail: 'native', defaultOn: true }],
    roleResources: async () => catalog,
  });
  renderGlobal('mcp');
  const modules = await screen.findByRole('region', { name: '模块提供' });
  assert.match(row(modules, 'board').textContent!, /全部工具/);
  const review = row(modules, 'board-review');
  assert.match(review.textContent!, /工具：read、report/);
  assert.equal(review.querySelector('.role-badge-name')?.textContent, 'Executor');
  assert.equal(within(modules).queryAllByRole('switch').length, 0);
  assert.equal(modules.querySelector('.manage-resource-controls'), null);
  assert.doesNotMatch(modules.textContent!, /不能全局关闭|随角色启用|只读|由模块管理/);
  assert.ok(within(screen.getByRole('region', { name: '全局配置' })).getByRole('switch', { name: '全局默认启用 native' }));
});

test('global pages without module resources keep the original ungrouped list', async t => {
  setup(t, {
    mcpGlobal: async () => [{ name: 'native', detail: 'native', defaultOn: true }],
    roleResources: async () => [{ id: 'empty', name: 'Empty', roles: [{ id: 'r', name: 'R' }], skills: [], mcpServers: [] }],
  });
  renderGlobal('mcp');
  await screen.findByRole('switch', { name: '全局默认启用 native' });
  assert.equal(screen.queryByRole('region', { name: '模块提供' }), null);
  assert.equal(screen.queryByRole('region', { name: '全局配置' }), null);
});

test('a failed module catalog stays visible without hiding native resources', async t => {
  setup(t, {
    skillsGlobal: async () => [],
    roleResources: async () => { throw new Error('module catalog unavailable'); },
  });
  renderGlobal('skills');
  const modules = await screen.findByRole('region', { name: '模块提供' });
  await waitFor(() => assert.match(modules.textContent!, /加载失败：module catalog unavailable/));
  assert.match(screen.getByRole('region', { name: '全局配置' }).textContent!, /没有可用的 skill/);
});

for (const [label, Component] of [['MCP', SessionMcp], ['Skills', SessionSkills]] as const) {
  test(`session ${label}: module resources omit slogans while other rows keep working switches`, async t => {
    const calls: Array<[string, string, boolean]> = [];
    const module = { id: 'board', name: 'Board', roles: [{ id: 'owner', name: 'Owner' }] };
    const mutate = async (id: string, name: string, enabled: boolean) => { calls.push([id, name, enabled]); };
    setup(t, {}, {
      mcpSession: async () => [
        { name: 'board', module, detail: 'native', enabled: true, status: 'failed', error: 'Connection refused' },
        { name: 'module_board__lookalike', detail: 'native', enabled: true, status: 'connected' },
      ],
      skillsSession: async () => [
        { name: 'board', module, enabled: true },
        { name: 'module_board__lookalike', enabled: true },
        { name: 'board-off', module, enabled: false },
      ],
      mcpToggleSession: mutate, skillsToggleSession: mutate,
    });
    const view = render(createElement(Component, { session, onClose() {} }));
    await waitFor(() => assert.ok(view.container.querySelector('[data-resource-name="board"]')));
    const moduleRow = row(view.container, 'board');
    assert.equal(within(moduleRow).queryByRole('switch'), null);
    assert.doesNotMatch(moduleRow.textContent!, /随角色启用|只读|由模块管理/);
    if (label === 'MCP') {
      assert.match(moduleRow.textContent!, /失败|failed/i);
      assert.match(moduleRow.textContent!, /Connection refused/);
    }
    if (label === 'Skills') {
      assert.equal(within(moduleRow).queryByText('本会话已停用'), null);
      const off = row(view.container, 'board-off');
      assert.equal(within(off).queryByRole('switch'), null);
      assert.ok(within(off).getByText('本会话已停用'), 'a natively disabled module Skill does not read as enabled');
    }
    const plain = row(view.container, 'module_board__lookalike');
    assert.equal(within(plain).queryByText('随角色启用'), null, 'provenance is never guessed from a name prefix');
    await userEvent.setup().click(within(plain).getByRole('switch', { name: '本会话启用 module_board__lookalike' }));
    await waitFor(() => assert.deepEqual(calls, [[session.sessionId, 'module_board__lookalike', false]]));
  });
}
