import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlIndicators } from './sessionControls';
import { controlDesignState, controlSession, controlScenes } from '../dev/control-design-state';

test('overall status leads the bar and is not suppressed by concrete activities', () => {
  for (const [scene] of controlScenes) {
    const model = controlDesignState(scene);
    const items = controlIndicators(controlSession(model), model, true);
    const session = controlSession(model);
    const waiting = !!(session.ask || session.planRequest || session.elicitation);
    assert.equal(items[0].key, 'overall');
    assert.equal(items[0].icon, scene === 'idle' ? 'radiooff' : waiting ? 'decision' : 'loading', scene);
    assert.equal(items.filter(item => item.icon === 'loading').length, scene === 'idle' || waiting ? 0 : 1);
  }
  const mixed = controlDesignState('ask');
  assert.deepEqual(controlIndicators(controlSession(mixed), mixed, true).map(item => [item.key, item.icon]),
    [['overall', 'decision'], ['agent', 'agent'], ['shell', 'shell'], ['queue', 'queue']]);
});

test('offline and errors are explicit overall states, not a spinning success claim', () => {
  const model = controlDesignState('mixed');
  assert.deepEqual(controlIndicators(controlSession(model), model, false).map(item => item.icon), ['unknown']);
  assert.equal(controlIndicators({ ...controlSession(model), error: 'Synthetic failure' }, model, true)[0].icon, 'error');
  assert.match(controlIndicators({ ...controlSession(model), error: 'Synthetic failure' }, model, true)[0].label, /Synthetic failure/);
});
