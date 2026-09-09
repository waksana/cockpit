// heap-config.test.mjs — covers the COCKPIT_MAX_OLD_SPACE_MB resolver: default,
// override, and strict positive-integer validation (invalid values must throw,
// never silently fall back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEAP_ENV_VAR,
  resolveMaxOldSpaceMb,
  buildServerNodeArgs,
} from './heap-config.mjs';

test('default: unset uses Node memory sizing', () => {
  assert.equal(resolveMaxOldSpaceMb({}), undefined);
});

test('default: empty / whitespace-only → default (treated as unset)', () => {
  assert.equal(resolveMaxOldSpaceMb({ [HEAP_ENV_VAR]: '' }), undefined);
  assert.equal(resolveMaxOldSpaceMb({ [HEAP_ENV_VAR]: '   ' }), undefined);
});

test('override: valid positive integer wins', () => {
  assert.equal(resolveMaxOldSpaceMb({ [HEAP_ENV_VAR]: '16384' }), 16384);
  assert.equal(resolveMaxOldSpaceMb({ [HEAP_ENV_VAR]: '1' }), 1);
  // surrounding whitespace is tolerated and trimmed
  assert.equal(resolveMaxOldSpaceMb({ [HEAP_ENV_VAR]: '  12288  ' }), 12288);
});

test('invalid: throws, never silently falls back', () => {
  for (const bad of ['abc', '-1', '0', '3.5', '8192MB', '0x1000', '1e3', '1_000', '+8', '  ', 'NaN']) {
    // note: '  ' (whitespace-only) is handled by the default test above, exclude here
    if (bad.trim() === '') continue;
    assert.throws(
      () => resolveMaxOldSpaceMb({ [HEAP_ENV_VAR]: bad }),
      /must be a positive integer|out of range/,
      `expected "${bad}" to throw`,
    );
  }
});

test('invalid: unsafe-huge integer rejected as out of range', () => {
  assert.throws(
    () => resolveMaxOldSpaceMb({ [HEAP_ENV_VAR]: '99999999999999999999' }),
    /out of range/,
  );
});

test('buildServerNodeArgs: default and override flags', () => {
  assert.deepEqual(buildServerNodeArgs({}), [
    '--import',
    'tsx',
    'src/index.ts',
  ]);
  assert.deepEqual(buildServerNodeArgs({ [HEAP_ENV_VAR]: '4096' }), [
    '--max-old-space-size=4096',
    '--import',
    'tsx',
    'src/index.ts',
  ]);
});

test('buildServerNodeArgs: invalid override propagates the throw', () => {
  assert.throws(() => buildServerNodeArgs({ [HEAP_ENV_VAR]: 'lots' }), /positive integer/);
});
