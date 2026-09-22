import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { SessionMeta } from '../net/types';
import { sessionSummary } from './sessionSummary';
import { SessionList } from './SessionList';
import { focusedSessionId, detailsNavigation } from '../lib/routeOwnership';
import { PHONE_QUERY, MASTER_DOCK_QUERY, INSPECTOR_DOCK_QUERY } from '../lib/layout';

test('compact session summaries preserve directory roots and relative activity', () => {
  const now = new Date(2026, 8, 22, 12).getTime();
  assert.deepEqual(sessionSummary({ cwd: '/workspace/project/', lastActivity: now - 90_000 }, now),
    { directory: 'project', time: '1分' });
  assert.equal(sessionSummary({ cwd: '/', lastActivity: now + 1 }, now).directory, '/');
  assert.equal(sessionSummary({ cwd: '', lastActivity: now }, now).directory, '工作目录未提供');
  assert.equal(sessionSummary({ cwd: '/', lastActivity: now - 2 * 3_600_000 }, now).time, '2时');
  assert.equal(sessionSummary({ cwd: '/', lastActivity: now - 2 * 86_400_000 }, now).time, '9/20');
});

test('compact rows keep complete names, saved roles and independent menu controls', () => {
  const session: SessionMeta = {
    sessionId: 'synthetic', title: 'Synthetic complete long title', cwd: '/workspace/long-project',
    lastActivity: 1, status: 'idle', loaded: false, queue: [], ask: null,
    roles: [{ moduleId: 'fixture', roleId: 'owner', moduleName: 'Fixture', name: 'Owner' }],
  };
  const noAction = () => assert.fail('Render must not perform an action');
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SessionList, {
    sessions: [session], activeId: session.sessionId, snapshotReady: true,
    handlers: { openPanel: noAction, delete: noAction },
  })));
  assert.match(html, /Synthetic complete long title/);
  assert.match(html, /long-project/);
  assert.match(html, /Fixture · Owner/);
  assert.match(html, /不代表已应用或能力就绪/);
  assert.match(html, /aria-current="page"/);
  assert.doesNotMatch(html, /<a[^>]*>(?:(?!<\/a>)[\s\S])*<button/);
});

test('next shell follows classic phone, master and inspector breakpoints and route ownership', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes(`@media ${PHONE_QUERY}`));
  assert.ok(css.includes(`@media ${INSPECTOR_DOCK_QUERY}`));
  assert.equal(MASTER_DOCK_QUERY, '(min-width: 925px)');
  assert.match(css, /@media \(max-width: 924px\)/);
  assert.equal(focusedSessionId('/session/s/info', true), null);
  assert.equal(focusedSessionId('/session/s/info', false), 's');
  assert.deepEqual(detailsNavigation('/session/s', 's', 'info'), { to: '/session/s/info', replace: false });
  assert.deepEqual(detailsNavigation('/session/s/info', 's', 'mcp'), { to: '/session/s/mcp', replace: true });
});

test('responsive settings keep one native frame with in-modal controls and error recovery', () => {
  const inspector = readFileSync(new URL('./SessionInspector.tsx', import.meta.url), 'utf8');
  const controls = readFileSync(new URL('./settings/SettingsControls.tsx', import.meta.url), 'utf8');
  const select = readFileSync(new URL('../../../../packages/ui/src/components/select.tsx', import.meta.url), 'utf8');
  assert.match(inspector, /useNativeDialog\(frame, !docked\)/);
  assert.match(inspector, /SettingsOverlayContainer value=\{container\}/);
  assert.match(inspector, /<Errors \/>/);
  assert.match(inspector, /data-next-focus/);
  assert.match(controls, /SelectContent container=\{container\}/);
  assert.match(select, /SelectPrimitive.Portal container=\{container\}/);
  assert.doesNotMatch(inspector, /docked \? <|key=\{docked|addEventListener\('focusin'/);
});
