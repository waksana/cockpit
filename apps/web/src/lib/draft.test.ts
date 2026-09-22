import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeDraftRequest } from './draft';
import { SessionDraft } from './textDraft';
import { DraftCache } from './draftSelection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('acknowledgement is strict: undefined is not successful', async () => {
  assert.equal(await new SessionDraft('session').runAction(() => undefined), false);
});

for (const kind of ['prompt', 'ask', 'plan'] as const) for (const accepted of [true, false]) {
  test(`${kind} dispatch uses its immutable draft purpose and acknowledges ${accepted} once`, async () => {
    const draft = new SessionDraft('session', undefined, kind === 'prompt' ? { kind } : { kind, requestId: `${kind}-id` });
    draft.edit('message');
    const post = deferred<boolean>();
    let calls = 0, settled = false;
    const sending = draft.send(request => {
      calls++;
      assert.deepEqual(request, kind === 'ask'
        ? { intent: 'respondAsk', body: { sessionId: 'session', requestId: 'ask-id', answer: 'message', wasFreeform: true } }
        : kind === 'plan' ? { intent: 'planSupersede', body: { sessionId: 'session', requestId: 'plan-id', message: 'message' } }
          : { intent: 'prompt', body: { sessionId: 'session', text: 'message' } });
      return post.promise;
    }).then(value => { settled = true; return value; });
    await Promise.resolve();
    assert.equal(settled, false);
    post.resolve(accepted);
    assert.equal(await sending, accepted);
    assert.equal(calls, 1);
  });
}

test('ask takes precedence over plan without borrowing prompt fields or falling back after a failed answer', async () => {
  const session = new DraftCache().session('A');
  const decisions = { ask: { requestId: 'ask' }, planRequest: { requestId: 'plan' } };
  session.synchronize(decisions);
  const answer = session.current(decisions);
  answer.edit('Answer');
  const routes: string[] = [];
  assert.equal(await answer.send(async request => { routes.push(request.intent); return false; }), false);
  assert.deepEqual(routes, ['respondAsk']);
});

test('unsupported decision text and unknown route fields fail rather than becoming a normal prompt', () => {
  const elicitation = new SessionDraft('A', undefined, { kind: 'elicitation', requestId: 'tool' });
  assert.throws(() => nativeDraftRequest(elicitation.reference, 'text', {}), /does not accept/);
  for (const kind of ['ask', 'plan'] as const) {
    const draft = new SessionDraft('A', undefined, { kind, requestId: 'request' });
    assert.throws(() => nativeDraftRequest(draft.reference, 'text', { unexpected: 'field' }));
  }
});

test('SDK attachments remain native transport fields, never base draft state or decision payloads', () => {
  const fields = { attachments: [{ type: 'file' as const, path: '/fixture/native' }] };
  const prompt = new SessionDraft('A');
  assert.deepEqual(nativeDraftRequest(prompt.reference, '', fields), {
    intent: 'prompt', body: { sessionId: 'A', text: '', attachments: fields.attachments },
  });
  for (const kind of ['ask', 'plan'] as const) {
    const draft = new SessionDraft('A', undefined, { kind, requestId: 'request' });
    assert.throws(() => nativeDraftRequest(draft.reference, 'text', fields));
  }
  assert.throws(() => nativeDraftRequest(prompt.reference, 'text', { mode: 'immediate' } as never), /overwrite/);
});
