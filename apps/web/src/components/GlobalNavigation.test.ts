import { render, screen, userEvent, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { parentOf } from '../lib/nav';
import { GlobalNavigation } from './GlobalNavigation';

test('global lists and item deep links have strict hierarchical parents', () => {
  for (const section of ['mcp', 'skills']) {
    assert.equal(parentOf(`/${section}`), '/');
    assert.equal(parentOf(`/${section}/name%2Fpart`), `/${section}`);
    assert.equal(parentOf(`/${section}/name%2Fpart/`), `/${section}`);
  }
  assert.equal(parentOf('/skills/module/fixture/resource-id'), '/skills');
  assert.equal(parentOf('/session/A/info'), '/session/A');
  assert.equal(parentOf('/session/A'), '/');
  assert.equal(parentOf('/files'), '/');
});

function LocationProbe() {
  const location = useLocation();
  return createElement('output', { 'aria-label': 'location' }, location.pathname);
}

function mount(t: TestContext) {
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  t.after(() => {
    if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scroll);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });
  t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function getBoundingClientRect(this: HTMLElement) {
    return this.getAttribute('aria-label') === '全局导航'
      ? { left: 20, right: 60, top: 10, bottom: 42, width: 40, height: 32, x: 20, y: 10, toJSON() {} }
      : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
  });
  const before = document.createElement('input');
  before.setAttribute('aria-label', 'before');
  document.body.append(before);
  t.after(() => { before.remove(); });
  before.focus();
  render(createElement(MemoryRouter, { initialEntries: ['/'] },
    createElement(Routes, null,
      createElement(Route, { path: '*', element: createElement('div', null,
        createElement(GlobalNavigation),
        createElement(LocationProbe)) }))));
  return before;
}

test('global menu exposes only global sections, does not steal focus on mount, and pushes navigation', async t => {
  const before = mount(t);
  assert.equal(document.activeElement, before);
  assert.equal(screen.queryByRole('menu'), null);

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '全局导航' }));
  const menu = await screen.findByRole('menu');
  assert.ok(screen.getByRole('menuitem', { name: /全局 MCP/ }));
  assert.ok(screen.getByRole('menuitem', { name: /全局 Skills/ }));
  for (const removed of ['会话列表', '文件', '通知设置', 'SystemVersions', '垃圾桶', 'trash']) {
    assert.equal(menu.textContent?.includes(removed), false, removed);
  }
  await user.click(screen.getByRole('menuitem', { name: /全局 MCP/ }));
  await waitFor(() => assert.equal(screen.getByLabelText('location').textContent, '/mcp'));

  await user.click(screen.getByRole('button', { name: '全局导航' }));
  await user.click(await screen.findByRole('menuitem', { name: /全局 Skills/ }));
  await waitFor(() => assert.equal(screen.getByLabelText('location').textContent, '/skills'));
});

test('management workspace does not mount the global menu', () => {
  const management = readFileSync(new URL('./ManageWorkspace.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(management, /GlobalNavigation/);
});
