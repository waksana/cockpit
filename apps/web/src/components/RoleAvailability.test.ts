import { act, render, screen, userEvent, waitFor } from '../test/dom';
import assert from '../test/identityAssert';
import { test, type TestContext } from 'node:test';
import { createElement, useState } from 'react';
import { roleAvailability, roleCompatibilityReasons, type RoleAvailability, type RoleAvailabilityQuery, type RoleCatalogEntry, type RoleSelection } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { cockpitApi } from '../net/api';
import { useRoleAvailability } from '../features/session-settings/useRoleAvailability';
import { RolePicker } from './RolePicker';
import { DirPicker } from './DirPicker';

const catalog: RoleCatalogEntry[] = [
  { moduleId: 'fixture', moduleName: 'Fixture', roleId: 'assistant', name: 'Assistant', resourcePolicy: 'exclusive', capabilities: ['instructions'] },
  { moduleId: 'fixture', moduleName: 'Fixture', roleId: 'node', name: 'Node', capabilities: ['instructions', 'skills', 'mcp'] },
  { moduleId: 'service', moduleName: 'Service', roleId: 'binding', name: 'Binding', capabilities: [] },
];
function setup(t: TestContext) {
  const state = useCockpit.getState();
  useCockpit.setState({ connState: 'open', connectionGeneration: 1, snapshotReady: true });
  t.after(() => useCockpit.setState(state, true));
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Synthetic roles must not contact a backend'));
}

test('picker exposes every denial and unknown cause, keeps neutral bindings selectable, and explicitly requeries', async t => {
  setup(t);
  let failed = false;
  let queries = 0;
  t.mock.method(cockpitApi, 'roleAvailability', async (query: RoleAvailabilityQuery) => {
    queries++;
    if (failed && query.roles.some(role => role.roleId === 'node')) throw new Error('Network error');
    return roleAvailability(query.roles, roleCompatibilityReasons(query.roles, catalog), query.sessionId);
  });
  function Harness() {
    const [selected, setSelected] = useState<RoleSelection[]>([]);
    const availability = useRoleAvailability(catalog, selected, true);
    return createElement(RolePicker, { roles: catalog, selected, disabled: false, onChange: setSelected, availability });
  }
  render(createElement(Harness));
  const assistant = screen.getByRole('checkbox', { name: /Assistant/ }) as HTMLInputElement;
  const node = screen.getByRole('checkbox', { name: /Node/ }) as HTMLInputElement;
  const binding = screen.getByRole('checkbox', { name: /Binding/ }) as HTMLInputElement;
  await waitFor(() => assert.equal(assistant.disabled, false));
  await userEvent.click(assistant);
  await waitFor(() => assert.equal(binding.disabled, false));
  assert.equal(node.disabled, true);
  assert.match(node.parentElement!.textContent!, /fixture\/assistant.*fixture\/node.*instructions, skills, mcp/);
  await userEvent.click(binding);
  assert.equal(binding.checked, true);
  failed = true;
  const before = queries;
  await userEvent.click(screen.getByRole('button', { name: '重新查询可选角色' }));
  await screen.findByText(/查询失败，模块可用性未确认/);
  assert.ok(queries > before);
  assert.match(node.parentElement!.textContent!, /conflicts with/);
  assert.equal(node.disabled, true);
  await userEvent.click(assistant);
  assert.equal(assistant.checked, false, 'selected roles can always be deselected to repair conflicts');
});

test('late query results never replace changed selections or target sessions', async t => {
  setup(t);
  const pending: Array<{ roles: RoleSelection[]; sessionId?: string; signal?: AbortSignal; resolve: (value: RoleAvailability) => void }> = [];
  t.mock.method(cockpitApi, 'roleAvailability', (query: RoleAvailabilityQuery, signal?: AbortSignal) =>
    new Promise<RoleAvailability>(resolve => pending.push({ ...query, signal, resolve })));
  function Harness({ sessionId, selected }: { sessionId: string; selected: RoleSelection[] }) {
    const resource = useRoleAvailability(catalog, selected, true, sessionId);
    return createElement('span', { 'data-testid': 'status' }, resource.valid ? resource.data?.selection.status : 'pending');
  }
  const view = render(createElement(Harness, { sessionId: 'first', selected: [catalog[0]!] }));
  await waitFor(() => assert.equal(pending.length, 3));
  view.rerender(createElement(Harness, { sessionId: 'second', selected: [catalog[1]!] }));
  await waitFor(() => assert.equal(pending.length, 6));
  assert.ok(pending.slice(0, 3).every(query => query.signal?.aborted));
  await act(async () => {
    for (const query of pending.slice(3)) query.resolve(roleAvailability(query.roles, [{
      code: 'OCCUPIED', message: 'Second target denied', status: 'denied',
      source: { kind: 'module', moduleId: 'fixture' }, roles: [], capabilities: [],
    }], 'second'));
  });
  assert.equal(screen.getByTestId('status').textContent, 'unavailable');
  await act(async () => {
    for (const query of pending.slice(0, 3)) query.resolve(roleAvailability(query.roles, [], 'first'));
  });
  assert.equal(screen.getByTestId('status').textContent, 'unavailable');
});

test('new-session dialog gates creation on selection checks and sends the exact neutral plus exclusive selection', async t => {
  setup(t);
  t.mock.method(cockpitApi, 'listRoles', async () => catalog);
  t.mock.method(cockpitApi, 'listDir', async () => ({ path: '/synthetic', parent: null, entries: [] }));
  t.mock.method(cockpitApi, 'roleAvailability', async (query: RoleAvailabilityQuery) =>
    roleAvailability(query.roles, roleCompatibilityReasons(query.roles, catalog)));
  const creations: RoleSelection[][] = [];
  render(createElement(DirPicker, { onCancel: () => {}, onCreated: () => {}, onCreate: async (_cwd, roles) => {
    creations.push(roles ?? []); return 'created';
  } }));
  const assistant = await screen.findByRole('checkbox', { name: /Assistant/ });
  await waitFor(() => assert.equal((assistant as HTMLInputElement).disabled, false));
  await userEvent.click(assistant);
  const binding = screen.getByRole('checkbox', { name: /Binding/ });
  await waitFor(() => assert.equal((binding as HTMLInputElement).disabled, false));
  await userEvent.click(binding);
  const create = screen.getByRole('button', { name: '创建会话' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(create.disabled, false));
  await userEvent.click(create);
  assert.deepEqual(creations, [[
    { moduleId: 'fixture', roleId: 'assistant' }, { moduleId: 'service', roleId: 'binding' },
  ]]);
});
