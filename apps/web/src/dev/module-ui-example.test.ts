import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSessionDrafts } from '../lib/textDraft';
import { ModuleRuntime } from '../lib/moduleRuntime';
import { activate } from './module-ui-example';

test('the documented module example activates through the real host and renders named, disabled native controls', async () => {
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
  await runtime.start();
  assert.deepEqual(reports, []);
  const registered = runtime.contributions('composerActions')[0];
  assert.ok(registered);
  const draft = createSessionDrafts()('example');
  const Component = registered.contribution.component;
  const render = (disabled: boolean, operation: 'prompt' | 'ask' = 'prompt') =>
    renderToStaticMarkup(React.createElement(Component,
      runtime.context(registered.module, draft, operation, disabled)));
  assert.match(render(false), /class="ck-icon-button example-draft-action"/);
  assert.match(render(false), /aria-label="Append example text"/);
  assert.match(render(false), /viewBox="0 0 24 24" aria-hidden="true" focusable="false"/);
  assert.doesNotMatch(render(false), /disabled=""/);
  assert.match(render(true), /disabled=""/);
  assert.match(render(false, 'ask'), /disabled=""/);
  runtime.stop();
});
