import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComposerFileSelection, ComposerOperation } from '@cockpit/module-api';
import { pickComposerFiles } from './composerFiles';
import { ModuleRuntime } from './moduleRuntime';
import { createSessionDrafts } from './textDraft';

class Picker extends EventTarget {
  type = '';
  multiple = false;
  value = 'selected';
  files: File[] = [];
  clicks = 0;
  click() { this.clicks++; }
}
function fixture() {
  const inputs: Picker[] = [];
  const reports: unknown[] = [];
  const runtime = new ModuleRuntime({ report: error => reports.push(error) });
  const page = { createElement(tag: string) {
    assert.equal(tag, 'input');
    const input = new Picker();
    inputs.push(input);
    return input;
  } } as unknown as Document;
  return { inputs, reports, runtime, page };
}

test('native picker captures draft, operation and callback before session changes and dispatches once', () => {
  const f = fixture();
  const drafts = createSessionDrafts(), a = drafts('A'), b = drafts('B');
  const owned = a.bindModule('files', ['attachments']);
  const target = { draft: a.reference, operation: 'prompt' as ComposerOperation, disabled: false };
  const selections: ComposerFileSelection[] = [];
  pickComposerFiles(f.runtime, target, selection => {
    selections.push(selection);
    owned.draft.block(`Selected ${selection.files[0].name}`);
    return true;
  }, f.page);
  assert.equal(f.inputs[0].type, 'file');
  assert.equal(f.inputs[0].multiple, true);
  assert.equal(f.inputs[0].clicks, 1);
  target.draft = b.reference;
  target.operation = 'ask';
  target.disabled = true;
  f.inputs[0].files = [new File(['x'], 'captured.txt')];
  f.inputs[0].dispatchEvent(new Event('change'));
  f.inputs[0].dispatchEvent(new Event('change'));
  assert.equal(selections.length, 1);
  assert.equal(selections[0].target.draft, a.reference);
  assert.equal(selections[0].target.operation, 'prompt');
  assert.equal(selections[0].target.disabled, false);
  assert.equal(selections[0].source, 'picker');
  assert.ok(Object.isFrozen(selections[0].files));
  assert.equal(f.inputs[0].value, '');
  assert.equal(a.getSnapshot().blocks.length, 1);
  assert.equal(b.getSnapshot().blocks.length, 0);
  owned.dispose();
});

test('cancelled/empty pickers do not submit selections and unavailable controls do not open a picker', async () => {
  const f = fixture();
  const draft = createSessionDrafts()('A');
  const target = { draft: draft.reference, operation: 'prompt' as const, disabled: false };
  const receive = () => assert.fail('No selected files');
  pickComposerFiles(f.runtime, target, receive, f.page);
  f.inputs[0].dispatchEvent(new Event('cancel'));
  f.inputs[0].files = [new File(['x'], 'late.txt')];
  f.inputs[0].dispatchEvent(new Event('change'));
  pickComposerFiles(f.runtime, target, receive, f.page);
  f.inputs[1].dispatchEvent(new Event('change'));
  pickComposerFiles(f.runtime, { ...target, disabled: true }, receive, f.page);
  pickComposerFiles(f.runtime, { ...target, operation: 'ask' }, receive, f.page);
  draft.edit('Sending');
  let finish!: (value: boolean) => void;
  const sending = draft.send(() => new Promise(resolve => { finish = resolve; }));
  pickComposerFiles(f.runtime, target, receive, f.page);
  assert.equal(f.inputs.length, 2);
  assert.equal(draft.getSnapshot().blocks.length, 0);
  finish(false);
  await sending;
});

for (const acknowledged of [true, false]) {
  test(`picker completion during native send retains selected files as recovery after ACK=${acknowledged}`, async () => {
    const f = fixture();
    const draft = createSessionDrafts()('race');
    draft.edit('Original');
    const target = { draft: draft.reference, operation: 'prompt' as const, disabled: false };
    pickComposerFiles(f.runtime, target, () => assert.fail('Pending native operation must not call a module'), f.page);
    let finish!: (value: boolean) => void;
    const sending = draft.send(() => new Promise(resolve => { finish = resolve; }));
    draft.edit('New revision');
    f.inputs[0].files = [new File(['x'], 'not-lost.txt')];
    f.inputs[0].dispatchEvent(new Event('change'));
    finish(acknowledged);
    assert.equal(await sending, acknowledged);
    assert.equal(draft.getSnapshot().text, 'New revision');
    assert.equal(draft.getSnapshot().unconfirmed, !acknowledged);
    assert.equal(draft.getSnapshot().blocks[0].orphaned, true);
    assert.match(draft.getSnapshot().blocks[0].reason, /not-lost.txt/);
    assert.equal(await draft.send(async () => assert.fail('Recovery blocks the next submitted draft')), false);
    draft.dismissOrphanedBlock(draft.getSnapshot().blocks[0].id);
    assert.equal(await draft.send(async () => true), true);
  });
}

test('a picker outliving module disposal retains its selected filename and cannot mutate the revoked draft scope', async () => {
  const f = fixture();
  const draft = createSessionDrafts()('revoked');
  const binding = draft.bindModule('files', ['attachments']);
  pickComposerFiles(f.runtime, { draft: draft.reference, operation: 'prompt', disabled: false }, () => {
    binding.draft.block('Upload');
    return true;
  }, f.page);
  binding.dispose();
  f.inputs[0].files = [new File(['x'], 'after-stop.txt')];
  f.inputs[0].dispatchEvent(new Event('change'));
  assert.equal(draft.getSnapshot().attachments.length, 0);
  assert.match(draft.getSnapshot().blocks[0].reason, /after-stop.txt/);
  assert.equal(draft.getSnapshot().blocks[0].orphaned, true);
  assert.equal(await draft.send(async () => assert.fail('Stopped upload cannot disappear')), false);
});
