// Unit tests for paths.ts — the COCKPIT_HOME state-root resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cockpitHome } from './paths.ts';

test('cockpitHome defaults to ~/.copilot when COCKPIT_HOME is unset', () => {
  const prev = process.env.COCKPIT_HOME;
  delete process.env.COCKPIT_HOME;
  try {
    assert.equal(cockpitHome(), join(homedir(), '.copilot'));
  } finally {
    if (prev === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = prev;
  }
});

test('COCKPIT_HOME relocates the whole state root', () => {
  const prev = process.env.COCKPIT_HOME;
  process.env.COCKPIT_HOME = '/data/cockpit-home';
  try {
    assert.equal(cockpitHome(), '/data/cockpit-home');
  } finally {
    if (prev === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = prev;
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
