import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'sass';
import { ActionList, ActionRow, Badge, CheckboxCard, HeadingAction, PendingChangesBar, SectionHeading, SelectField, Toggle } from './UI';
import { ResourceRow, ResourceSummary } from './ResourceRow';
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
  const rows = html.match(/<button[^>]*class="ui-action-row ck-button rp"[^>]*>/g) ?? [];
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
  assert.match(action, /^<button aria-expanded="false" type="button" class="ui-heading-action ck-button rp"><span class="ck-icon" data-icon="add"/);
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

test('resource compositions keep navigation content valid and actions outside identity text', () => {
  const summary = renderToStaticMarkup(createElement('button', { type: 'button' },
    createElement(ResourceSummary, { name: 'Resource', source: 'Configuration', badge: createElement(Badge, { children: 'Source' }) })));
  assert.doesNotMatch(summary, /<div|<button[^>]*>.*<button/s);
  const row = renderToStaticMarkup(createElement(ResourceRow, {
    name: 'Server', connection: true, source: 'Saved config',
    control: createElement('button', { type: 'button', role: 'switch', 'aria-checked': false }, 'Enable'),
    status: createElement('div', { role: 'status' }, 'Not connected'),
  }));
  assert.match(row, /data-resource-name="Server"/);
  assert.match(row, /class="manage-resource-identity"/);
  assert.match(row, /Saved config<\/div><\/div><div class="manage-resource-controls"><button/);
  assert.doesNotMatch(row, /manage-row-description|aria-busy/);
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
  assert.match(dialog, /\[data-dialog-focus\]:focus-visible \{[^}]*box-shadow: inset 3px 0 0 var\(--primary-color\)/);
  assert.doesNotMatch(dialog.match(/\[data-dialog-focus\]:focus-visible \{([^}]*)\}/)![1], /text-decoration|padding|margin|border:/);
});
