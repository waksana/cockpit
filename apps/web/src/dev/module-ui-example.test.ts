import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSessionDrafts, SessionDraft } from '../lib/textDraft';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { activate } from './module-ui-example';
import { Composer } from '../components/Composer';

test('the documented module example extends the real editor and preserves named native controls', async t => {
  const digest = 'a'.repeat(64);
  const reports: unknown[] = [];
  const runtime = new ModuleRuntime({
    pageUrl: 'https://example.invalid',
    fetch: async () => Response.json({ modules: [{
      id: 'example', name: 'Example', version: '1.0.0', digest, config: {},
      apiBase: `/_modules/example/${digest}/api`,
      entry: `/_modules/assets/example/${digest}/index.js`, styles: [],
    }], errors: [] }),
    load: async () => ({ activate }), report: error => reports.push(error),
  });
  t.after(() => runtime.stop());
  await runtime.start();
  assert.deepEqual(reports, []);
  assert.equal(runtime.getSnapshot()[0].frontend.components?.[0].boundary, 'composerEditor');
  const draft = createSessionDrafts()('example');
  const answer = new SessionDraft('example', undefined, { kind: 'ask', requestId: 'example-ask' });
  const render = (disabled: boolean, operation: 'prompt' | 'ask' = 'prompt') =>
    renderToStaticMarkup(React.createElement(Composer, { draft: operation === 'prompt' ? draft : answer, runtime, disabled, onSend: async () => true }));
  assert.match(render(false), /class="ck-icon-button example-draft-action"/);
  assert.match(render(false), /aria-label="Append example text"/);
  assert.match(render(false), /viewBox="0 0 24 24" aria-hidden="true" focusable="false"/);
  assert.match(render(false), /<div class="chat-input ck-input-row"><button[^>]*example-draft-action/);
  assert.match(render(false), /<\/button><textarea[^>]*aria-label="消息输入"/);
  assert.equal((render(false).match(/<textarea\b/g) ?? []).length, 1);
  assert.equal((render(false).match(/class="chat-input-btn ck-icon-button send rp"/g) ?? []).length, 1);
  assert.doesNotMatch(render(false), /module-composer-actions|<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  assert.doesNotMatch(render(false).match(/<button[^>]+example-draft-action[^>]+>/)?.[0] ?? '', /disabled=""/);
  assert.match(render(true).match(/<button[^>]+example-draft-action[^>]+>/)?.[0] ?? '', /disabled=""/);
  assert.match(render(false, 'ask').match(/<button[^>]+example-draft-action[^>]+>/)?.[0] ?? '', /disabled=""/);
  draft.edit('Pending');
  let finish!: (value: boolean) => void;
  const sending = draft.send(() => new Promise(resolve => { finish = resolve; }));
  assert.match(render(false).match(/<button[^>]+example-draft-action[^>]+>/)?.[0] ?? '', /disabled=""/);
  assert.doesNotMatch(render(false).match(/<textarea[^>]*>/)?.[0] ?? '', /disabled/);
  finish(false);
  await sending;
  runtime.stop();
  assert.doesNotMatch(render(false), /example-draft-action/);
  assert.match(render(false), /<div class="chat-input ck-input-row"><textarea/);
  assert.match(render(false), /class="chat-input-btn ck-icon-button send rp" aria-label="发送"/);
});
