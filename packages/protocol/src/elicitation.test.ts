import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ElicitationSchema, validateElicitationContent } from './elicitation.ts';
import { ElicitationRequest, Intents } from './index.ts';

const schema = ElicitationSchema.parse({ type: 'object', properties: {
  confirmed: { type: 'boolean', default: false },
  label: { type: 'string', minLength: 2, maxLength: 5 },
  count: { type: 'integer', minimum: 0, maximum: 3 },
  rate: { type: 'number', minimum: 0, maximum: 1 },
  choice: { type: 'string', enum: ['a', 'b'], enumNames: ['A', 'B'] },
  titled: { type: 'string', oneOf: [{ const: 'x', title: 'X' }] },
  tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } },
  groups: { type: 'array', items: { anyOf: [{ const: 'g', title: 'G' }] } },
  email: { type: 'string', format: 'email' },
  uri: { type: 'string', format: 'uri' },
  date: { type: 'string', format: 'date' },
  time: { type: 'string', format: 'date-time' },
}, required: ['confirmed', 'count', 'label'] });
const valid = { confirmed: false, count: 0, label: 'ok' };

test('flat SDK schema validates exact primitive values without coercion or inserting defaults', () => {
  assert.deepEqual(validateElicitationContent(schema, valid), { success: true, data: valid });
  assert.equal(validateElicitationContent(schema, { ...valid, rate: 0.5, choice: 'b', titled: 'x', tags: ['a', 'b'],
    groups: ['g'], email: 'a@example.com', uri: 'urn:example:test', date: '2024-02-29',
    time: '2024-02-29T01:02:03+08:00' }).success, true);
  for (const content of [
    undefined, {}, { count: 0, label: 'ok' }, { ...valid, confirmed: 'true' }, { ...valid, count: '1' },
    { ...valid, count: -1 }, { ...valid, count: 4 }, { ...valid, count: 1.5 }, { ...valid, count: Infinity },
    { ...valid, rate: 2 }, { ...valid, label: 'x' }, { ...valid, label: 'too long' },
    { ...valid, choice: 'c' }, { ...valid, titled: 'y' }, { ...valid, tags: [] }, { ...valid, tags: ['c'] },
    { ...valid, tags: ['a', 'a'] }, { ...valid, tags: ['a', 'b', 'a'] }, { ...valid, groups: ['bad'] },
    { ...valid, extra: true }, { ...valid, email: 'not-email' }, { ...valid, uri: 'not uri' },
    { ...valid, date: '2024-02-30' }, { ...valid, time: 'yesterday' },
  ]) assert.equal(validateElicitationContent(schema, content).success, false, JSON.stringify(content));
});

test('unknown schema constraints cannot be stripped into an acceptable form', () => {
  for (const input of [
    { type: 'object', properties: { child: { type: 'object', properties: {} } } },
    { type: 'object', properties: { text: { type: 'string', pattern: 'restricted' } } },
    { type: 'object', properties: {}, required: ['missing'] },
    { type: 'object', properties: {}, anyOf: [] },
    { type: 'object', properties: {}, additionalProperties: true },
    { type: 'object', properties: { constructor: { type: 'string' } } },
    JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
    { type: 'object', properties: { a: { type: 'array', items: { type: 'number' } } } },
    { type: 'object', properties: { a: { type: 'string', oneOf: [{ const: 'a', title: 'A' }, { const: 'a', title: 'Again' }] } } },
  ]) assert.equal(ElicitationSchema.safeParse(input).success, false);
});

test('string validation follows JSON Schema Unicode lengths and MCP format semantics', () => {
  for (const [field, value, expected] of [
    [{ type: 'string', minLength: 2 }, '\u{1F600}', false],
    [{ type: 'string', maxLength: 1 }, '\u{1F600}', true],
    [{ type: 'string', minLength: 2 }, '\u{1F600}a', true],
    [{ type: 'string', format: 'uri' }, 'https://example.com/a b', false],
    [{ type: 'string', format: 'uri' }, 'https://example.com/a%20b', true],
    [{ type: 'string', format: 'date-time' }, '2026-10-08T13:37Z', false],
    [{ type: 'string', format: 'date-time' }, '2026-10-08T13:37:00Z', true],
    [{ type: 'string', format: 'date-time' }, '2026-10-08t13:37:00z', true],
  ] as const) {
    const schema = ElicitationSchema.parse({ type: 'object', properties: { value: field } });
    assert.equal(validateElicitationContent(schema, { value }).success, expected, JSON.stringify({ field, value }));
  }
});

test('schema and content survive the public wire, including empty forms and explicit false', () => {
  const request = { requestId: 'r', message: 'Confirm', actions: ['accept', 'decline', 'cancel'], requestedSchema: schema };
  assert.deepEqual(ElicitationRequest.parse(request), request);
  const body = { sessionId: 's', requestId: 'r', action: 'accept', content: valid };
  assert.deepEqual(Intents.respondElicitation.body.parse(body), body);
  assert.equal(Intents.respondElicitation.body.safeParse({ ...body, action: 'decline' }).success, false);
  assert.equal(Intents.respondElicitation.body.safeParse({ ...body, content: { nested: {} } }).success, false);
  assert.equal(validateElicitationContent(ElicitationSchema.parse({ type: 'object', properties: {} }), {}).success, true);
});
