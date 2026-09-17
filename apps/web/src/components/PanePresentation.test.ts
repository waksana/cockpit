import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { compile } from 'sass';
import { PaneHeader } from './PaneHeader';
import { StateNotice } from './StateNotice';
import { ResourceStatus, PanelPageShell } from './SessionPanelKit';
import { ManagementShell } from './ManagementShell';
import { Icon } from './Icon';

test('shared state presentation distinguishes actual loading, errors, offline and empty', () => {
  const render = (props: Parameters<typeof ResourceStatus>[0]) => renderToStaticMarkup(createElement(ResourceStatus, props));
  const loading = render({ status: '加载中…', pending: true });
  assert.match(loading, /data-kind="loading"/);
  assert.match(loading, /class="ck-icon spinner" data-icon="loading" aria-hidden="true" style="width:16px;height:16px"><svg/);
  assert.match(loading, /role="status"/);
  const failed = render({ status: '加载失败：offline', failed: true });
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /data-icon="loading"/);
  const waiting = render({ status: '等待连接…' });
  assert.match(waiting, /data-kind="info"/);
  assert.doesNotMatch(waiting, /data-icon="loading"/);
  assert.equal(render({ status: null }), '');
  assert.match(renderToStaticMarkup(createElement(StateNotice, { kind: 'empty', placement: 'pane', children: '没有记录' })), /data-placement="pane"/);
});

test('the shared header accepts page-specific controls without owning navigation', () => {
  const html = renderToStaticMarkup(createElement(PaneHeader, {
    title: 'Native title',
    leading: createElement('button', { type: 'button', 'aria-label': '返回' }),
    actions: createElement('button', { type: 'button', 'aria-label': '刷新', disabled: true }),
  }));
  assert.match(html, /class="pane-header"/);
  assert.match(html, /class="pane-header-content">Native title/);
  assert.equal((html.match(/<button /g) ?? []).length, 2);
  assert.match(html, /aria-label="刷新" disabled=""/);
});

test('lazy management and panel loads retain their navigation shell and announced loading', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, {
    children: createElement(ManagementShell, {
      section: 'skills', item: 'skill-one',
      master: createElement(StateNotice, { kind: 'loading', placement: 'pane', children: '加载页面…' }),
      detail: createElement(StateNotice, { kind: 'loading', placement: 'pane', children: '加载页面…' }),
    }),
  }));
  assert.match(html, /全局 Skills/);
  assert.match(html, /skill-one/);
  assert.match(html, /aria-label="返回"/);
  assert.match(html, /aria-label="刷新" disabled=""/);
  assert.equal((html.match(/data-icon="loading"/g) ?? []).length, 2);
  const panel = renderToStaticMarkup(createElement(PanelPageShell, { title: 'Session settings', onClose() {}, loading: true }));
  assert.match(panel, /Session settings/);
  assert.match(panel, /role="status"/);
  assert.match(panel, /data-kind="loading"/);
});

