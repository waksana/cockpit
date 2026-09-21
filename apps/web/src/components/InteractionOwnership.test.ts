import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dialog, DirectoryModal } from './Dialog';
import { MenuItemButton } from './ContextMenu';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { useCockpit } from '../net/store';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('session absence is gated by the applied snapshot rather than the open transport', () => {
  const app = source('../App.tsx');
  assert.match(app, /snapshotReady: s.snapshotReady/);
  assert.match(app, /const notFound = !active && routeId != null && snapshotReady/);
  assert.doesNotMatch(app, /const notFound = [^;]*connState === 'open'/);
});

test('a deep link shows synchronization before the snapshot and absence only after it', () => {
  const state = useCockpit.getInitialState();
  const previous = { ...state };
  try {
    Object.assign(state, { connState: 'open', sessions: [], snapshotReady: false });
    const render = () => renderToStaticMarkup(createElement(MemoryRouter, {
      initialEntries: ['/session/synthetic-waiting'], children: createElement(App),
    }));
    assert.match(render(), /data-kind="loading" data-placement="pane" role="status"/);
    assert.match(render(), /正在同步会话/);
    assert.doesNotMatch(render(), /这个会话不存在|或已被删除/);
    state.snapshotReady = true;
    assert.match(render(), /这个会话不存在,或已被删除/);
    assert.doesNotMatch(render(), /正在同步会话/);
  } finally { Object.assign(state, previous); }
});

