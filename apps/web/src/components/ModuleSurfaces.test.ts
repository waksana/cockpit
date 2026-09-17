import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { compile } from 'sass';
import { ModuleRuntime, moduleRuntime } from '../lib/moduleRuntime';
import { GlobalNavigation } from './GlobalNavigation';
import { ManagementShell } from './ManagementShell';
import { Sidebar } from './Sidebar';
import { fixtureSession } from '../dev/chat-fixtures';
import type { ActivateFrontend } from '@cockpit/module-api';

test('session badges are noninteractive row metadata and global actions are sibling controls across navigation shells', async t => {
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'fixture', name: 'Fixture', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/fixture/${digest}/api`, entry: `/_modules/assets/fixture/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate: (() => ({
      apiVersion: 2,
      components: [
        { id: 'badge', boundary: 'sessionStatus', wrap: Base => props => createElement(Base, {
          ...props, children: createElement('span', { 'data-fixture-session': props.sessionId }, '7', props.children),
        }) },
        { id: 'action', boundary: 'globalActions', wrap: Base => props => createElement(Base, {
          ...props, children: createElement('button', { type: 'button' }, 'Fixture settings', props.children),
        }) },
      ],
    })) satisfies ActivateFrontend }),
  });
  await runtime.start();
  t.after(() => runtime.stop());
  t.mock.method(moduleRuntime, 'compose', runtime.compose.bind(runtime));
  t.mock.method(moduleRuntime, 'subscribe', runtime.subscribe);
  t.mock.method(moduleRuntime, 'getSnapshot', runtime.getSnapshot);
  const session = fixtureSession('ask');
  const sidebar = renderToStaticMarkup(createElement(Sidebar, {
    sessions: [session], activeId: session.sessionId, query: '', snapshotReady: true, connected: true,
    onSelect() {}, getMenuItems: () => [],
  }));
  assert.match(sidebar, /class="dialog-meta"><span data-fixture-session="/);
  assert.equal((sidebar.match(/<button\b/g) ?? []).length, 1, 'badge contributes no nested control');
  assert.doesNotMatch(sidebar, /module-session-badges|module-global-actions/);
  assert.match(sidebar, /class="dialog-status" title="需要选择" aria-label="需要选择">选/);
  const navigation = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(GlobalNavigation)));
  assert.match(navigation, /<\/button><button type="button">Fixture settings<\/button>/);
  for (const section of ['mcp', 'skills'] as const) {
    const management = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ManagementShell, {
      section, item: null, master: null, detail: null,
    })));
    assert.match(management, /<button type="button">Fixture settings<\/button>/);
    assert.doesNotMatch(management, /module-global-actions/);
  }
  const detail = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ManagementShell, {
    section: 'mcp', item: 'fixture', master: null, detail: null,
  })));
  assert.match(detail, /<\/div><button type="button">Fixture settings<\/button><\/header>/);
  assert.doesNotMatch(detail, /<div class="lg:hidden"/);
});

test('middleware introduces no contribution-placeholder DOM or CSS and leaves scroll ownership in core', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  assert.doesNotMatch(css, /module-message-decorations|module-composer-actions|module-composer-above/);
  const sidebar = compile(new URL('../styles/components/sidebar.scss', import.meta.url).pathname).css;
  assert.doesNotMatch(sidebar, /module-session-badges|module-global-actions/);
  assert.match(css, /\.message-speech,\s*\.chat-answer-question \{\s*position: relative;\s*\}/);
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8');
  assert.match(thread, /<MessageContent message=\{m\} \/>/);
  assert.doesNotMatch(thread, /IntersectionObserver|notification|unread|localStorage/);
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.equal((app.match(/observeModuleView\(moduleRuntime, useCockpit, document\)/g) ?? []).length, 1);
});
