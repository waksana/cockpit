import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeLocalSubmissions } from './localSubmission';
import { SessionDraft } from './textDraft';

for (const surface of ['draft', 'decision'] as const) {
  for (const outcome of ['accepted', 'failed', 'unknown', 'rejected'] as const) {
    test(`${surface} only notifies its local view on a strict native ACK: ${outcome}`, async t => {
      const draft = new SessionDraft('A', undefined, { kind: 'prompt' }, undefined, () => {});
      let accepted = 0, unrelated = 0;
      t.after(observeLocalSubmissions('A', () => { accepted++; }));
      t.after(observeLocalSubmissions('B', () => { unrelated++; }));
      draft.edit('Local text');
      assert.equal(accepted, 0, 'editing alone is not a submission');
      const send = async () => {
        if (outcome === 'rejected') throw new Error('Synthetic unknown transport result');
        return outcome === 'unknown' ? undefined as unknown as boolean : outcome === 'accepted';
      };
      assert.equal(await (surface === 'draft' ? draft.send(send) : draft.runAction(send)), outcome === 'accepted');
      assert.equal(accepted, outcome === 'accepted' ? 1 : 0);
      assert.equal(unrelated, 0);
    });
  }
}

for (const change of ['unmount', 'switch', 'return', 'background'] as const) {
  test(`late local ACK cannot target a replacement view: ${change}`, async t => {
    const draft = new SessionDraft('A');
    draft.edit('Original target');
    let finish!: (ok: boolean) => void;
    let original = 0, replacement = 0, unrelated = 0;
    const leave = observeLocalSubmissions('A', () => { original++; });
    t.after(leave);
    if (change === 'background') leave();
    const pending = draft.send(() => new Promise(resolve => { finish = resolve; }));
    leave();
    if (change !== 'unmount') t.after(observeLocalSubmissions('B', () => { unrelated++; }));
    if (change === 'return' || change === 'background') {
      t.after(observeLocalSubmissions('A', () => { replacement++; }));
    }
    finish(true);
    assert.equal(await pending, true, 'view loss does not cancel or redirect native submission');
    assert.deepEqual([original, replacement, unrelated], [0, 0, 0]);
  });
}

test('known native success still notifies when local draft settlement fails', async t => {
  let accepted = 0;
  t.after(observeLocalSubmissions('settlement', () => { accepted++; }));
  const draft = new SessionDraft('settlement', undefined, { kind: 'prompt' }, undefined, () => {});
  draft.edit('Local text');
  assert.equal(await draft.send(async () => {
    draft.retire();
    return true;
  }), false);
  assert.equal(accepted, 1, 'local cleanup must not erase the known native side effect');
});
