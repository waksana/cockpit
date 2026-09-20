import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModuleLabel, RoleBadge } from './ModuleLabel';
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
  assert.doesNotMatch(html, /data-tone=|role="status"/);
  assert.match(renderToStaticMarkup(createElement(ModuleLabel, { id: 'raw', name: '<module>' })), /&lt;module&gt;/);
});
