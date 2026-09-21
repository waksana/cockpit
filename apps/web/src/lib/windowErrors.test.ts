import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dismissUxError, getUxErrors } from './errorReporter';
import { installWindowErrorReporting } from './windowErrors';

test('both entries share actionable script/rejection reporting and release their listeners', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  const existing = new Set(getUxErrors().map(error => error.id));
  const remove = installWindowErrorReporting();
  t.after(() => {
    remove();
    for (const error of getUxErrors()) if (!existing.has(error.id)) dismissUxError(error.id);
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  const before = getUxErrors();
  target.dispatchEvent(new Event('error'));
  target.dispatchEvent(Object.assign(new Event('error'), { message: 'Script error.' }));
  assert.equal(getUxErrors(), before);

  target.dispatchEvent(Object.assign(new Event('error'), {
    message: 'Synthetic entry failure', filename: '/fixture-entry.ts', lineno: 4, colno: 2,
  }));
  assert.match(getUxErrors().at(-1)?.message ?? '', /Synthetic entry failure \(\/fixture-entry.ts:4:2\)/);
  target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: { message: 'Synthetic rejection' } }));
  assert.match(getUxErrors().at(-1)?.message ?? '', /Synthetic rejection/);

  remove();
  const stopped = getUxErrors();
  target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'Ignored after disposal' }));
  assert.equal(getUxErrors(), stopped);
});
