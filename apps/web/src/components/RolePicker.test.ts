import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModuleLabel, ModuleSourceBadge, RoleBadge } from './ModuleLabel';
import { RolePicker } from './RolePicker';

const roles = [
  { moduleId: 'cockpit-task', moduleName: 'Task', roleId: 'owner', name: 'Owner', description: 'Coordinate independent tasks.' },
  { moduleId: 'cockpit-task', moduleName: 'Task', roleId: 'executor', name: 'Executor', description: 'Deliver one assigned task.' },
  { moduleId: 'other', moduleName: 'module_Original__Name', roleId: 'owner', name: 'cockpit-Exact-owner' },
];

test('role picker names roles and modules separately, retains multiselection and accessible descriptions', () => {
  const html = renderToStaticMarkup(createElement(RolePicker, {
    roles, selected: [roles[0], roles[2]], disabled: false,
    onChange: () => { throw new Error('Rendering cannot select a role'); },
  }));
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.equal((html.match(/checked=""/g) ?? []).length, 2);
  assert.equal((html.match(/data-selected="true"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-describedby=/g) ?? []).length, 2);
  assert.match(html, /class="module-label-name">module_Original__Name</);
  assert.match(html, />cockpit-Exact-owner</);
  assert.doesNotMatch(html, /style=|readiness|role="switch"/);
});

test('disabled role picker uses native fieldset disabling without dropping selected roles', () => {
  const html = renderToStaticMarkup(createElement(RolePicker, {
    roles, selected: [roles[1]], disabled: true, onChange: () => {},
  }));
  assert.match(html, /<fieldset class="role-picker" disabled=""/);
  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
});

test('module and joined role labels preserve exact names and explain their meaning without status claims', () => {
  const html = renderToStaticMarkup(createElement(RoleBadge, { role: roles[2] }));
  assert.match(html, /class="module-label-name">module_Original__Name</);
  assert.match(html, /class="role-badge-name">cockpit-Exact-owner</);
  assert.match(html, /不代表当前能力就绪/);
  assert.doesNotMatch(html, /data-tone=|role="status"|module-mark|<svg/);
  assert.match(renderToStaticMarkup(createElement(ModuleLabel, { id: 'raw', name: '<module>' })), /&lt;module&gt;/);
});

test('resource badges join only explicit contributors and retain module-only fallback', () => {
  for (const contributors of [undefined, [], [{ id: 'owner', name: 'Owner' }],
    [{ id: 'executor', name: '<Executor>' }, { id: 'owner', name: 'Owner' }]]) {
    const html = renderToStaticMarkup(createElement(ModuleSourceBadge, {
      module: { id: 'task', name: 'Task', roles: contributors }, description: 'Configuration, not live connection identity',
    }));
    assert.match(html, /class="module-label-name">Task</);
    assert.match(html, /Configuration, not live connection identity/);
    assert.doesNotMatch(html, /module-mark|<svg|data-tone=|role="status"/);
    if (!contributors?.length) assert.doesNotMatch(html, /role-badge/);
    else {
      assert.match(html, /class="role-badge"/);
      assert.match(html, /不代表授权、启用或就绪/);
      assert.match(html, contributors.length === 1 ? />Owner</ : />&lt;Executor&gt;、Owner</);
    }
  }
});
