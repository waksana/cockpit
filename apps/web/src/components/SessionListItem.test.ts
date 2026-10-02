import { act, fireEvent, render, screen, userEvent } from '../test/dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import type { LegacyModuleFrontendContext, ModuleFrontendContext, SessionListItemProps } from '@cockpit/module-api/frontend';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { ModuleRuntimeProvider } from './ModuleComponents';
import { SessionListItemBase } from './PublicComponentBases';
import { Sidebar } from './Sidebar';
import { sidebarSessions } from '../dev/sidebar-fixtures';
import { activate as example } from '../dev/module-session-list-example';

const h = React.createElement;
const digest = 'd'.repeat(64);
const asset = {
  id: 'description', name: 'Description example', version: '1.0.0', digest,
  config: { sessionId: 'demo-roles' }, styles: [],
  apiBase: `/_modules/description/${digest}/api`, entry: `/_modules/assets/description/${digest}/entry.js`,
};

test('real Base omits absent descriptions and preserves its original structure and button attributes', () => {
  const props: SessionListItemProps = {
    sessionId: 'plain', title: 'Session name', time: 'now', details: 'directory', disabled: true,
    className: 'active', tabIndex: 0, 'aria-current': true, 'aria-haspopup': 'menu',
  };
  const view = render(h(SessionListItemBase, props));
  const row = screen.getByRole('button', { name: 'Session name now directory' }) as HTMLButtonElement;
  assert.equal(row.disabled, true);
  assert.equal(row.className, 'chatlist-chat ck-button active');
  assert.equal(row.dataset.sessionId, 'plain');
  assert.equal(row.getAttribute('aria-current'), 'true');
  assert.equal(row.getAttribute('aria-haspopup'), 'menu');
  assert.deepEqual(Array.from(row.children, child => child.className),
    ['session-row-title', 'dialog-time', 'session-row-details']);
  for (const description of [null, false, undefined]) {
    view.rerender(h(SessionListItemBase, { ...props, description }));
    assert.equal(row.querySelector('.session-row-description'), null);
  }
});

for (const version of [2, 3] as const) {
  test(`Web v${version} activation wraps the real row with phrasing content and preserves interactions`, async t => {
    const reports: unknown[] = [];
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: [asset], errors: [] }),
      load: async () => ({
        ...(version === 3 ? { frontendApiVersion: 3 } : {}),
        activate: (context: LegacyModuleFrontendContext | ModuleFrontendContext) => {
          assert.equal(context.sessionListItemVersion, 1);
          if (context.apiVersion === 2) return example(context);
          assert.equal(context.components.get('sessionListItem'), runtime.components.get('sessionListItem'));
          return { apiVersion: 3, components: [{
            id: 'description', boundary: 'sessionListItem',
            wrap: (Base: React.ComponentType<SessionListItemProps>) => (props: SessionListItemProps) =>
              h(Base, { ...props, description: props.sessionId === 'demo-roles'
                ? h('span', { className: 'ck-badge' }, 'Example Synthetic module description') : props.description }),
          }] };
        },
      }),
      report: error => reports.push(error),
    });
    t.after(() => runtime.stop());
    await runtime.start();
    assert.equal(runtime.getSnapshot().length, 1);
    const selected: string[] = [];
    const view = render(h(ModuleRuntimeProvider, { runtime, children: h(Sidebar, {
      sessions: sidebarSessions(), activeId: 'demo-roles', query: '', snapshotReady: true, connected: true,
      onSelect: id => selected.push(id), getMenuItems: () => [{ label: 'Inspect synthetic session', onClick() {} }],
    }) }));
    const row = view.container.querySelector<HTMLButtonElement>('[data-session-id="demo-roles"]')!;
    const description = row.querySelector<HTMLElement>('.session-row-description')!;
    assert.equal(description.tagName, 'SPAN');
    assert.deepEqual(Array.from(row.children, child => child.className),
      ['session-row-title', 'dialog-time', 'session-row-description', 'session-row-details']);
    assert.equal(row.querySelector('.session-row-title')?.textContent, 'Many long roles');
    assert.ok(row.querySelector('.dialog-time')?.textContent);
    assert.equal(row.querySelectorAll('.role-badge').length, 5);
    assert.ok(row.querySelector('.dialog-subtitle')?.textContent);
    assert.ok(row.querySelector('.dialog-meta'));
    assert.equal(row.querySelectorAll('button, a, input, [tabindex]').length, 0);
    assert.ok(screen.getByRole('button', { name: /Many long roles.*Example.*Synthetic module description/ }));
    assert.equal(view.container.querySelector('[data-session-id="demo-plain"] .session-row-description'), null);
    const user = userEvent.setup();
    await user.click(description);
    assert.deepEqual(selected, ['demo-roles']);
    row.focus();
    await user.keyboard('{Enter} ');
    assert.deepEqual(selected, ['demo-roles', 'demo-roles', 'demo-roles']);
    await user.keyboard('{Shift>}{F10}{/Shift}');
    assert.ok(screen.getByRole('menuitem', { name: 'Inspect synthetic session' }));
    await user.keyboard('{Escape}');
    assert.equal(document.activeElement === row, true);
    fireEvent.contextMenu(description, { clientX: 20, clientY: 30 });
    assert.ok(screen.getByRole('menuitem', { name: 'Inspect synthetic session' }));
    await user.keyboard('{Escape}');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    fireEvent.pointerDown(description, { pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 30 });
    await act(() => t.mock.timers.tick(450));
    assert.ok(screen.getByRole('menuitem', { name: 'Inspect synthetic session' }));
    fireEvent.pointerUp(description, { pointerType: 'touch' });
    fireEvent.click(description, { detail: 1 });
    assert.equal(selected.length, 3, 'long-press does not also select');
    t.mock.timers.reset();
    assert.deepEqual(reports, []);
    view.unmount();
  });

  test(`Web v${version} rejects an unsupported session boundary rather than silently registering it`, async () => {
    let disposed = false;
    const reports: unknown[] = [];
    const runtime = new ModuleRuntime({
      pageUrl: 'https://fixture.invalid',
      fetch: async () => Response.json({ modules: [asset], errors: [] }),
      load: async () => ({
        ...(version === 3 ? { frontendApiVersion: 3 } : {}),
        activate: () => ({ apiVersion: version, dispose: () => { disposed = true; },
          components: [{ id: 'bad', boundary: 'sessionListDescription', wrap: (Base: unknown) => Base }] }),
      }),
      report: error => reports.push(error),
    });
    await runtime.start();
    assert.equal(runtime.getSnapshot().length, 0);
    assert.equal(disposed, true);
    assert.match(String(reports[0]), /Invalid component middleware/);
    runtime.stop();
  });
}

test('example explicitly rejects hosts without the session-list capability', () => {
  assert.throws(() => example({ sessionListItemVersion: undefined } as LegacyModuleFrontendContext),
    /requires sessionListItem v1/);
});