test('creation has one native action owner and no first-message or virtual identity path', () => {
  const app = source('../App.tsx');
  const picker = source('./DirPicker.tsx');
  assert.match(app, /<DirPicker key=\{location.key\} onCreate=\{newSession\} onCreated=\{selectSession\}/);
  assert.match(app, /<DirectoryModal onCancel=/);
  assert.match(picker, /sessionId = await onCreate\(path, selectedRoles/);
  assert.ok(picker.indexOf('onCreated(sessionId)') > picker.indexOf('await onCreate(path,'));
  assert.match(picker, /const locked = submitted \|\| action.busy/);
  assert.match(picker, /<DirectoryModal busy=\{action.busy\} onCancel=\{onCancel\}/);
  assert.doesNotMatch(picker, /checkAvailability|moduleIntent|ModuleSelection/);
  assert.doesNotMatch(app + picker, /sessionStart|<Composer|creation\.draft|onStart|session\/start/);
});

test('directory modal delegates isolation to the browser and starts outside the path input', () => {
  const dialog = source('./Dialog.tsx');
  const focus = source('../lib/useNativeDialog.ts');
  const css = source('../styles/components/dialog.scss');
  assert.match(dialog, /useNativeDialog\(ref\)/);
  assert.match(dialog, /<UxErrorNotifications withinDialog/);
  assert.match(focus, /dialog.showModal\(\)/);
  assert.match(focus, /dialog.close\(\)/);
  assert.doesNotMatch(focus, /\.focus\(|MutationObserver|focusin|keydown|inert/);
  assert.match(css, /calc\(0.5rem \+ var\(--ux-error-height, 0px\)\)/);
  const html = renderToStaticMarkup(createElement(DirectoryModal, {
    busy: true, children: 'pending', onCancel: () => assert.fail('render cannot cancel'),
  }));
  assert.match(html, /<dialog.*aria-busy="true"/);
  assert.match(html, /<h3[^>]*tabindex="-1"[^>]*>新建会话/);
  assert.match(dialog, /heading.autofocus = true/);
});

test('ordinary dialogs have native initial focus without repeated focus or selection', () => {
  const dialog = source('./Dialog.tsx');
  assert.match(dialog, /useNativeDialog\(dialogRef\)/);
  assert.doesNotMatch(dialog, /\.focus\(|\.select\(|addEventListener/);
  const html = renderToStaticMarkup(createElement(Dialog, {
    title: 'Rename target', input: { initial: 'Target B' },
    onConfirm: () => assert.fail('Rendering must not mutate a session'),
    onCancel: () => assert.fail('Rendering must not dismiss'),
  }));
  assert.match(html, /<dialog class="dialog-scrim host-modal ck-modal"/);
  assert.match(html, /value="Target B"/);
});

test('menu separators are structural, not extra focusable actions', () => {
  const html = renderToStaticMarkup(createElement(MenuItemButton, {
    item: { label: 'Target page', separatorBefore: true, onClick() {} }, onClose() {},
  }));
  assert.match(html, /<div class="btn-menu-separator" role="separator"><\/div>/);
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /role="separator" tabindex/);
});

test('long menus keep internal scroll open and dismiss before panel Escape; Tab exits', () => {
  const dismiss = source('../lib/useMenuDismiss.ts');
  assert.match(dismiss, /!e.target.closest\('\.btn-menu'\)/);
  assert.match(dismiss, /e.stopImmediatePropagation\(\)/);
  assert.match(dismiss, /e.key === 'Tab'\) onClose\(\)/);
  assert.match(dismiss, /addEventListener\('keydown', onKey, true\)/);
  assert.doesNotMatch(dismiss, /addEventListener\('scroll'/);
  assert.match(dismiss, /addEventListener\('wheel', onWheel, \{ capture: true, passive: true \}\)/);
  assert.match(dismiss, /addEventListener\('touchmove', onScrollIntent, \{ capture: true, passive: true \}\)/);
  assert.match(dismiss, /removeEventListener\('wheel', onWheel, true\)/);
  assert.match(dismiss, /removeEventListener\('touchmove', onScrollIntent, true\)/);
  assert.match(dismiss, /!e.ctrlKey && \(e.deltaX !== 0 \|\| e.deltaY !== 0\)/);
  for (const file of ['./AnchoredMenu.tsx', './ContextMenu.tsx']) {
    assert.match(source(file), /key=\{it.id \?\? it.label\}/);
  }
  for (const file of ['./AnchoredMenu.tsx', './ContextMenu.tsx']) {
    assert.match(source(file), /scrollIntoView\(\{ block: 'nearest' \}\)/);
  }
  assert.match(source('./ContextMenu.tsx'), /maxHeight: 'calc\(100dvh - 16px\)', overflowY: 'auto'/);
});

test('session pages retain a stable native frame without initial focus or a custom Tab trap', () => {
  const details = source('./SessionDetails.tsx');
  const shell = source('./Shell.tsx');
  assert.doesNotMatch(details, /navigation=|SESSION_PRIMARY|SESSION_MORE|<nav|<Link/);
  assert.match(shell, /<dialog ref=\{frame\}/);
  assert.ok(details.indexOf('<InspectorPane') < details.indexOf('<Suspense fallback='));
  assert.match(shell, /useNativeDialog\(frame, !wide\)/);
  assert.doesNotMatch(shell, /\.focus\(|event.key [!=]== 'Tab'/);
  assert.match(shell, /event.defaultPrevented/);
  for (const file of ['./SessionInfoPanel.tsx', './SessionPanelKit.tsx', './Manage.tsx']) {
    assert.doesNotMatch(source(file), /navigation[?=:]|info-panel-nav|info-panel-more/);
  }
});

test('panel keyboard scope includes the nonmodal error tray and dismissal does not close the panel', () => {
  const details = source('./SessionDetails.tsx');
  const notifications = source('./UxErrorNotifications.tsx');
  const css = source('./UxErrorNotifications.scss');
  assert.match(details, /modalFooter=\{<UxErrorNotifications withinDialog/);
  assert.match(source('./Shell.tsx'), /!wide && modalFooter/);
  assert.match(source('./Shell.tsx'), /event.defaultPrevented/);
  assert.match(notifications, /event.stopPropagation\(\)/);
  assert.match(notifications, /dismiss\(error.id, event.currentTarget\)/);
  assert.match(notifications, /buttons\[index \+ 1\] \?\? buttons\[index - 1\]/);
  assert.match(notifications, /querySelector<HTMLElement>\('\.inspector-pane\[open\] \.inspector-surface'\) \?\? document.querySelector<HTMLElement>\('\.cockpit-shell'\)/);
  assert.match(css, /bottom: var\(--ux-error-height, 0px\)/);
  assert.match(css, /height: calc\(100dvh - var\(--ux-error-height, 0px\)\)/);
  assert.match(css, /:root:has\(\.ux-error-notifications\) \.chat-input \{\s*padding-bottom: 0\.25rem/);
  assert.match(css, /z-index: 45/);
  assert.doesNotMatch(notifications, /aria-modal|onClose|navigate/);
});

test('management does not move focus on entry or async detail changes and focus rings stay in bounds', () => {
  assert.doesNotMatch(source('./ManagementShell.tsx'), /\.focus\(|autoFocus|tabIndex/);
  assert.match(source('../styles/primitives/public-ui.scss'), /:focus-visible \{ outline: 2px solid var\(--ck-color-accent\); outline-offset: -2px/);
  assert.match(source('../styles/components/chat.scss'), /\[tabindex\]\):focus-visible \{ outline: 2px solid var\(--chat-accent-ink\); outline-offset: -2px/);
  assert.match(source('./threadScroll.ts'), /active.blur\(\)/);
});

test('sidebar menu stores target identity, derives current actions, and dismisses when its owner disappears', () => {
  const sidebar = source('./Sidebar.tsx');
  assert.match(sidebar, /sessions.find\(s => s.sessionId === menu.sessionId\)/);
  assert.match(sidebar, /menuSession \? getMenuItems\(menuSession\) : \[\]/);
  assert.match(sidebar, /setMenu\(\{ x, y, trigger, sessionId: s.sessionId, activeId \}\)/);
  assert.doesNotMatch(sidebar, /setMenu\(\{[^}]*items:/);
  assert.match(sidebar, /!menuSession \|\| menu.activeId !== activeId/);
  assert.match(sidebar, /items=\{menuItems\}/);
});

test('sidebar live updates share the existing valid-focus preservation and fallback policy', () => {
  const sidebar = source('./Sidebar.tsx');
  const menu = source('./ContextMenu.tsx');
  assert.match(menu, /menuFocusTarget\(focusInitialized.current, focusedItem.current, enabled\)/);
  assert.match(menu, /\(target \?\? menu\).focus\(\)/);
  assert.match(menu, /focusedItem.current = event.target/);
  assert.match(sidebar, /<ContextMenu key=\{menu.sessionId\}/);
  assert.match(sidebar, /trigger\?\.isConnected \? trigger : Array.from/);
  assert.match(sidebar, /element.dataset.sessionId === menu\?\.sessionId/);
});
