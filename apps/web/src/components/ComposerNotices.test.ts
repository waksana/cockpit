import { act, fireEvent, render } from '../test/dom';
import assert from '../test/identityAssert';
import { test } from 'node:test';
import { createElement } from 'react';
import type { DraftSchemaHandle, LegacyModuleFrontendContext, ModuleFrontendContext } from '@cockpit/module-api/frontend';
import { ComposerNotices } from './Composer';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { SessionDraft } from '../lib/textDraft';
import { appendFixture, fixtureItem, fixtureSchema, memoryDraftStorage, type FixtureData } from '../test/draftFixture';

async function fixture(version: 2 | 3) {
  const memory = memoryDraftStorage(), errors: unknown[] = [];
  const draft = new SessionDraft(`notice-v${version}`, memory.storage, undefined, undefined, error => errors.push(error));
  let field!: DraftSchemaHandle<FixtureData>, fail = true, acknowledgements = 0, sends = 0;
  const digest = 'e'.repeat(64);
  const activate = <Version extends 2 | 3>(context: ModuleFrontendContext | LegacyModuleFrontendContext, apiVersion: Version) => {
    field = context.state.registerDraft(fixtureSchema({
      acknowledge: (current, captured) => {
        acknowledgements++;
        if (fail) throw new Error('Local ACK failed');
        return { items: current.items.filter(item => version === 2 ? !captured.items.includes(item)
          : !captured.items.some(capturedItem => capturedItem.id === item.id)) };
      },
    }));
    return { apiVersion };
  };
  const runtime = new ModuleRuntime({
    pageUrl: 'https://fixture.invalid/',
    fetch: async () => Response.json({ errors: [], modules: [{
      id: 'files', name: 'Files', version: '1.0.0', digest, styles: [], config: {},
      apiBase: `/_modules/files/${digest}/api`, entry: `/_modules/assets/files/${digest}/entry.js`,
    }] }),
    load: async () => version === 3
      ? { frontendApiVersion: 3, activate: (context: ModuleFrontendContext) => activate(context, 3) }
      : { activate: (context: LegacyModuleFrontendContext) => activate(context, 2) },
    report: error => errors.push(error),
  });
  await runtime.start();
  runtime.prepareDraft(draft);
  const scope = field.forDraft(draft.reference)!;
  const seed = () => {
    draft.edit('Native content');
    appendFixture(scope, fixtureItem('one'));
  };
  return {
    runtime, draft, scope, errors, seed, acknowledge: () => { fail = false; },
    fail: () => { fail = true; }, acknowledgements: () => acknowledgements, sends: () => sends,
    send: (accepted = true) => draft.send(async () => { sends++; return accepted; }),
  };
}

test('accepted native submission offers explicit local confirmation without dismissal or resend', async t => {
  const f = await fixture(3);
  t.after(() => f.runtime.stop());
  f.seed();
  assert.equal(await f.send(), false);
  assert.equal(f.draft.hasAcceptedSubmission(), true);
  const view = render(createElement(ComposerNotices, { draft: f.draft }));
  assert.match(view.container.textContent!, /提交已确认.*不会再次发送/);
  assert.equal(view.queryByLabelText('关闭发送提示'), null);
  f.draft.dismissNotice();
  assert.equal(f.draft.getSnapshot().unconfirmed, true);
  assert.match(String(f.errors.at(-1)), /reconciliation/);
  f.acknowledge();
  await act(async () => { fireEvent.click(view.getByRole('button', { name: '完成草稿确认' })); });
  assert.equal(f.sends(), 1);
  assert.equal(f.acknowledgements(), 2);
  assert.equal(f.scope.getSnapshot().items.length, 0);
  assert.equal(f.draft.getSnapshot().text, '');
  assert.equal(view.queryByRole('alert'), null);
});

test('runtime preserves legacy live ACK but blocks recovered legacy object-identity ACK', async t => {
  const f = await fixture(2);
  t.after(() => f.runtime.stop());
  f.acknowledge();
  f.seed();
  assert.equal(await f.send(), true);
  assert.equal(f.scope.getSnapshot().items.length, 0, 'live v2 ACK receives the original captured objects');
  assert.equal(f.acknowledgements(), 1);
  f.fail();
  f.seed();
  assert.equal(await f.send(), false);
  const view = render(createElement(ComposerNotices, { draft: f.draft }));
  f.acknowledge();
  await act(async () => { fireEvent.click(view.getByRole('button', { name: '完成草稿确认' })); });
  assert.equal(f.acknowledgements(), 2, 'recovered v2 callback is never invoked');
  assert.equal(f.sends(), 2);
  assert.equal(f.scope.getSnapshot().items.length, 1);
  assert.equal(f.draft.hasAcceptedSubmission(), true);
  assert.match(String(f.errors.at(-1)), /Legacy draft schemas do not authorize restored submission ACK/);
  assert.ok(view.getByRole('button', { name: '完成草稿确认' }));
  assert.equal(view.queryByLabelText('关闭发送提示'), null);
});

test('unknown native outcome keeps the existing dismissible notice without a recovery-send action', async t => {
  const f = await fixture(3);
  t.after(() => f.runtime.stop());
  f.seed();
  assert.equal(await f.send(false), false);
  assert.equal(f.draft.hasAcceptedSubmission(), false);
  const view = render(createElement(ComposerNotices, { draft: f.draft }));
  assert.equal(view.queryByRole('button', { name: '完成草稿确认' }), null);
  fireEvent.click(view.getByLabelText('关闭发送提示'));
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(f.sends(), 1);
  assert.equal(f.acknowledgements(), 0);
});
