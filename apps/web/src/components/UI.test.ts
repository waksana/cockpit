import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import { ActionList, ActionRow, Badge, CheckboxCard, HeadingAction, PendingChangesBar, SectionHeading, SelectField, Toggle } from './UI';
import { MemoryRouter } from 'react-router-dom';
import { ResourceList, ResourceRow, ResourceText } from './ResourceRow';
import { McpStatusPill } from './McpStatus';

test('labeled selects preserve native control attributes and own one decorative arrow', () => {
  const html = renderToStaticMarkup(createElement(SelectField, {
    label: '模型', name: 'model', value: 'native', disabled: true, required: true,
    'aria-describedby': 'model-hint', onChange() {},
    children: createElement('option', { value: 'native' }, 'Native model'),
  }));
  assert.match(html, /^<label class="ui-field"><span class="ui-field-label">模型<\/span>/);
  assert.match(html, /<select[^>]*name="model"[^>]*disabled=""[^>]*required=""[^>]*aria-describedby="model-hint"/);
  assert.match(html, /class="ck-input ui-select"/);
  assert.match(html, /<option value="native" selected="">Native model<\/option>/);
  assert.equal((html.match(/data-icon="down"/g) ?? []).length, 1);
  assert.match(html, /data-icon="down" aria-hidden="true"/);
});

test('checkbox cards use native checked and disabled semantics without interactive nesting', () => {
  const html = renderToStaticMarkup(createElement(CheckboxCard, {
    checked: true, disabled: true, 'aria-labelledby': 'role-name',
    'aria-describedby': 'role-description', onChange() {},
    children: createElement('span', { id: 'role-name' }, 'Role'),
  }));
  assert.match(html, /^<label class="ui-choice-card" data-selected="true">/);
  assert.match(html, /<input[^>]*disabled=""[^>]*aria-labelledby="role-name"[^>]*aria-describedby="role-description"/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.doesNotMatch(html, /<button|role="switch"|tabindex=/);
});

test('section actions are siblings of a semantic heading, not part of its name', () => {
  const html = renderToStaticMarkup(createElement(SectionHeading, {
    children: '模型', actions: createElement('button', { type: 'button', 'aria-label': '刷新' }),
  }));
  assert.match(html, /<h3 class="ck-heading">模型<\/h3><div class="ui-section-actions"><button type="button" aria-label="刷新"><\/button><\/div>/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(SectionHeading, { children: 'Plain' })), /ui-section-actions/);
  assert.match(renderToStaticMarkup(createElement(SectionHeading, { level: 2, children: 'Global resource' })),
    /<h2 class="ck-heading">Global resource<\/h2>/);
});

test('action rows are named full-row buttons in a group; busy replaces the chevron and description', () => {
  const html = renderToStaticMarkup(createElement(ActionList, { label: 'Operations', disabled: true, children: [
    createElement(ActionRow, { key: 'a', icon: 'unload', name: 'Unload', description: 'Keeps history', disabled: true }),
    createElement(ActionRow, { key: 'b', icon: 'fork', name: 'Fork', description: 'Copies history', busy: true, busyDescription: 'Working…' }),
  ] }));
  assert.match(html, /^<div class="ui-action-list" role="group" aria-label="Operations" data-disabled="true">/);
  const rows = html.match(/<button[^>]*class="ui-action-row ck-button"[^>]*>/g) ?? [];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row, /type="button"/);
    const [, name] = row.match(/aria-labelledby="([^"]+)"/)!;
    const [, description] = row.match(/aria-describedby="([^"]+)"/)!;
    assert.match(html, new RegExp(`id="${name}" class="ui-action-name"`));
    assert.match(html, new RegExp(`id="${description}" class="ui-action-description"`));
  }
  assert.match(rows[0], /disabled=""/);
  assert.match(rows[1], /aria-busy="true"/);
  assert.match(html, /Keeps history.*data-icon="chevron_right".*Working….*data-icon="loading"/);
  assert.doesNotMatch(html, /Copies history|title=/);
});

test('pending bar is a labelled group and heading actions keep their own names', () => {
  const bar = renderToStaticMarkup(createElement(PendingChangesBar, { message: 'Unsaved', children: createElement('button', { type: 'button' }, 'Apply') }));
  assert.match(bar, /^<div class="ui-pending-bar" role="group" aria-labelledby="([^"]+)"><span id="\1" class="ui-pending-message">Unsaved<\/span><div class="ck-actions"><button type="button">Apply<\/button><\/div><\/div>$/);
  const action = renderToStaticMarkup(createElement(HeadingAction, { icon: 'add', 'aria-expanded': false, children: 'Add' }));
  assert.match(action, /^<button type="button" class="ui-heading-action ck-button" aria-expanded="false"><span class="ck-icon" data-icon="add"/);
  assert.match(action, /Add<\/button>$/);
});

test('the shared toggle names and disables its native switch without implying completion', () => {
  const html = renderToStaticMarkup(createElement(Toggle, {
    label: 'Enable resource', on: false, busy: true, disabled: true, onChange() {},
  }));
  assert.match(html, /type="button" role="switch" aria-label="Enable resource" aria-checked="false" aria-busy="true" disabled=""/);
  assert.doesNotMatch(html, /is-on|成功/);
});

