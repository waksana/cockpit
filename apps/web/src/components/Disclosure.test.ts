import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Disclosure, DisclosureSection, TextClamp } from './Disclosure';
import { OperationErrorResult, OperationResult } from './OperationResult';
import { OperationNotSent, OperationRejected, OperationUnconfirmed } from '../lib/operationErrors';

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

test('disclosure rows lead with one direction chevron and name their action', () => {
  const closed = render(createElement(Disclosure, { open: false, onToggle() {}, controls: 'r', label: '任务要求', name: '任务要求' }));
  assert.match(closed, /^<button type="button" class="ui-disclosure ck-button" aria-expanded="false" aria-controls="r" aria-label="展开任务要求"/);
  assert.match(closed, /ui-disclosure-chevron[^>]*>.*<span class="ui-disclosure-label">任务要求<\/span><\/button>$/);
  const open = render(createElement(Disclosure, { open: true, onToggle() {}, name: '状态', meta: '3 项', className: 'owner' }));
  assert.match(open, /class="owner ui-disclosure ck-button" aria-expanded="true" aria-label="收起状态"/);
  assert.match(open, /<span class="ui-disclosure-meta">3 项<\/span>/);
  assert.match(closed, /class="ck-icon ui-disclosure-chevron" data-icon="chevron_right"/);
  assert.match(open, /class="ck-icon ui-disclosure-chevron" data-icon="down"/);
  const leading = render(createElement(Disclosure, { open: false, onToggle() {}, name: '细节', leading: createElement('i', { className: 'owner-icon' }) }));
  assert.match(leading, /<i class="owner-icon"><\/i>/);
  assert.doesNotMatch(leading, /ui-disclosure-chevron/, 'an owner icon replaces the default chevron');
});

test('disclosure sections replace native details and start closed with a hidden region', () => {
  const html = render(createElement(DisclosureSection, { label: '查看完整计划', name: '完整计划', children: 'Plan body' }));
  assert.doesNotMatch(html, /<details|<summary/);
  const id = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(id);
  assert.match(html, new RegExp(`<div id="${id}" class="ui-disclosure-region" hidden="">Plan body</div>`));
  assert.match(html, /aria-label="展开完整计划"/);
  const open = render(createElement(DisclosureSection, { label: '详情', defaultOpen: true, children: 'x' }));
  assert.match(open, /data-open="true"/);
  assert.doesNotMatch(open, /hidden=""/);
});

test('text clamps carry their line budget and offer no toggle before clipping is measured', () => {
  const html = render(createElement(TextClamp, { text: 'Queued message', label: '排队消息', lines: 1 }));
  assert.match(html, /^<span class="ui-text-clamp" data-lines="1"><span id="[^"]+" class="ui-text-clamp-text" data-lines="1">Queued message<\/span><\/span>$/);
  assert.doesNotMatch(html, /展开全文/);
  const link = render(createElement(TextClamp, { text: 'Long name', label: '名称', expandable: false }));
  assert.match(link, /data-lines="2" title="Long name"/, 'text inside a link keeps the full value in its title');
});

test('operation results carry state by icon and words; only failures and unknowns interrupt', () => {
  for (const state of ['busy', 'done', 'info', 'failed', 'unknown'] as const) {
    const html = render(createElement(OperationResult, { state, children: 'Sentence' }));
    assert.match(html, new RegExp(`^<div class="operation-result" data-state="${state}"><div class="operation-result-line" role="${
      state === 'failed' || state === 'unknown' ? 'alert' : 'status'}"><span class="ck-icon operation-result-icon[^"]*" data-icon="${
      { busy: 'loading', done: 'success', info: 'decision', failed: 'error', unknown: 'unknown' }[state]}"`));
    assert.match(html, /<span class="operation-result-text">Sentence<\/span>/);
    assert.doesNotMatch(html, /operation-result-actions|详情/, 'no empty action row');
  }
  assert.match(render(createElement(OperationResult, { state: 'busy', children: 'x' })), /operation-result-icon spinner/);
});

test('operation results offer one action and fold long causes into details', () => {
  const html = render(createElement(OperationResult, {
    state: 'failed', name: 'A', details: 'Error: stack\n  at native.write',
    action: { label: '刷新', onClick() {} }, children: '启用 A 失败：stack',
  }));
  assert.match(html, /<div class="operation-result-actions"><button type="button" class="operation-result-action ck-button">刷新<\/button>/);
  assert.match(html, /aria-expanded="false" aria-controls="([^"]+)" aria-label="展开A详情"/);
  assert.match(html, /<div id="[^"]+" class="operation-result-details" hidden="">Error: stack\n {2}at native.write<\/div>/);
});

test('caught errors are worded as failed only when known not to have applied', () => {
  const sentence = (cause: unknown) => {
    const html = render(createElement(OperationErrorResult, { label: '保存角色', error: 'busy', cause }));
    return [html.match(/data-state="(\w+)"/)?.[1], html.match(/operation-result-text">([^<]*)</)?.[1]];
  };
  assert.deepEqual(sentence(new OperationRejected('busy')), ['failed', '保存角色失败：busy']);
  assert.deepEqual(sentence(new OperationNotSent('busy')), ['failed', '保存角色失败：busy']);
  assert.deepEqual(sentence(new OperationUnconfirmed('busy')), ['unknown', '结果未知：busy。刷新后确认，不会自动重试。']);
  assert.deepEqual(sentence(new Error('busy')), ['unknown', '结果未知：busy。刷新后确认，不会自动重试。'],
    'an unclassified error never claims the change did not happen');
});
