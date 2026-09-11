import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnedModuleLifecycle } from './consumer-control.ts';

test('server-owned module lifecycle is an exact opt-in and cannot impersonate consumer authority', () => {
  assert.equal(createOwnedModuleLifecycle('http://127.0.0.1:8771', {}), undefined);
  assert.throws(() => createOwnedModuleLifecycle('http://127.0.0.1:8771', {
    COCKPIT_MANAGED_MODULES: 'true',
  }), /exactly 1/);
  assert.throws(() => createOwnedModuleLifecycle('http://127.0.0.1:8771', {
    COCKPIT_MANAGED_MODULES: '1',
    COCKPIT_CONSUMER_INSTALLATION: '11111111-1111-4111-8111-111111111111',
  }), /cannot be enabled together/);
  const lifecycle = createOwnedModuleLifecycle('http://127.0.0.1:8771', {
    COCKPIT_MANAGED_MODULES: '1',
    COCKPIT_USER_ROOT: process.cwd(),
  });
  assert.ok(lifecycle);
  assert.equal(lifecycle.status().state, 'fresh');
});
