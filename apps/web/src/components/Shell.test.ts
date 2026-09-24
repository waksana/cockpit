import { render, screen, waitFor } from '../test/dom';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import { DetailPane, InspectorPane, MasterPane, Shell } from './Shell';
import { PaneBody } from './PaneHeader';
import { INSPECTOR_DOCK_QUERY, MASTER_DOCK_QUERY, PHONE_QUERY } from '../lib/layout';

function renderShellMarkup(infoOpen: boolean, mobileDetail: boolean) {
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
  const chat = renderShellMarkup(false, true);
  assert.match(chat, /class="master-pane"[^>]*inert=""[^>]*aria-hidden="true"/);
  assert.doesNotMatch(chat, /class="detail-pane"[^>]*inert/);
  const list = renderShellMarkup(false, false);
  assert.match(list, /class="detail-pane"[^>]*inert=""[^>]*aria-hidden="true"/);
  assert.doesNotMatch(list, /class="master-pane"[^>]*inert/);
});

test('open details leave modal isolation to the native dialog, retaining hidden-pane inertness', () => {
  const html = renderShellMarkup(true, true);
  assert.match(html, /class="master-pane"[^>]*inert=""[^>]*aria-hidden="true"/);
  assert.doesNotMatch(html, /class="detail-pane"[^>]*(?:inert|aria-hidden)/);
  assert.match(html, /<dialog[^>]*class="inspector-pane host-modal ck-modal"[^>]*aria-label="settings"/);
  assert.doesNotMatch(renderShellMarkup(false, true), /<dialog/);
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

function stubMedia(t: TestContext, wide: boolean) {
  t.mock.method(window, 'matchMedia', (query: string) => ({
    matches: query === INSPECTOR_DOCK_QUERY ? wide : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  } satisfies MediaQueryList));
}

function stubDialog(t: TestContext) {
  const calls = { showModal: 0, close: 0 };
  const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) {
    calls.showModal++;
    this.open = true;
  } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) {
    calls.close++;
    this.open = false;
  } });
  t.after(() => {
    if (showModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    if (close) Object.defineProperty(HTMLDialogElement.prototype, 'close', close);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  });
  return calls;
}

test('layout breakpoints pair CSS and behavior, with an in-flow docked inspector', () => {
  const css = compile(new URL('../styles/components/shell.scss', import.meta.url).pathname).css;
  for (const query of [PHONE_QUERY, MASTER_DOCK_QUERY, INSPECTOR_DOCK_QUERY]) {
    assert.ok(css.includes(`@media ${query}`), query);
  }
  assert.match(css, /@media \(min-width: 1200px\) \{\s*\.inspector-pane \{\s*position: relative;/);
  assert.match(css, /flex: 0 0 var\(--inspector-width, 24rem\)/);
  assert.doesNotMatch(css, /data-info-open|padding-inline-end: 24rem/);
});

for (const wide of [false, true]) {
  test(`inspector uses ${wide ? 'docked' : 'modal'} native dialog behavior without moving focus`, async t => {
    stubMedia(t, wide);
    const calls = stubDialog(t);
    const before = document.createElement('button');
    before.textContent = 'before';
    document.body.append(before);
    t.after(() => before.remove());
    before.focus();
    render(createElement(InspectorPane, { ariaLabel: 'settings', onClose() {}, children: 'settings content' }));
    await waitFor(() => assert.equal(screen.getByRole('dialog', { name: 'settings' }).hasAttribute('open'), true));
    const dialog = screen.getByRole('dialog', { name: 'settings' }) as HTMLDialogElement;
    const surface = dialog.querySelector<HTMLElement>('.inspector-surface');
    assert.ok(surface);
    assert.equal(surface.tabIndex, -1);
    assert.equal(surface.getAttribute('data-dialog-focus'), 'true');
    assert.equal((surface as HTMLElement & { autofocus?: boolean }).autofocus, true);
    assert.equal(calls.showModal, wide ? 0 : 1);
    assert.equal(document.activeElement, before);
  });
}
