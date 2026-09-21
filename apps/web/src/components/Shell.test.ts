import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DetailPane, MasterPane, Shell } from './Shell';

function render(infoOpen: boolean, mobileDetail: boolean) {
  return renderToStaticMarkup(createElement(Shell, {
    ariaLabel: 'layout', infoOpen,
    children: [
      createElement(MasterPane, {
        key: 'master', ariaLabel: 'list', mobileVisible: !mobileDetail,
        children: createElement('button', null, 'list control'),
      }),
      createElement(DetailPane, {
        key: 'detail', ariaLabel: 'chat', mobileVisible: mobileDetail,
        children: createElement('textarea'),
      }),
    ],
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
  assert.equal(html, render(false, true).replace('data-info-open="false"', 'data-info-open="true"'));
  assert.match(html, /<textarea/);
});
