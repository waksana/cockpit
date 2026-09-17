import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleFrontend, ModuleFrontendContext } from '@cockpit/module-api';
import { SessionDraft } from '../lib/textDraft';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { Composer } from './Composer';

async function fixture(frontend: ModuleFrontend) {
  const digest = 'a'.repeat(64);
  let activation!: ModuleFrontendContext;
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'fixture', name: 'Fixture', version: '1.0.0', digest,
      apiBase: `/_modules/fixture/${digest}/api`,
      entry: `/_modules/assets/fixture/${digest}/entry.js`, styles: [], config: {},
    }], errors: [] }),
    load: async () => ({ activate: (context: ModuleFrontendContext) => { activation = context; return frontend; } }), report: assert.fail,
  });
  await runtime.start();
  const draft = new SessionDraft('fixture');
  const context = { draft: activation.state.bindDraft(draft.reference) };
  const render = () => renderToStaticMarkup(createElement(Composer, {
    draft, runtime, onSend: () => draft.send(async () => true),
  }));
  return { runtime, draft, context, render };
}

test('active draft blocking only disables sending without a global warning or duplicate attachment list', async t => {
  const f = await fixture({
    apiVersion: 2, writes: ['attachments'],
    components: [{ id: 'cards', boundary: 'attachment', wrap: _Base => props =>
      createElement('span', { className: 'fixture-card' }, props.label, props.actions,
        props.onRemove && createElement('button', { disabled: props.disabled, onClick: props.onRemove, 'aria-label': '移除附件' }, '移除')) }],
  });
  t.after(() => f.runtime.stop());
  f.draft.edit('Message');
  f.context.draft.appendAttachments([{ id: 'file', value: { type: 'file', path: '/fixture/file', displayName: 'Ready' } }]);
  const release = f.context.draft.block('Wait for file');
  const html = f.render();
  assert.match(html, /fixture-card/);
  assert.doesNotMatch(html, /chat-input-notice|module-draft-recovery|module-draft-attachments|module-composer|<details class="module|原生附件/);
  assert.equal((html.match(/fixture-card/g) ?? []).length, 1);
  assert.match(html, /aria-label="移除附件"/);
  assert.match(html, /class="chat-input-btn ck-icon-button send rp" disabled=""/);
  assert.match(html, /title="Wait for file"/);
  assert.equal(await f.draft.send(async () => assert.fail('Blocked draft must not send')), false);
  release();
  assert.doesNotMatch(f.render(), /class="chat-input-btn ck-icon-button send rp" disabled=""/);
});

test('ordinary middleware composes context without hiding the default attachment removal list', async t => {
  const f = await fixture({
    apiVersion: 2, writes: ['attachments'],
    components: [{ id: 'other', boundary: 'composer', wrap: Base => props =>
      createElement(Base, { ...props, children: createElement(Fragment, null, props.children, createElement('span', {}, 'Unrelated component')) }) }],
  });
  t.after(() => f.runtime.stop());
  f.context.draft.appendAttachments([{ id: 'file', value: { type: 'file', path: '/fixture/file', displayName: 'Ready' } }]);
  const html = f.render();
  assert.match(html, /class="draft-attachments"/);
  assert.match(html, /Ready/);
  assert.match(html, /aria-label="移除附件"/);
  assert.doesNotMatch(html, /<details class="module|原生附件/);
});

test('module revocation keeps ready attachments and a dismissible inline blocker without an error box', async t => {
  const f = await fixture({
    apiVersion: 2, writes: ['attachments'],
    components: [{ id: 'cards', boundary: 'attachment', wrap: Base => props => createElement(Base, props) }],
  });

  t.after(() => f.runtime.stop());
  f.context.draft.appendAttachments([{ id: 'file', value: { type: 'file', path: '/fixture/file' } }]);
  f.context.draft.block('Interrupted selection');
  f.runtime.unregister(f.runtime.getSnapshot()[0]);
  const html = f.render();
  assert.match(html, /module-draft-recovery/);
  assert.match(html, /移除未完成的选择/);
  assert.match(html, /class="draft-attachments"/);
  assert.doesNotMatch(html, /chat-input-notice|原生附件|<details class="module/);
  f.draft.dismissOrphanedBlock(f.draft.getSnapshot().blocks[0].id);
  assert.equal(await f.draft.send(async () => true), true);
});

test('submission disables module actions and fallback removal but preserves text editing until its receipt', async t => {
  const f = await fixture({
    apiVersion: 2, writes: ['attachments'],
    components: [{ id: 'controls', boundary: 'composer', wrap: Base => props => {
      const disabled = props.disabled || props.draft.getSnapshot().pending;
      return createElement(Base, { ...props,
        actions: interactions => createElement(Fragment, null, props.actions?.(interactions),
          createElement('button', { disabled, 'aria-label': 'fixture upload' }, 'Upload')),
        children: createElement(Fragment, null, props.children,
          createElement('button', { disabled, 'aria-label': 'fixture remove' }, 'Remove')),
      });
    } }],
  });
  t.after(() => f.runtime.stop());
  f.context.draft.appendAttachments([{ id: 'ready', value: { type: 'file', path: '/fixture/ready' } }]);
  let finish!: (sent: boolean) => void;
  const sending = f.draft.send(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const html = f.render();
  for (const label of ['fixture upload', 'fixture remove', '移除附件']) {
    const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
    assert.match(button ?? '', /disabled=""/, label);
  }
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)?.[0] ?? '', /disabled/);
  finish(false);
  await sending;
  const restored = f.render();
  for (const label of ['fixture upload', 'fixture remove', '移除附件']) {
    assert.doesNotMatch(restored.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '', /disabled/);
  }
});
