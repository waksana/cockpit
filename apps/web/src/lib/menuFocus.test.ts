import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuFocusTarget } from './menuFocus';

const settings = { label: 'Settings' };
const rename = { label: 'Rename' };

test('first visible menu focuses the first enabled item, or its container when none is enabled', () => {
  assert.equal(menuFocusTarget(false, null, [settings, rename]), settings);
  assert.equal(menuFocusTarget(false, null, []), null);
});

test('new item arrays and position changes preserve an initialized keyboard selection', () => {
  for (const update of ['unrelated B status', 'unrelated B title', 'position']) {
    assert.equal(menuFocusTarget(true, rename, [settings, rename]), undefined, update);
  }
  assert.equal(menuFocusTarget(true, settings, [rename, settings]), undefined);
});

test('removed or disabled focused item falls back to the first enabled item', () => {
  assert.equal(menuFocusTarget(true, rename, [settings]), settings);
  assert.equal(menuFocusTarget(true, rename, []), null);
});

test('an initialized menu does not steal focus when no menu item was focused', () => {
  assert.equal(menuFocusTarget(true, null, [settings, rename]), undefined);
});
