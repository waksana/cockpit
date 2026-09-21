import strict from 'node:assert/strict';
import { test } from 'node:test';
import assert, { assertIdentityList } from './identityAssert';

test('identity failures never inspect DOM-like graphs or invoke their getters', () => {
  const node = Object.defineProperty({}, 'react', { enumerable: true, get() { strict.fail('must not inspect'); } });
  const other = { child: node };
  assert.equal(node, node);
  assert.notEqual(node, other);
  strict.throws(() => assert.equal(node, other, 'wrong focus'), { message: 'wrong focus\n\nfalse !== true\n' });
  strict.throws(() => assert.notEqual(node, node), strict.AssertionError);
  strict.throws(() => assertIdentityList([node], [other]), strict.AssertionError);
  strict.throws(() => assert.equal(node, null), strict.AssertionError);
  strict.throws(() => assert.equal('BODY', 'BUTTON'), strict.AssertionError);
  assert.equal(NaN, NaN);
  assert.notEqual(-0, 0);
});
