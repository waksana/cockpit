import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryAttention, deliveryStateLabels, waitingLabel } from './deliveryStatus';

test('status labels distinguish build, native drain and startup without using restart as a version', () => {
  assert.notEqual(deliveryStateLabels.building, deliveryStateLabels['waiting-idle']);
  assert.notEqual(deliveryStateLabels.verifying, deliveryStateLabels.succeeded);
  assert.equal(waitingLabel('external-unknown'), 'external-unknown');
  assert.equal(deliveryAttention(null), false);
  assert.equal(deliveryAttention({ projects: [] }), false);
});
