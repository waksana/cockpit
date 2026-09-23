import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, IconButton, RefreshButton } from './Button';

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

test('Button maps variants onto the public ck-* classes after the owner class', () => {
  assert.equal(render(createElement(Button, null, 'Plain')), '<button type="button" class="ck-button">Plain</button>');
  assert.equal(render(createElement(Button, { className: 'owner', variant: 'primary' }, 'Go')),
    '<button type="button" class="owner ck-button ck-primary">Go</button>');
  assert.equal(render(createElement(Button, { variant: 'primary', danger: true }, 'Delete')),
    '<button type="button" class="ck-button ck-primary ck-danger">Delete</button>');
  assert.equal(render(createElement(Button, { danger: true, type: 'submit', disabled: true }, 'Stop')),
    '<button type="submit" class="ck-button ck-danger" disabled="">Stop</button>');
});

test('IconButton always has an accessible name and a busy spinner at the same size', () => {
  const idle = render(createElement(IconButton, { icon: 'close', label: 'Close', iconSize: 16 }));
  assert.match(idle, /^<button type="button" class="ck-icon-button" aria-label="Close"><span class="ck-icon" data-icon="close"[^>]*style="width:16px;height:16px"/);
  assert.doesNotMatch(idle, /aria-busy/);
  const busy = render(createElement(IconButton, { icon: 'close', label: 'Close', iconSize: 16, busy: true, disabled: true }));
  assert.match(busy, /disabled="" aria-label="Close" aria-busy="true"><span class="ck-icon spinner" data-icon="loading"[^>]*width:16px;height:16px/);
  assert.match(render(createElement(IconButton, { icon: 'more', label: 'More', busy: false })), /aria-busy="false"><span class="ck-icon" data-icon="more"[^>]*width:24px;height:24px/);
});

test('RefreshButton is one 20px reload control whose availability stays with the owner', () => {
  const idle = render(createElement(RefreshButton, { onClick() {}, pending: false }));
  assert.match(idle, /^<button type="button" class="ck-icon-button" aria-label="刷新" aria-busy="false"><span class="ck-icon" data-icon="reload"[^>]*width:20px;height:20px/);
  assert.doesNotMatch(idle, /disabled/);
  const pending = render(createElement(RefreshButton, { onClick() {}, pending: true, label: '刷新目录', title: 'Reload' }));
  assert.match(pending, /title="Reload" aria-label="刷新目录" aria-busy="true"><span class="ck-icon spinner" data-icon="loading"[^>]*width:16px;height:16px/);
  assert.match(render(createElement(RefreshButton, { onClick() {}, pending: false, disabled: true })), /disabled=""/);
});

test('classic host sources no longer use the retired dialog-btn, primary or rp classes', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'next') walk(path); }
      else if (/\.(tsx|scss)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /className=\{?["'`][^"'`\n]*?(?<![\w-])(?:dialog-btn|rp|primary)(?![\w-])|\.(?:dialog-btn|rp)\b(?![\w-])/, file);
  }
});
