import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acknowledge, acknowledgeInView, sendThreadDraft } from './draft';
import type { DraftSendHandlers } from './draft';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const outcome of ['unchanged', 'scrolled', 'unmounted', 'failed'] as const) {
  test(`view acknowledgement only follows an unchanged live view: ${outcome}`, async () => {
    const scope = { active: true };
    const post = deferred<boolean>();
    let revision = 0;
    let pins = 0;
    const result = acknowledgeInView(scope, () => post.promise, {
      scrollRevision: () => revision,
      onAccepted: () => { pins++; },
    });
    if (outcome === 'scrolled') revision++;
    if (outcome === 'unmounted') scope.active = false;
    post.resolve(outcome !== 'failed');
    assert.equal(await result, outcome !== 'failed');
    assert.equal(pins, outcome === 'unchanged' ? 1 : 0);
  });
}

test('an inactive view never dispatches a late event', async () => {
  let calls = 0;
  assert.equal(await acknowledgeInView({ active: false }, async () => { calls++; return true; }, {
    scrollRevision: () => 0,
    onAccepted: () => { calls++; },
  }), false);
  assert.equal(calls, 0);
});

test('acknowledgement is strict: undefined is not successful', async () => {
  assert.equal(await acknowledge(() => undefined), false);
});

for (const kind of ['prompt', 'ask', 'plan'] as const) {
  for (const accepted of [true, false]) {
    test(`${kind} text wrapper propagates ${accepted} only after acknowledgement`, async () => {
      const post = deferred<boolean>();
      const calls: unknown[][] = [];
      const handlers: DraftSendHandlers = {
        onSend: (...args) => { calls.push(['prompt', ...args]); return post.promise; },
        onRespondAsk: (...args) => { calls.push(['ask', ...args]); return post.promise; },
        onPlanSupersede: (...args) => { calls.push(['plan', ...args]); return post.promise; },
      };
      if (kind === 'ask') handlers.askRequestId = 'ask-id';
      if (kind === 'plan') handlers.planRequestId = 'plan-id';
      let settled = false;
      const result = sendThreadDraft('message', handlers).then((ok) => { settled = true; return ok; });
      await Promise.resolve();
      assert.equal(settled, false);
      assert.deepEqual(calls, [kind === 'ask' ? ['ask', 'ask-id', 'message', true]
        : kind === 'plan' ? ['plan', 'plan-id', 'message'] : ['prompt', 'message']]);
      post.resolve(accepted);
      assert.equal(await result, accepted);
    });
  }
}

test('ask takes precedence over plan and never falls back after failure', async () => {
  const calls: string[] = [];
  assert.equal(await sendThreadDraft('answer', {
    askRequestId: 'ask',
    planRequestId: 'plan',
    onRespondAsk: async () => { calls.push('ask'); return false; },
    onPlanSupersede: async () => { calls.push('plan'); return true; },
    onSend: async () => { calls.push('prompt'); return true; },
  }), false);
  assert.deepEqual(calls, ['ask']);
});

test('missing ask or plan handlers return false without sending an unrelated prompt', async () => {
  let prompts = 0;
  const onSend = async () => { prompts++; return true; };
  assert.equal(await sendThreadDraft('text', { askRequestId: 'ask', onSend }), false);
  assert.equal(await sendThreadDraft('text', { planRequestId: 'plan', onSend }), false);
  assert.equal(await sendThreadDraft('text', {}), false);
  assert.equal(prompts, 0);
});

test('rejected ask and plan POSTs propagate failure without automatic retries', async () => {
  let calls = 0;
  const fail = async () => { calls++; throw new Error('uncertain POST'); };
  assert.equal(await sendThreadDraft('text', { askRequestId: 'ask', onRespondAsk: fail }), false);
  assert.equal(await sendThreadDraft('text', { planRequestId: 'plan', onPlanSupersede: fail }), false);
  assert.equal(calls, 2);
});
