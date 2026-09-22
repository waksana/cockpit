import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import { readFileSync } from 'node:fs';
import { DetailPane, InspectorPane, MasterPane, Shell } from './Shell';
import { PaneBody } from './PaneHeader';
import { INSPECTOR_DOCK_QUERY, MASTER_DOCK_QUERY, PHONE_QUERY } from '../lib/layout';

function render(infoOpen: boolean, mobileDetail: boolean) {
  return renderToStaticMarkup(createElement(Shell, {
    ariaLabel: 'layout',
    master: createElement(MasterPane, {
        ariaLabel: 'list', mobileVisible: !mobileDetail,
        children: createElement('button', null, 'list control'),
      }),
    main: createElement(DetailPane, {
        ariaLabel: 'chat', mobileVisible: mobileDetail,
        children: createElement('textarea'),
      }),
    inspector: infoOpen ? createElement(InspectorPane, { ariaLabel: 'settings', onClose() {}, children: 'settings content' }) : null,
  }));
}

test('mobile hidden panes are inert, not merely positioned off-screen', () => {
  const chat = render(false, true);
  assert.match(chat, /class="master-pane"[^>]*inert=""[^>]*aria-hidden="true"/);
  assert.doesNotMatch(chat, /class="detail-pane"[^>]*inert/);
  const list = render(false, false);
  assert.match(list, /class="detail-pane"[^>]*inert=""[^>]*aria-hidden="true"/);
  assert.doesNotMatch(list, /class="master-pane"[^>]*inert/);
});

test('open details leave modal isolation to the native dialog, retaining hidden-pane inertness', () => {
  const html = render(true, true);
  assert.match(html, /class="master-pane"[^>]*inert=""[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /class="detail-pane"[^>]*(?:inert|aria-hidden)/);
  assert.match(html, /<dialog[^>]*class="inspector-pane host-modal ck-modal"[^>]*aria-label="settings"/);
  assert.doesNotMatch(render(false, true), /<dialog/);
  assert.match(html, /<textarea/);
});

test('optional shell slots do not invent routing, headers or scroll owners', () => {
  const html = renderToStaticMarkup(createElement(Shell, {
    ariaLabel: 'single pane', main: createElement(DetailPane, {
      ariaLabel: 'content', mobileVisible: true, header: createElement('header', null, 'heading'),
      children: createElement('div', { className: 'owned-scroll' }, 'content'),
    }),
  }));
  assert.doesNotMatch(html, /master-pane|inspector-pane|<dialog/);
  assert.match(html, /<\/header><div class="pane-body detail-pane-body" data-scroll="false" data-padded="false"/);
  const body = renderToStaticMarkup(createElement(PaneBody, { children: 'settings' }));
  assert.match(body, /class="pane-body scrollable" data-scroll="true" data-padded="true"/);
});

test('layout breakpoints pair CSS and behavior, with an in-flow docked inspector', () => {
  const css = compile(new URL('../styles/components/shell.scss', import.meta.url).pathname).css;
  for (const query of [PHONE_QUERY, MASTER_DOCK_QUERY, INSPECTOR_DOCK_QUERY]) {
    assert.ok(css.includes(`@media ${query}`), query);
  }
  assert.match(css, /@media \(min-width: 1200px\) \{\s*\.inspector-pane \{\s*position: relative;/);
  assert.match(css, /flex: 0 0 var\(--inspector-width, 24rem\)/);
  assert.doesNotMatch(css, /data-info-open|padding-inline-end: 24rem/);
  const source = readFileSync(new URL('./Shell.tsx', import.meta.url), 'utf8');
  assert.match(source, /useNativeDialog\(frame, !wide\)/);
  assert.match(source, /className="inspector-surface" tabIndex=\{-1\} data-dialog-focus/);
  assert.match(source, /surface.autofocus = true/);
  assert.doesNotMatch(source, /useNavigate|useCockpit|\.focus\(/);
});
