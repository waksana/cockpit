import strict from 'node:assert/strict';

// A failed identity comparison must not ask Node to inspect a synthetic DOM's
// cyclic React graph. Keep normal scalar diagnostics without touching globals.
const object = (value: unknown) => value !== null && (typeof value === 'object' || typeof value === 'function');
const identityAssert: typeof strict = Object.assign(
  (value: unknown, message?: string | Error): asserts value => strict(value, message),
  strict,
  {
    equal(actual: unknown, expected: unknown, message?: string | Error) {
      if (object(actual) || object(expected)) {
        strict.equal(Object.is(actual, expected), true, message ?? 'Expected identical references');
      } else strict.equal(actual, expected, message);
    },
    notEqual(actual: unknown, expected: unknown, message?: string | Error) {
      if (object(actual) || object(expected)) {
        strict.equal(Object.is(actual, expected), false, message ?? 'Expected different references');
      } else strict.notEqual(actual, expected, message);
    },
  },
);

export default identityAssert;

export function assertIdentityList(actual: readonly unknown[], expected: readonly unknown[], message?: string) {
  strict.equal(actual.length, expected.length, message ?? 'Reference list length');
  actual.forEach((value, index) => identityAssert.equal(value, expected[index], message ?? `Reference at index ${index}`));
}