test('badges share typed text and subtle appearances without inventing status ownership', () => {
  const badge = renderToStaticMarkup(createElement(Badge, { children: 'New session default' }));
  assert.match(badge, /data-tone="neutral" data-appearance="subtle"/);
  assert.doesNotMatch(badge, /role="status"|role="alert"/);
  const status = renderToStaticMarkup(createElement(McpStatusPill, { status: 'stopped', appearance: 'text' }));
  assert.match(status, /已停止/);
  assert.match(status, /data-tone="off" data-appearance="text"/);
  assert.match(status, /策略允许.*受限策略隔离时不能重启/);
});

test('one resource row: badge + name, one-line summary, then status and switch on one line', () => {
  const control = createElement('button', { type: 'button', role: 'switch', 'aria-checked': false }, 'Enable');
  const status = createElement('span', null, 'Not connected');
  const badge = createElement(Badge, { className: 'role-badge', children: 'Source' });
  const plain = renderToStaticMarkup(createElement(ResourceRow, { name: 'Server', connection: true, control, status, badge }));
  assert.match(plain, /data-resource-name="Server"/);
  assert.doesNotMatch(plain, /data-selectable|<a /);
  assert.match(plain, /^<div class="resource-row manage-row"[^>]*><div class="manage-resource-identity"><span class="resource-name manage-row-name"><span class="ck-badge ui-badge role-badge"[^>]*>Source<\/span><span class="resource-title-text">Server<\/span><\/span><\/div>/,
    'badge precedes the name, and absent summaries reserve no line');
  assert.match(plain, /<div class="manage-resource-controls"><div class="manage-row-status" role="status"><span>Not connected<\/span><\/div><button[^>]*role="switch"/,
    'status precedes the switch inside one control group');

  const long = 'A long summary that must stay on one ellipsized line. '.repeat(6);
  const linked = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ResourceRow, {
    name: 'a-very-long-resource-name-that-wraps', control, badge,
    summary: createElement(ResourceText, { text: long, label: 'summary', disclosure: false }),
    link: { to: '/skills/a', selected: true },
    feedback: createElement('div', { className: 'manage-row-error' }, 'failure'),
  })));
  assert.match(linked, /data-selectable="true" data-selected="true"/);
  assert.match(linked, /<a class="manage-resource-identity ck-button" aria-current="page" href="\/skills\/a"[^>]*>/);
  const anchor = linked.slice(linked.indexOf('<a '), linked.indexOf('</a>'));
  assert.doesNotMatch(anchor, /<button|<div|role="switch"/, 'navigation holds only phrasing identity content');
  assert.match(anchor, /class="manage-row-text" data-lines="1" title="A long summary/);
  assert.match(linked, /<\/a><div class="manage-resource-controls"><button/, 'no empty status slot');
  assert.match(linked, /<\/div><div class="manage-row-error">failure<\/div><\/div>$/, 'feedback follows as a full-width row');
  const unselected = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ResourceRow, {
    name: 'b', control, link: { to: '/skills/b', selected: false },
  })));
  assert.doesNotMatch(unselected, /data-selected|aria-current/);

  const list = renderToStaticMarkup(createElement(ResourceList, { hint: '开关：新会话默认启用', children: plain }));
  assert.equal(list.match(/开关：新会话默认启用/g)?.length, 1);
  assert.match(list, /^<p class="manage-list-hint">开关：新会话默认启用<\/p><div class="manage-list">/);
});

test('controls retain the desktop baseline, touch input floor, inset focus and coarse targets', () => {
  const css = compile(new URL('../styles/primitives/public-ui.scss', import.meta.url).pathname).css;
  assert.match(css, /:where\(\.ck-button, \.ck-icon-button\) \{[^}]*font-size: var\(--host-text-body\)/);
  assert.match(css, /:where\(\.ck-input\) \{[^}]*font-size: max\(var\(--ck-input-font-min\), var\(--host-text-body\)\)/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*--ck-control-size: 44px/);
  assert.match(css, /:is\(\.ck-button, \.ck-icon-button, \.ck-input\):focus-visible \{[^}]*outline: 2px solid var\(--ck-color-accent\);[^}]*outline-offset: -2px/);
  assert.match(css, /\.ui-choice-card:has\(input:focus-visible\) \{[^}]*outline-offset: -2px/);
  assert.match(css, /\.ui-choice-card:has\(input:disabled\)/);
  const info = readFileSync(new URL('../styles/components/info-panel.scss', import.meta.url), 'utf8');
  const dialog = readFileSync(new URL('../styles/components/dialog.scss', import.meta.url), 'utf8');
  const pointerOnly = /:root \[data-native-dialog-pointer-focus\]:focus-visible \{\s*outline: none;\s*\}/;
  assert.match(dialog, pointerOnly);
  assert.doesNotMatch(info + dialog.replace(pointerOnly, ''), /outline:\s*none|\.info-select\b|^\.dialog-btn\s*\{/m);
  assert.match(dialog, /\[data-dialog-focus\]:focus-visible \{[^}]*box-shadow: inset 3px 0 0 var\(--host-color-accent\)/);
  assert.doesNotMatch(dialog.match(/\[data-dialog-focus\]:focus-visible \{([^}]*)\}/)![1], /text-decoration|padding|margin|border:/);
});
