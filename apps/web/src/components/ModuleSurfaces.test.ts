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

test('session badges are noninteractive row metadata and global actions are sibling controls across navigation shells', async t => {
  const digest = 'a'.repeat(64);
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'fixture', name: 'Fixture', version: '1.0.0', digest, config: {}, styles: [],
      apiBase: `/_modules/fixture/${digest}/api`, entry: `/_modules/assets/fixture/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate: () => ({
      sessionBadges: [{ id: 'badge', component: ({ sessionId }: { sessionId: string }) =>
        createElement('span', { 'data-fixture-session': sessionId }, '7') }],
      globalActions: [{ id: 'action', component: () => createElement('button', { type: 'button' }, 'Fixture settings') }],
    }) }),
  });
  await runtime.start();
  t.after(() => runtime.stop());
  t.mock.method(moduleRuntime, 'contributions', runtime.contributions.bind(runtime));
  t.mock.method(moduleRuntime, 'subscribe', runtime.subscribe);
  t.mock.method(moduleRuntime, 'getSnapshot', runtime.getSnapshot);
  const session = fixtureSession('ask');
  const sidebar = renderToStaticMarkup(createElement(Sidebar, {
    sessions: [session], activeId: session.sessionId, query: '', snapshotReady: true, connected: true,
    onSelect() {}, getMenuItems: () => [],
  }));
  assert.match(sidebar, /class="dialog-meta"><span class="module-session-badges"><span data-fixture-session="/);
  assert.equal((sidebar.match(/<button\b/g) ?? []).length, 1, 'badge contributes no nested control');
  assert.doesNotMatch(sidebar, /module-session-badges[^>]*(?:tabindex|role="button")/);
  const navigation = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(GlobalNavigation)));
  assert.match(navigation, /<\/button><div class="module-global-actions"><button type="button">Fixture settings<\/button><\/div>/);
  for (const section of ['mcp', 'skills'] as const) {
    const management = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ManagementShell, {
      section, item: null, master: null, detail: null,
    })));
    assert.match(management, /class="module-global-actions"><button type="button">Fixture settings<\/button>/);
  }
  const detail = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ManagementShell, {
    section: 'mcp', item: 'fixture', master: null, detail: null,
  })));
  assert.match(detail, /class="lg:hidden"><div class="module-global-actions">/);
});

test('decoration slots occupy only the existing gutter and do not alter message geometry or scroll ownership', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  const rule = css.match(/\.module-message-decorations \{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /position: absolute/);
  assert.match(rule, /left: -8px/);
  assert.match(rule, /width: 4px/);
  assert.match(rule, /overflow: clip/);
  assert.match(rule, /pointer-events: none/);
  assert.doesNotMatch(rule, /padding|margin|overflow-[xy]: auto/);
  assert.match(css, /\.message-speech,\s*\.chat-answer-question \{\s*position: relative;\s*\}/);
  assert.match(css, /\.chat-pending-body > \.module-message-decorations \{\s*margin: 0;\s*\}/);
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8');
  assert.match(thread, /<MessageContent message=\{m\} elementRef=\{setElement\} \/>/);
  assert.doesNotMatch(thread, /IntersectionObserver|notification|unread|localStorage/);
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.equal((app.match(/observeModuleView\(moduleRuntime, useCockpit, document\)/g) ?? []).length, 1);
});
