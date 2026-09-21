import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { nextUi } from './ui';

test('the compiled shared theme styles actual Radix states and independent touch targets', async () => {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    plugins: [tailwindcss()],
    build: {
      write: false,
      cssMinify: false,
      rolldownOptions: {
        input: fileURLToPath(new URL('../../../../packages/ui/src/styles/theme.css', import.meta.url)),
      },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const css = bundles.flatMap(bundle => {
    assert.ok('output' in bundle);
    return bundle.output;
  }).flatMap(output => output.type === 'asset' && output.fileName.endsWith('.css')
    ? [typeof output.source === 'string' ? output.source : new TextDecoder().decode(output.source)]
    : []).join('\n');

  const checked = renderToStaticMarkup(React.createElement(nextUi.Switch, { checked: true }));
  const unchecked = renderToStaticMarkup(React.createElement(nextUi.Switch, { checked: false }));
  assert.match(checked, /data-state="checked"/);
  assert.match(unchecked, /data-state="unchecked"/);
  assert.match(css, /\.data-checked\\:bg-primary:where\(\[data-state="checked"\][^{]*\{\s*background-color:/);
  assert.match(css, /\.data-unchecked\\:bg-input:where\(\[data-state="unchecked"\][^{]*\{\s*background-color:/);
  assert.match(css, /\.data-horizontal\\:h-px:where\(\[data-orientation="horizontal"\]\)\s*\{\s*height: 1px/);
  assert.match(css, /\.data-open\\:animate-in:where\(\[data-state="open"\]/);

  // Build output is formatted: this must be a root media rule, not nested under reduced motion.
  assert.match(css, /^@media \(pointer: coarse\) \{[\s\S]*?\[data-slot=(?:"checkbox"|checkbox)\]:after/m);
  assert.match(css, /\.pointer-coarse\\:min-h-11\s*\{\s*min-height:/);
  assert.match(css, /\.pointer-coarse\\:min-w-11\s*\{\s*min-width:/);
});
