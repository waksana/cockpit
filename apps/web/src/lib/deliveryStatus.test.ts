import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryAttention, deliveryStateLabels, waitingLabel } from './deliveryStatus';

test('status labels distinguish build, native drain and startup without using restart as a version', () => {
  assert.notEqual(deliveryStateLabels.building, deliveryStateLabels['waiting-idle']);
  assert.notEqual(deliveryStateLabels.verifying, deliveryStateLabels.succeeded);
  assert.match(waitingLabel('weixin-unknown-paused')!, /不会启动或重发/);
  assert.equal(deliveryAttention(null), false);
  assert.equal(deliveryAttention({ projects: [] }), false);
});
