import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h, Fragment, useSyncExternalStore } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DraftSchemaHandle, DraftSchemaScope, ModuleComponentMiddleware, ModuleDraft, ModuleFrontend, ModuleFrontendContext,
} from '@cockpit/module-api';
import { SessionDraft } from '../lib/textDraft';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { appendFixture, fixtureItem, fixtureSchema, type FixtureData } from '../test/draftFixture';
import { Composer } from './Composer';
import { failOnReport } from '../test/failOnReport';

async function fixture(withInput = false, withStatus = false) {
  const digest = 'a'.repeat(64);
  let context!: ModuleFrontendContext, handle!: DraftSchemaHandle<FixtureData>;
  function List({ draft, field }: { draft: ModuleDraft; field: DraftSchemaScope<FixtureData> }) {
    const state = useSyncExternalStore(field.subscribe, field.getSnapshot, field.getSnapshot);
    const base = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
    if (!state.items.length) return null;
    return h('section', { className: 'fixture-list' }, state.items.map(item => h('span', { key: item.id, className: 'fixture-row' },
      item.id, h('button', { disabled: base.pending, 'aria-label': `Remove ${item.id}`,
        onClick: () => field.update(value => ({ items: value.items.filter(row => row !== item) })),
      }, 'Remove'))));
  }
  function AddItem({ draft, field, disabled }: { draft: ModuleDraft; field: DraftSchemaScope<FixtureData>; disabled: boolean }) {
    const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
    return h('button', {
      type: 'button', 'aria-label': 'Add item', disabled: disabled || state.pending,
      onClick: () => {
        if (!disabled && !draft.getSnapshot().pending) appendFixture(field, fixtureItem('Added item'));
      },
    }, 'Add item');
  }
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'fixture', name: 'Fixture', version: '1.0.0', digest, styles: [], config: {},
      apiBase: `/_modules/fixture/${digest}/api`, entry: `/_modules/assets/fixture/${digest}/entry.js`,
    }], errors: [] }),
    load: async () => ({ activate: (value: ModuleFrontendContext): ModuleFrontend => {
      context = value;
      handle = context.state.registerDraft(fixtureSchema());
      return { apiVersion: 2, components: [{ id: 'list', boundary: 'composer',
        wrap: Base => props => {
            const field = handle.forDraft(props.draft);
            const base = context.state.bindDraft(props.draft);
            return h(Base, { ...props,
              children: h(Fragment, null, props.children, field && h(List, { draft: base, field })),
            });
          },
      }, {
        id: 'editor', boundary: 'composerEditor',
        wrap: Base => props => {
          const field = handle.forDraft(props.draft);
          return h(Base, { ...props,
            children: h(Fragment, null, props.children, field && h(AddItem, {
              draft: context.state.bindDraft(props.draft), field, disabled: props.disabled,
            })),
          });
        },
      }, ...withStatus ? [{
        id: 'status', boundary: 'composerEditor',
        wrap: Base => props => h('div', { className: 'fixture-editor' },
          h('div', { className: 'fixture-status', role: 'status' }, 'Recording'), h(Base, props)),
      } satisfies ModuleComponentMiddleware] : [], {
        id: 'input', boundary: 'composerInput',
        wrap: Base => props => h(Fragment, null, h(Base, props), withInput && h('button', {
          type: 'button', 'aria-label': 'Microphone', disabled: props.disabled || props.sendBlocked,
        }, 'Microphone')),
      }] };
    } }),
    report: failOnReport,
  });
  await runtime.start();
  const draft = new SessionDraft('fixture');
  runtime.prepareDraft(draft);
  const render = (target = draft) => {
    runtime.prepareDraft(target);
    return renderToStaticMarkup(h(Composer, {
      draft: target, runtime, onSend: () => target.send(async () => true),
      ...(target.reference.purpose.kind === 'ask'
        ? { ask: { request: { requestId: target.reference.purpose.requestId, question: 'Question' }, onChoice() {} } } : {}),
    }));
  };
  return { runtime, draft, context, handle, field: handle.forDraft(draft.reference)!, render };
}

