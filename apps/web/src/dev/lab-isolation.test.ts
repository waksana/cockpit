import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureStorage, isolateLab } from './lab-isolation';

test('pre-import isolation refuses application transports and never reads original browser storage', async () => {
  const memory = fixtureStorage();
  memory.setItem('fixture', 'value');
  assert.equal(memory.getItem('fixture'), 'value');
  assert.equal(memory.key(0), 'fixture');
  memory.clear();
  assert.equal(memory.length, 0);
  const target = {
    fetch: async () => 'live',
    XMLHttpRequest: class {},
    EventSource: class {},
    get localStorage(): Storage { throw new Error('Real local storage was read'); },
    get sessionStorage(): Storage { throw new Error('Real session storage was read'); },
  };
  isolateLab(target);
  await assert.rejects(target.fetch(), /transport is disabled/);
  assert.throws(() => new target.XMLHttpRequest(), /transport is disabled/);
  assert.throws(() => new target.EventSource(), /transport is disabled/);
  target.sessionStorage.setItem('fixture', 'memory-only');
  assert.equal(target.sessionStorage.getItem('fixture'), 'memory-only');
  assert.equal(target.localStorage.getItem('fixture'), null);
});
