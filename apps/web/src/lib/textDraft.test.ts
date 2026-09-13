import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionDrafts } from './textDraft';

function fixture() {
  const values = new Map<string, string>();
  const drafts = createSessionDrafts({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  });
  return { values, drafts };
}

test('text drafts preserve old rich data and never import or overwrite its state', async () => {
  const { values, drafts } = fixture();
  const old = '{"version":1,"text":"old","attachment":{"url":"/uploads/retained"}}';
  values.set('cockpit:composer:A', old);
  const draft = drafts('A');
  assert.equal(draft.getSnapshot().text, '');
  draft.edit('Native text');
  assert.equal(await draft.send(async text => { assert.equal(text, 'Native text'); return true; }), true);
  assert.equal(values.get('cockpit:composer:A'), old);
  assert.equal(draft.getSnapshot().text, '');
});

test('a late native acknowledgement preserves newer edits and a different session draft', async () => {
  const { drafts } = fixture();
  const a = drafts('A'), b = drafts('B');
  a.edit('First');
  let acknowledge!: (accepted: boolean) => void;
  const pending = a.send(() => new Promise(resolve => { acknowledge = resolve; }));
  assert.equal(a.getSnapshot().pending, true);
  assert.equal(await a.send(async () => assert.fail('Concurrent send')), false);
  a.edit('Later');
  b.edit('Other session');
  acknowledge(true);
  assert.equal(await pending, true);
  assert.equal(a.getSnapshot().text, 'Later');
  assert.equal(b.getSnapshot().text, 'Other session');
  assert.equal(a.getSnapshot().pending, false);
});

test('unknown native submission retains text and never retries', async () => {
  const { drafts } = fixture();
  const draft = drafts('A');
  draft.edit('Keep this');
  let calls = 0;
  assert.equal(await draft.send(async () => { calls++; throw new Error('Unknown outcome'); }), false);
  assert.equal(calls, 1);
  assert.equal(draft.getSnapshot().text, 'Keep this');
  assert.ok(draft.getSnapshot().error);
});
