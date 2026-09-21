import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile } from 'sass';
import { createAsyncCardFixture } from '../dev/initial-history-fixture';

test('public surface compositions own appearance without geometry, state or private ancestors', () => {
  const css = compile(new URL('../styles/primitives/surfaces.scss', import.meta.url).pathname).css;
  assert.match(css, /--ck-text-body: var\(--host-text-body\)/);
  assert.match(css, /--ck-radius-surface: var\(--host-radius-dialog\)/);
  assert.match(css, /:where\(\.ck-surface\) \{[^}]*padding: calc\(2 \* var\(--ck-space\)\);[^}]*border: 1px solid var\(--ck-color-border\)/);
  assert.match(css, /:where\(\.ck-heading\) \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /:where\(\.ck-actions\) \{[^}]*flex-wrap: wrap/);
  assert.match(css, /:where\(\.ck-badge\) \{[^}]*font-size: var\(--ck-text-meta\)/);
  assert.match(css, /\.ck-modal::backdrop/);
  assert.doesNotMatch(css, /position:|overflow: hidden|display: none|\.chat-|\.dialog-|\.info-|\.manage-/);
});

test('the maintained synthetic module consumes the real shared-surface capability', async t => {
  const runtime = createAsyncCardFixture();
  t.after(() => runtime.stop());
  await runtime.start();
  const loaded = runtime.getSnapshot();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].frontend.components?.[0].boundary, 'message');
});
