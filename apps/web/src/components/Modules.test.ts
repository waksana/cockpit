import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('module controls separate explicit signed checks, installation, actual services and pinned session application', () => {
  const source = readFileSync(new URL('./Modules.tsx', import.meta.url), 'utf8')
    + readFileSync(new URL('./ModuleMutationControls.tsx', import.meta.url), 'utf8');
  assert.match(source, /modules\/updates\/check/);
  assert.match(source, /modules\/updates\/install/);
  assert.match(source, /sha256: target.sha256/);
  assert.match(source, /module.service.version/);
  assert.match(source, /binding.selections/);
  assert.match(source, /binding.pendingSelections/);
  assert.match(source, /operationId: binding.operationId/);
  assert.doesNotMatch(source, /setInterval|schedule\/add|session\/new|sendPrompt/);
});

test('new-session picker shows unavailable binding reasons and never silently changes roles with a new cwd', () => {
  const source = readFileSync(new URL('./DirPicker.tsx', import.meta.url), 'utf8');
  assert.match(source, /role.boundSessionId/);
  assert.match(source, /role.reason/);
  assert.match(source, /disabled=\{!role.available && !checked\}/);
  assert.match(source, /selected.every/);
  assert.match(source, /version: module.selectedVersion/);
  assert.match(source, /await onCreate\(path, selected\)/);
  assert.match(source, /onCreated\(sessionId\)/);
  assert.doesNotMatch(source, /session\/start|creation\.draft|onStart|<Composer/);
});