test('activity headers retain one first-line baseline and icon slot across expansion', () => {
  const css = compile(new URL('../styles/components/chat.scss', import.meta.url).pathname).css;
  const header = css.match(/\.activity-head \{([^}]*)\}/)?.[1];
  assert.ok(header);
  for (const declaration of [/align-items: center;/, /height: var\(--chat-row-process\);/, /padding: 0;/]) {
    assert.match(header, declaration);
  }
  assert.match(css, /\.activity-icon \{[^}]*height: 20px;/);
  const openRules = [...css.matchAll(/([^{}]*\.msg-tool\[data-open=true\][^{}]*)\{([^}]*)\}/g)];
  for (const [, selector, declarations] of openRules) {
    if (/\.activity-(head|icon)/.test(selector)) {
      assert.doesNotMatch(declarations, /(?:^|;)\s*(?:align-items|height|padding(?:-\w+)?):/);
    }
  }
});
test('refresh uses one circular arrow everywhere, with no font glyph or square overlay', () => {
  const html = renderToStaticMarkup(createElement(Icon, { name: 'reload', size: 20 }));
  assert.match(html, /class="ck-icon" data-icon="reload" aria-hidden="true"/);
  assert.match(html, /width:20px;height:20px/);
  assert.match(html, /viewBox="0 0 24 24"/);
  assert.match(html, /stroke="currentColor"/);
  assert.ok((html.match(/<path /g) ?? []).length > 0);
  assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.doesNotMatch(html, /<use|<image|<rect/);
  for (const name of ['search', 'back', 'file'] as const) {
    assert.match(renderToStaticMarkup(createElement(Icon, { name })), /class="ck-icon"[^>]*><svg/);
  }
});
test('resume groups its message and centered action in a single notice; copying preserves value geometry', () => {
  const css = compile(new URL('../styles/components/info-panel.scss', import.meta.url).pathname).css;
  assert.match(css, /\.session-resume \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*align-items: center;[^}]*border: 1px solid/);
  assert.match(css, /\.session-resume-message \{[^}]*margin: 0;/);
  assert.match(css, /\.copy-value-text, \.copy-value-feedback \{[^}]*grid-area: 1\/1;/);
  assert.match(css, /\.copy-value-text\[aria-hidden=true\] \{[^}]*visibility: hidden;/);
  assert.match(css, /\.copy-value-feedback \{[^}]*align-self: center;[^}]*justify-self: center;/);
});

test('session pages share flat density and multiline settings without changing chat exceptions', () => {
  const info = compile(new URL('../styles/components/info-panel.scss', import.meta.url).pathname).css;
  const manage = compile(new URL('../styles/components/manage.scss', import.meta.url).pathname).css;
  const tokens = compile(new URL('../styles/tokens.scss', import.meta.url).pathname).css;
  const publicUi = compile(new URL('../styles/primitives/public-ui.scss', import.meta.url).pathname).css;
  assert.match(info, /\.info-panel-body \{[^}]*padding: var\(--host-space-lg\);[^}]*font-size: var\(--host-text-body\);[^}]*line-height: var\(--host-leading-ui\)/);
  assert.match(manage, /\.manage-body \{[^}]*padding: var\(--host-space-lg\);[^}]*font-size: var\(--host-text-body\)/);
  assert.match(tokens, /--host-space-lg: 16px;[^}]*--host-space-xl: 24px;/);
  assert.match(tokens, /--host-text-title: var\(--font-size-16\);[^}]*--host-text-body: var\(--font-size-14\);[^}]*--host-text-meta: var\(--font-size-12\)/);
  assert.match(publicUi, /--ck-radius: var\(--host-radius-control\)/);
  assert.match(manage, /\.manage-row \{[^}]*background: transparent;[^}]*border-radius: 0;[^}]*border-bottom: 1px solid/);
  assert.match(manage, /\.manage-session-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  assert.match(manage, /\.manage-row-status \{[^}]*min-height: calc/);
  assert.match(manage, /\.manage-session-row\[data-mcp\] > \.manage-row-source \{[^}]*grid-column: 1;[^}]*grid-row: 2;/);
  assert.match(manage, /\.manage-session-row\[data-mcp\] > \.manage-row-status \{[^}]*grid-column: 2;[^}]*grid-row: 2;[^}]*justify-content: flex-end;/);
  assert.match(manage, /\.manage-session-row \.manage-row-main:empty \{[^}]*display: none;/);
  assert.match(info, /\.info-session-id-value \{[^}]*overflow-wrap: anywhere;[^}]*user-select: text;/);
  assert.doesNotMatch(info.match(/\.info-session-id-value \{([^}]*)\}/)![1], /ellipsis|hidden|sticky|line-clamp/);
  assert.match(info, /\.info-control \{[^}]*flex-direction: column;/);
  assert.match(info, /\.info-select \{[^}]*width: 100%;/);
  assert.match(info, /\.panel-expandable-text \{[^}]*-webkit-line-clamp: 2;/);
});
