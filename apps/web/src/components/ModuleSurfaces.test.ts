import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { compile } from 'sass';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { ModuleRuntimeProvider, SessionStatus } from './ModuleComponents';
import { GlobalNavigation } from './GlobalNavigation';
import { ManagementShell } from './ManagementShell';
import { Sidebar } from './Sidebar';
import { fixtureSession } from '../dev/chat-fixtures';
import type { ActivateFrontend } from '@cockpit/module-api';

test('semantic middleware preserves real navigation and management controls without nested buttons or placeholders', async t => {
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
        { id: 'navigation', boundary: 'globalNavigation', wrap: Base => props => createElement(Base, {
          ...props, children: createElement(Fragment, null, props.children,
            createElement('button', { type: 'button' }, 'Fixture navigation')),
        }) },
        { id: 'management', boundary: 'managementHeader', wrap: Base => props => createElement(Base, {
          ...props, actions: createElement(Fragment, null, props.actions,
            createElement('button', { type: 'button' }, `Fixture list: ${props.section}`)),
        }) },
        { id: 'detail', boundary: 'managementDetailHeader', wrap: Base => props => createElement(Base, {
          ...props, actions: createElement(Fragment, null, props.actions,
            createElement('button', { type: 'button' }, `Fixture detail: ${props.item}`)),
        }) },
      ],
    })) satisfies ActivateFrontend }),
  });
  t.after(() => runtime.stop());
  const render = (children: ReactNode) => renderToStaticMarkup(createElement(ModuleRuntimeProvider, {
    runtime, children: createElement(MemoryRouter, null, children),
  }));
  const controls = (html: string, count: number) => {
    assert.equal((html.match(/<button\b/g) ?? []).length, count);
    assert.doesNotMatch(html, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
    assert.doesNotMatch(html, /module-session-badges|module-global-actions|module-management|module-navigation/);
  };
  const session = fixtureSession('ask');
  for (const enhanced of [false, true]) {
    if (enhanced) await runtime.start();
    const sidebar = render(createElement(Sidebar, {
      sessions: [session], activeId: session.sessionId, query: '', snapshotReady: true, connected: true,
      onSelect() {}, getMenuItems: () => [],
    }));
    controls(sidebar, 1);
    assert.match(sidebar, /class="dialog-status" data-tone="waiting">待回答/);
    assert.doesNotMatch(sidebar, />回复中<|>选</);
    if (enhanced) assert.match(sidebar, /待回答<\/span><span data-fixture-session="[^"]+">7<\/span><\/span>/);
    else assert.doesNotMatch(sidebar, /data-fixture-session/);
    const navigation = render(createElement(GlobalNavigation));
    controls(navigation, enhanced ? 2 : 1);
    assert.match(navigation, /<button[^>]*aria-label="全局导航"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
    if (enhanced) assert.match(navigation, /<\/button><button type="button">Fixture navigation<\/button>/);
    else assert.doesNotMatch(navigation, /Fixture navigation/);
    for (const section of ['mcp', 'skills'] as const) {
      const title = section === 'mcp' ? '全局 MCP' : '全局 Skills';
      const refresh = section === 'mcp' ? '刷新 Copilot MCP 配置缓存' : '刷新';
      const management = render(createElement(ManagementShell, {
        section, item: null, master: null, detail: null,
      }));
      controls(management, enhanced ? 3 : 2);
      assert.match(management, /<button[^>]*aria-label="返回会话列表"/);
      assert.match(management, new RegExp(`<span class="manage-title ck-text-primary">${title}</span>`));
      assert.match(management, new RegExp(`<button[^>]*aria-label="${refresh}"[^>]*disabled=""`));
      if (enhanced) assert.match(management, new RegExp(`</div><button type="button">Fixture list: ${section}</button><button`));
      else assert.doesNotMatch(management, /Fixture list:/);

      const detail = render(createElement(ManagementShell, {
        section, item: 'fixture-resource', master: null, detail: null,
      }));
      controls(detail, enhanced ? 5 : 3);
      assert.match(detail, new RegExp(`<button[^>]*aria-label="返回${title}列表"`));
      assert.match(detail, /<button[^>]*class="chat-back ck-icon-button rp lg:hidden"[^>]*aria-label="返回"/);
      assert.match(detail, /<span tabindex="-1" class="manage-title manage-detail-headtitle">fixture-resource<\/span>/);
      if (enhanced) assert.match(detail, /<\/div><button type="button">Fixture detail: fixture-resource<\/button><\/header>/);
      else assert.doesNotMatch(detail, /Fixture detail:/);
      assert.doesNotMatch(detail, /<div class="lg:hidden"/);
    }
  }
});

test('session native status is singular and module badges remain at the far end of the status row', () => {
  for (const [status, needsDecision, expected] of [
    ['running', true, '待回答'], ['idle', true, '待回答'], ['unloaded', true, '待回答'],
    ['running', false, '回复中'], ['error', true, '出错'], ['error', false, '出错'],
  ] as const) {
    const html = renderToStaticMarkup(createElement(SessionStatus, {
      sessionId: 'fixture', status, needsDecision,
      children: createElement('span', { 'data-unread': true }, '1'),
    }));
    assert.match(html, new RegExp(`>${expected}</span><span data-unread="true">1</span></span>$`));
    assert.equal((html.match(/class="dialog-status"/g) ?? []).length, 1);
    assert.doesNotMatch(html, />选</);
  }
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