test('left contributions, enhanced input and native send retain their DOM order for prompt and answers', async t => {
  const f = await fixture(true);
  t.after(() => f.runtime.stop());
  const prompt = f.render();
  assert.ok(prompt.indexOf('aria-label="Add item"') < prompt.indexOf('<textarea'));
  assert.ok(prompt.indexOf('</textarea>') < prompt.indexOf('aria-label="Microphone"'));
  assert.ok(prompt.indexOf('aria-label="Microphone"') < prompt.indexOf('class="chat-input-btn'));
  for (const kind of ['ask', 'plan', 'elicitation'] as const) {
    const answer = new SessionDraft('fixture', undefined, { kind, requestId: `${kind}-request` });
    const html = f.render(answer);
    assert.doesNotMatch(html, /aria-label="Add item"/);
    assert.ok(html.indexOf('</textarea>') < html.indexOf('aria-label="Microphone"'));
    assert.ok(html.indexOf('aria-label="Microphone"') < html.indexOf('class="chat-input-btn'));
    assert.equal((html.match(/<textarea\b/g) ?? []).length, 1);
    assert.doesNotMatch(html, /actions=|<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  }
});

test('module content wrapped around the editor stays inside the host editor container for prompts and answers', async t => {
  const f = await fixture(true, true);
  t.after(() => f.runtime.stop());
  for (const draft of [f.draft, new SessionDraft('fixture', undefined, { kind: 'ask', requestId: 'ask-request' })]) {
    const html = f.render(draft);
    // The controls card pins this container; content outside it would scroll under the pinned input row.
    assert.match(html, /<div class="chat-composer-editor"><div class="fixture-editor"><div class="fixture-status" role="status">Recording<\/div><div class="chat-input ck-input-row">/);
    assert.equal((html.match(/chat-composer-editor/g) ?? []).length, 1);
  }
});

test('the module owns the full draft list directly above the editor without a host list or plumbing wrapper', async t => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  assert.doesNotMatch(f.render(), /fixture-list|fixture-row|draft-attachments|module-composer/);
  appendFixture(f.field, fixtureItem('Ready'));
  f.draft.edit('Message');
  const release = f.context.state.bindDraft(f.draft.reference).block('Module work pending');
  const html = f.render();
  assert.match(html, /fixture-list/);
  assert.equal((html.match(/fixture-row/g) ?? []).length, 1);
  assert.doesNotMatch(html, /draft-attachments|draft-attachment"|module-draft-recovery|module-composer|chat-input-notice/);
  assert.match(html, /<\/section><\/div><div class="chat-composer-editor"><div class="chat-input ck-input-row">/);
  assert.match(html, /<div class="chat-input ck-input-row"><button type="button" aria-label="Add item">Add item<\/button><textarea/);
  assert.equal((html.match(/<textarea\b/g) ?? []).length, 1);
  assert.equal((html.match(/class="chat-input-btn send ck-icon-button"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  assert.match(html, /class="chat-input-btn send ck-icon-button" disabled=""/);
  assert.match(html, /title="Module work pending"/);
  assert.equal(await f.draft.send(async () => assert.fail('Active module blocker')), false);
  release();
  assert.doesNotMatch(f.render(), /class="chat-input-btn send ck-icon-button" disabled=""/);
});

test('module loss removes field UI/blockers but blocks text-only sends until retained schema data is restored', async t => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  t.mock.method(console, 'error', () => {});
  appendFixture(f.field, fixtureItem('Ready'));
  f.draft.edit('Ordinary text');
  f.context.state.bindDraft(f.draft.reference).block('Interrupted work');
  f.runtime.unregister(f.runtime.getSnapshot()[0]);
  const html = f.render();
  assert.doesNotMatch(html, /Ready|Add item|fixture-list|draft-attachments|module-draft-recovery|移除未完成|不接受附件/);
  assert.match(html, /<textarea[^>]*>Ordinary text<\/textarea>/);
  assert.equal(f.draft.getSnapshot().blocks.length, 0);
  assert.equal(f.draft.hasUnclaimedStoredData(), true);
  let dispatched = 0;
  assert.equal(await f.draft.send(async () => { dispatched++; return true; }), false);
  assert.equal(dispatched, 0, 'revoked fields must not become an incomplete native send');
  assert.equal(f.draft.getSnapshot().text, 'Ordinary text');
  assert.deepEqual(f.field.getSnapshot().items, [fixtureItem('Ready')]);
  f.runtime.stop();
  await f.runtime.start();
  assert.match(f.render(), /Ready/);
  assert.equal(f.draft.hasUnclaimedStoredData(), false);
  assert.equal(await f.draft.send(async request => {
    assert.deepEqual(request.body, {
      sessionId: 'fixture', text: 'Ordinary text', attachments: [fixtureItem('Ready').value],
    });
    return true;
  }), true);
  assert.equal(f.draft.getSnapshot().text, '');
  assert.doesNotMatch(f.render(), /fixture-list/);
});

test('a request-scoped answer hides the prompt schema without moving or clearing prompt state', async t => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  appendFixture(f.field, fixtureItem('Cached item'));
  f.draft.edit('Cached prompt');
  const answer = new SessionDraft(f.draft.sessionId, undefined, { kind: 'ask', requestId: 'request' });
  const html = f.render(answer);
  assert.equal(f.handle.forDraft(answer.reference), undefined);
  assert.match(html, /Question/);
  assert.doesNotMatch(html, /Cached item|Cached prompt|Add item|fixture-list|不接受附件/);
  assert.match(html, /<textarea[^>]*><\/textarea>/);
  assert.equal(f.draft.getSnapshot().text, 'Cached prompt');
  assert.equal(f.field.getSnapshot().items.length, 1);
  assert.match(f.render(), /Cached item/);
});

test('pending native submission disables module controls but keeps the core editor editable until receipt', async t => {
  const f = await fixture();
  t.after(() => f.runtime.stop());
  appendFixture(f.field, fixtureItem('Ready'));
  let finish!: (sent: boolean) => void;
  const sending = f.draft.send(() => new Promise(resolve => { finish = resolve; }));
  const html = f.render();
  for (const label of ['Add item', 'Remove Ready']) {
    assert.match(html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '', /disabled=""/);
  }
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)?.[0] ?? '', /disabled/);
  finish(false);
  await sending;
  for (const label of ['Add item', 'Remove Ready']) {
    assert.doesNotMatch(f.render().match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '', /disabled/);
  }
});
