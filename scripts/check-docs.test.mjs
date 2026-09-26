import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkDocs } from './check-docs.mjs';
import { documentTargets } from './markdown.mjs';

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, files: Object.keys(files) };
}

test('Markdown headings use rendered text, Setext, Unicode and GitHub duplicate slugs', () => {
  const source = [
    '# A', '# A', '# A-1', '# A', 'Setext title', '============',
    '## **Strong** `code` &amp; <em>HTML</em> [link](https://example.invalid)',
    '## \u4e2d\u6587', "<a id='explicit' name='legacy'></a>",
  ].join('\n');
  assert.deepEqual([...documentTargets(source).anchors], [
    'a', 'a-1', 'a-1-1', 'a-2', 'setext-title', 'strong-code--html-link',
    '\u4e2d\u6587', 'explicit', 'legacy',
  ]);
});

test('real parser ignores fenced, indented, inline-code and commented examples', () => {
  const source = [
    '````md', '```', '[not a link](nope.md)', '```', '````',
    '    [indented](also-nope.md)', '',
    '`[inline](missing.md)` <!-- [comment](missing.md) -->',
    '[actual](<folder name/a(b).md>)', '[Reference][target]', '',
    '[target]: <other file.md#section> "Title"',
    "<img src='image.svg'><a href='doc.md?view=1&amp;x=2#id'>HTML</a>",
  ].join('\n');
  assert.deepEqual(documentTargets(source).links.map(link => link.target), [
    'folder name/a(b).md', 'other file.md#section', 'image.svg', 'doc.md?view=1&x=2#id',
  ]);
});

test('checks encoded paths, references, HTML, same-page and directory README anchors', t => {
  const f = fixture(t, {
    'README.md': '# Root\n',
    'docs/README.md': '# Contents\n',
    'docs/folder name/a(b).md': '# Section\n',
    'docs/source.md': [
      '# Source',
      '[local](folder%20name/a(b).md#section) [self](#source)',
      '[root](/README.md#root) [directory](.#contents) [parent](..#root)',
      '[ref][target]', '',
      '[target]: <folder name/a(b).md#section>',
      "<a href='folder%20name/a(b).md#section'>ok</a>",
      '[web](https://example.invalid/broken) [mail](mailto:user@example.invalid)',
    ].join('\n'),
  });
  assert.deepEqual(checkDocs(f.root, f.files), []);
});

test('reports missing targets, fragments, invalid encoding and escapes without reading outside root', t => {
  const f = fixture(t, {
    'docs/target.md': '# Target\n',
    'assets/icon.svg': '<svg></svg>',
    'docs/source.md': [
      '[gone](missing.md)',
      '[fragment](target.md?view=1#absent)',
      '[invalid](target.md#%FF)',
      '[escape](../../outside.md)',
      '[directory](../assets#absent)',
      '[ignored](../ignored.md)',
    ].join('\n'),
  });
  writeFileSync(join(f.root, 'ignored.md'), '# Ignored, but present on disk\n');
  assert.deepEqual(checkDocs(f.root, f.files), [
    'docs/source.md:1: missing tracked target docs/missing.md',
    'docs/source.md:2: missing anchor #absent in docs/target.md',
    'docs/source.md:3: invalid URL encoding in target.md#%FF',
    'docs/source.md:4: link leaves the repository: ../../outside.md',
    'docs/source.md:5: no Markdown README for #absent in assets',
    'docs/source.md:6: missing tracked target ignored.md',
  ]);
});

test('tracked repository Markdown has valid relative links and anchors', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.deepEqual(checkDocs(root), []);
});
