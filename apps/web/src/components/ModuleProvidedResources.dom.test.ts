import { render, screen, userEvent, waitFor, within } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ModuleRoleResources } from '@cockpit/protocol';
import { ManageWorkspace } from './ManageWorkspace';
import { SessionMcp, SessionSkills } from './Manage';
import { useCockpit } from '../net/store';
import { cockpitApi, type CockpitApi } from '../net/api';
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
    { name: 'board-tree', description: 'Everyone reads this.', roles: ['executor', 'owner'] },
    { name: 'board-owner', roles: ['owner'] },
    { name: 'board-native', roles: ['owner'] },
  ],
  mcpServers: [
    { name: 'board', tools: ['*'], roles: ['executor', 'owner'] },
    { name: 'board-review', tools: ['read', 'report'], roles: ['executor'] },
  ],
}, {
  id: 'notes', name: 'Notes', roles: [{ id: 'reviewer', name: 'Reviewer' }],
  skills: [{ name: 'board-owner', roles: ['reviewer'] }], mcpServers: [],
}];

function setup(t: TestContext, api: Partial<CockpitApi>, state: Partial<ReturnType<typeof useCockpit.getState>> = {}) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No backend request expected'));
  const previous = useCockpit.getState();
  const previousApi = { ...cockpitApi };
  useCockpit.setState({ connState: 'open', connectionGeneration: 1, sessions: [session], resourceRevisions: {}, ...state });
  Object.assign(cockpitApi, api);
  t.after(() => { useCockpit.setState(previous, true); Object.assign(cockpitApi, previousApi); });
}

const renderGlobal = (section: 'mcp' | 'skills') => render(createElement(MemoryRouter, { initialEntries: [`/${section}`] },
  createElement(Routes, null, createElement(Route, { path: '/:section/:item?', element: createElement(ManageWorkspace) }))));

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
      { name: 'board-native', enabled: false, modules: [{ id: 'board', name: 'Board' }] },
    ],
    skillsSetGlobal: async name => { toggles.push(name); },
    roleResources: async () => catalog,
  });
  renderGlobal('skills');
  const modules = await screen.findByRole('region', { name: '模块提供' });
  const native = screen.getByRole('region', { name: '全局配置' });
  assert.equal(within(modules).queryAllByRole('switch').length, 0, 'module resources cannot be toggled globally');
  assert.equal(within(modules).queryAllByRole('link').length, 0, 'module rows are not native catalog details');
  assert.match(modules.textContent!, /不能全局关闭/);

  const all = row(modules, 'board-tree');
  assert.equal(all.querySelector('.module-label-name')?.textContent, 'Board');
  assert.equal(all.querySelector('.role-badge-name'), null, 'every role carries it: module name only');
  assert.equal(within(all).getByText('随角色启用').tagName, 'SPAN');
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
  test(`session ${label}: module resources show 随角色启用 while other rows keep working switches`, async t => {
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
      ],
      mcpToggleSession: mutate, skillsToggleSession: mutate,
    });
    const view = render(createElement(Component, { session, onClose() {} }));
    await waitFor(() => assert.ok(view.container.querySelector('[data-resource-name="board"]')));
    const moduleRow = row(view.container, 'board');
    assert.equal(within(moduleRow).queryByRole('switch'), null);
    assert.ok(within(moduleRow).getByText('随角色启用'));
    if (label === 'MCP') {
      assert.match(moduleRow.textContent!, /失败|failed/i);
      assert.match(moduleRow.textContent!, /Connection refused/);
    }
    const plain = row(view.container, 'module_board__lookalike');
    assert.equal(within(plain).queryByText('随角色启用'), null, 'provenance is never guessed from a name prefix');
    await userEvent.setup().click(within(plain).getByRole('switch', { name: '本会话启用 module_board__lookalike' }));
    await waitFor(() => assert.deepEqual(calls, [[session.sessionId, 'module_board__lookalike', false]]));
  });
}
