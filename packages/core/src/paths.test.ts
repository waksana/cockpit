// Unit tests for paths.ts — the COCKPIT_HOME state-root resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { cockpitHome } from './paths.ts';

test('host data defaults to synthetic HOME/.cockpit', t => {
  const home = process.env.HOME;
  process.env.HOME = resolve('.test-home-paths');
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  const prev = process.env.COCKPIT_HOME;
  delete process.env.COCKPIT_HOME;
  try {
    assert.equal(cockpitHome(), resolve('.test-home-paths/.cockpit'));
  } finally {
    if (prev === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = prev;
  }
});

test('COCKPIT_HOME relocates the host data root', () => {
  const prev = process.env.COCKPIT_HOME;
  process.env.COCKPIT_HOME = '/data/cockpit-home';
  try {
    assert.equal(cockpitHome(), '/data/cockpit-home');
  } finally {
    if (prev === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = prev;
  }
});

test('COCKPIT_HOME rejects empty and relative values instead of falling back', t => {
  const previous = process.env.COCKPIT_HOME;
  t.after(() => { if (previous === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = previous; });
  for (const value of ['', ' ', 'relative', '~/cockpit']) {
    process.env.COCKPIT_HOME = value;
    assert.throws(cockpitHome, /nonempty absolute/);
  }
});

test('cockpitHome is read at call time (not cached at import)', () => {
  const prev = process.env.COCKPIT_HOME;
  process.env.COCKPIT_HOME = '/first';
  assert.equal(cockpitHome(), '/first');
  process.env.COCKPIT_HOME = '/second';
  assert.equal(cockpitHome(), '/second');
  if (prev === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = prev;
});
