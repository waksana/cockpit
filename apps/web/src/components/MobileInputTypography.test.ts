import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compile } from 'sass';

test('classic editable controls share a touch font floor without enlarging desktop controls', () => {
  const css = compile(new URL('../styles/index.scss', import.meta.url).pathname).css;
  assert.match(css, /:root \{[^}]*--ck-input-font-min: 0px;/);
  assert.match(css, /@media \(any-pointer: coarse\) \{\s*:root \{\s*--ck-input-font-min: 16px;/);
  assert.match(css, /:where\(\.ck-input\) \{[^}]*font-size: max\(var\(--ck-input-font-min\), var\(--host-text-body\)\);/);
  assert.match(css, /\.chat-input-message \{[^}]*font-size: max\(var\(--ck-input-font-min\), var\(--chat-text-body\)\);/);
  assert.match(css, /\.ck-input-hint \{[^}]*font-size: max\(var\(--ck-input-font-min\), var\(--messages-text-size\)\);/);
  assert.match(css, /:where\(\.ck-button, \.ck-icon-button\) \{[^}]*font-size: var\(--host-text-body\);/);
});

test('both document entries retain native user zoom instead of restricting the viewport', () => {
  for (const path of ['../../index.html', '../../next/index.html']) {
    const html = readFileSync(new URL(path, import.meta.url), 'utf8');
    const viewport = html.match(/<meta name="viewport"[^>]+>/)?.[0];
    assert.ok(viewport, path);
    assert.match(viewport, /width=device-width/);
    assert.doesNotMatch(viewport, /user-scalable|maximum-scale|minimum-scale/);
  }
});
