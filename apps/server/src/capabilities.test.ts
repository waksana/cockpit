import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Intents, ServerEvent } from '@cockpit/protocol';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { isIntentName, registerCapabilities } from './capabilities.ts';

// Import only after disabling boot: no Engine, preferences, sockets, or fixtures.
process.env.COCKPIT_NO_BOOT = '1';
process.env.LOG_LEVEL = 'silent';
process.env.COCKPIT_SERVE_WEB = '0';
const { app } = await import('./index.ts');
after(() => app.close());

type Summary = { name: string; description: string };
type Transport = { method: string; path: string };
type Listing = { intents: Summary[]; transports: Transport[] };
type Schema = Record<string, unknown>;
type Detail = Summary & { inputSchema: Schema; resultSchema: Schema };
const names = Object.keys(Intents).sort();
const retired = [
  'hook/add', 'hook/stop', 'hook/list',
  'flow/list', 'flow/add', 'flow/remove', 'flow/write-gate', 'flow/run',
  'flow-schedule/add', 'flow-schedule/stop', 'flow-schedule/list',
  'session/set-spawned-by',
];

async function listing(query = ''): Promise<Listing> {
  const response = await app.inject({ method: 'GET', url: `/capabilities${query}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Listing>();
}

async function detail(name: string): Promise<Detail> {
  const response = await app.inject({
    method: 'GET', url: `/capabilities?name=${encodeURIComponent(name)}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Detail>();
}

test('native fork publishes one strict schema for Web, API and MCP callers', async () => {
  const capability = await detail('session/fork');
  assert.deepEqual(Object.keys(object(capability.inputSchema.properties)).sort(), ['name', 'sessionId', 'toEventId']);
  assert.equal(capability.inputSchema.additionalProperties, false);
  assert.deepEqual(capability.inputSchema.required, ['sessionId']);
  assert.deepEqual(Object.keys(object(capability.resultSchema.properties)), ['sessionId']);
  assert.match(capability.description, /Non-idempotent/);
});

function meaningfulDescription(description: unknown): void {
  assert.ok(typeof description === 'string');
  assert.match(description, /\p{L}/u);
}

function object(value: unknown): Schema {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Schema;
}

function resolveSchema(root: Schema, value: unknown): Schema {
  let node = object(value);
  const seen = new Set<string>();
  while ('$ref' in node) {
    const ref = node.$ref;
    assert.ok(typeof ref === 'string');
    assert.match(ref, /^#(?:\/|$)/, 'schema references must be local');
    assert.ok(!seen.has(ref), 'reference-only cycle');
    seen.add(ref);
    let target: unknown = root;
    for (const part of ref.slice(1).split('/').slice(1)) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      assert.ok(target !== null && typeof target === 'object');
      assert.ok(Object.hasOwn(target, key), `unresolved reference: ${ref}`);
      target = Reflect.get(target, key);
    }
    node = object(target);
    assert.notDeepEqual(node, {}, `reference lost its schema: ${ref}`);
  }
  return node;
}

function schemaAt(root: Schema, ...path: (string | number)[]): Schema {
  let value: unknown = root;
  for (const key of path) {
    if (!Array.isArray(value)) value = resolveSchema(root, value);
    assert.ok(value !== null && typeof value === 'object');
    assert.ok(Object.hasOwn(value, key), `missing schema path: ${path.join('/')}`);
    value = Reflect.get(value, key);
  }
  return resolveSchema(root, value);
}

function assertLocalRefs(root: Schema, value: unknown = root): void {
  if (value === null || typeof value !== 'object') return;
  if ('$ref' in value) resolveSchema(root, value);
  for (const child of Object.values(value)) assertLocalRefs(root, child);
}

test('default listing is sorted, bounded, and contains summaries rather than schemas', async () => {
  const result = await listing();
  assert.deepEqual(Object.keys(result).sort(), ['intents', 'runtime', 'transports']);
  assert.deepEqual(result.intents.map(({ name }) => name), names.slice(0, 100));
  assert.ok(result.intents.length > 0 && result.intents.length <= 100);
  for (const intent of result.intents) {
    assert.deepEqual(Object.keys(intent).sort(), ['description', 'name']);
    meaningfulDescription(intent.description);
  }
  assert.deepEqual(await listing('?limit=100&offset=0&prefix='), result);
  assert.equal(app.server.listening, false);
});

test('pagination covers exactly every Intents key once, including the final empty page', async () => {
  const found: string[] = [];
  for (let offset = 0; offset < names.length; offset += 7) {
    const page = await listing(`?limit=7&offset=${offset}`);
    assert.deepEqual(page.intents.map(({ name }) => name), names.slice(offset, offset + 7));
    found.push(...page.intents.map(({ name }) => name));
  }
  assert.deepEqual(found, names);
  assert.equal(new Set(found).size, names.length);
  assert.deepEqual((await listing(`?offset=${names.length}`)).intents, []);
});

test('prefix filtering precedes pagination and preserves the full transport inventory', async (t) => {
  const { transports } = await listing();
  for (const [prefix, limit, offset] of [
    ['session/', 3, 2], ['ses', 100, 0], ['session/purge', 1, 0],
    ['Session/', 100, 0], ['no-such-intent/', 100, 0], ['x'.repeat(200), 100, 0],
  ] as const) {
    await t.test(`${prefix}: limit=${limit}, offset=${offset}`, async () => {
      const query = new URLSearchParams({ prefix, limit: String(limit), offset: String(offset) });
      const page = await listing(`?${query}`);
      assert.deepEqual(
        page.intents.map(({ name }) => name),
        names.filter((name) => name.startsWith(prefix)).slice(offset, offset + limit),
      );
      assert.deepEqual(page.transports, transports);
    });
  }
});

test('listing accepts boundary integers without wrapping or losing precision', async () => {
  assert.deepEqual((await listing('?limit=1&offset=0')).intents.map(({ name }) => name), names.slice(0, 1));
  assert.deepEqual(await listing('?limit=0001&offset=00'), await listing('?limit=1&offset=0'));
  for (const offset of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual((await listing(`?limit=100&offset=${offset}`)).intents, []);
  }
});

test('malformed, repeated, out-of-range, and unknown listing parameters return 400', async (t) => {
  const invalidNumbers = ['', '-1', '1.5', 'NaN', 'Infinity', '1e2', '0x10', '+1', ' 1', '1 ', 'true', 'null', '9007199254740992', '9'.repeat(400)];
  const queries = [
    ...['limit', 'offset'].flatMap((key) => invalidNumbers.map((value) => new URLSearchParams({ [key]: value }).toString())),
    'limit=0', 'limit=101',
    'limit=1&limit=1', 'offset=0&offset=0', 'prefix=session/&prefix=session/',
    'limit=1&limit=2', 'offset=0&offset=1', 'prefix=session/&prefix=prompt',
    `prefix=${'x'.repeat(201)}`,
    'unknown=value', 'prefix=session/&extra=1',
    'limit[]=1', 'offset[value]=0', 'prefix[]=session/',
  ];
  for (const query of queries) {
    await t.test(query, async () => {
      const response = await app.inject({ method: 'GET', url: `/capabilities?${query}` });
      assert.equal(response.statusCode, 400, response.body);
      meaningfulDescription(response.json().error);
    });
  }
});

test('detail rejects empty, oversized, repeated, and mixed-mode parameters', async (t) => {
  const queries = [
    'name=', `name=${'x'.repeat(201)}`, 'name=prompt&name=prompt',
    'name=prompt&name=cancel', 'name=prompt&name=unknown',
    'name=prompt&prefix=', 'name=prompt&prefix=session/',
    'name=prompt&limit=100', 'name=prompt&offset=0',
    'name=unknown&limit=1', 'name=prompt&extra=1', 'name[]=prompt',
  ];
  for (const query of queries) {
    await t.test(query, async () => {
      const response = await app.inject({ method: 'GET', url: `/capabilities?${query}` });
      assert.equal(response.statusCode, 400, response.body);
      meaningfulDescription(response.json().error);
    });
  }
});

test('unknown and prototype intent names return 404, never inherited capabilities', async (t) => {
  for (const name of [
    'unknown/intent', 'session/', 'Session/new', ' session/new', 'session/new ',
    'x'.repeat(200), ...Object.getOwnPropertyNames(Object.prototype),
  ]) {
    await t.test(name, async () => {
      assert.equal(isIntentName(name), false);
      const response = await app.inject({
        method: 'GET', url: `/capabilities?name=${encodeURIComponent(name)}`,
      });
      assert.equal(response.statusCode, 404, response.body);
      meaningfulDescription(response.json().error);
    });
  }
});

test('every intent detail exposes exactly the actual draft-07 input and result schemas', async (t) => {
  for (const [name, intent] of Object.entries(Intents)) {
    await t.test(name, async () => {
      assert.equal(isIntentName(name), true);
      const result = await detail(name);
      assert.deepEqual(Object.keys(result).sort(), ['description', 'inputSchema', 'name', 'resultSchema']);
      assert.equal(result.name, name);
      meaningfulDescription(result.description);
      for (const [key, schema] of [['inputSchema', intent.body], ['resultSchema', intent.result]] as const) {
        assert.deepEqual(result[key], zodToJsonSchema(schema, { target: 'jsonSchema7' }));
        assert.equal(result[key].$schema, 'http://json-schema.org/draft-07/schema#');
        assertLocalRefs(result[key]);
      }
    });
  }
});

test('listing and detail descriptions convey refinements and runtime guarantees beyond JSON Schema', async (t) => {
  const descriptions = [
    ['session/chat', [
      /one native event page/i, /without a server chat cache or projection/i,
      /max counts events, not display messages/i, /passive reads do not load sessions/i,
      /expired cursor is not a continuation/i, /never automatically retained/i,
    ]],
    ['schedule/add', [
      /exactly one of interval or at/i, /1 second to 24 hours/i,
      /cron.*not supported/i,
    ]],
    ['push/subscribe', [/https/i]],
    ['session/rewind', [
      /native file rollback/i, /backend validates runtime support/i,
      /conflicts or partial failures/i,
    ]],
    ['setMode', [
      /interaction mode.*interactive.*plan.*autopilot/i,
      /permissions.*always auto-approved.*allow-all.*every mode/i,
    ]],
    ['runtime/snapshot', [
      /models.*readiness.*permission policy.*session metadata/i,
      /passive query/i, /always auto-approve/i, /interaction modes do not change permissions/i,
    ]],
    ['skills/global', [
      /optional cwd/i, /omitted cwd uses the server home directory/i, /never an arbitrary session/i,
    ]],
    ['prompt', [
      /attachment, attachments.*ordered parts/i, /literal \/uploads\/<safe-basename>/i,
      /server resolves authoritative metadata.*native file paths/i, /mutually exclusive/i,
    ]],
  ] as const;
  for (const [name, patterns] of descriptions) {
    await t.test(name, async () => {
      const result = await detail(name);
      const summary = (await listing(`?prefix=${encodeURIComponent(name)}`)).intents
        .find((intent) => intent.name === name);
      assert.equal(summary?.description, result.description);
      for (const pattern of patterns) assert.match(result.description, pattern);
    });
  }
});

test('runtime/snapshot exposes a required literal allow-all permission policy', async () => {
  const { inputSchema, resultSchema } = await detail('runtime/snapshot');
  assert.deepEqual(inputSchema.properties, {});
  assert.deepEqual(inputSchema.required ?? [], []);
  assert.deepEqual(resultSchema.required, ['type', 'agentStatus', 'models', 'sessions', 'permissionPolicy']);
  assert.equal(schemaAt(resultSchema, 'properties', 'type').const, 'snapshot');
  const policy = schemaAt(resultSchema, 'properties', 'permissionPolicy');
  assert.equal(policy.type, 'string');
  assert.equal(policy.const, 'allow-all');
  assert.match(String(policy.description), /always auto-approved/i);
  assert.match(String(policy.description), /independent of interactive, plan, and autopilot/i);
  const snapshot = { type: 'snapshot', agentStatus: 'up', models: [], sessions: [] };
  assert.equal(Intents['runtime/snapshot'].result.safeParse({ ...snapshot, permissionPolicy: 'allow-all' }).success, true);
  assert.equal(Intents['runtime/snapshot'].result.safeParse(snapshot).success, false);
  for (const permissionPolicy of ['interactive', 'plan', 'autopilot', 'deny-all', null]) {
    assert.equal(Intents['runtime/snapshot'].result.safeParse({ ...snapshot, permissionPolicy }).success, false);
  }
});

test('native chat advertises bounded event pages and opaque nonempty cursors', async () => {
  const { inputSchema } = await detail('session/chat');
  assert.deepEqual(inputSchema.required, ['sessionId']);
  assert.deepEqual(schemaAt(inputSchema, 'properties', 'max'), {
    type: 'integer', minimum: 1, maximum: 256, default: 64,
  });
  assert.deepEqual(schemaAt(inputSchema, 'properties', 'cursor'), {
    type: 'string', minLength: 1, maxLength: 16384,
  });
  assert.deepEqual(schemaAt(inputSchema, 'properties', 'direction').enum, ['forward', 'backward']);
  const body = Intents['session/chat'].body;
  for (const max of [1, 256]) assert.equal(body.safeParse({ sessionId: 's', cursor: 'opaque', max }).success, true);
  for (const max of [0, -1, 1.5, 257, '1', null, NaN, Infinity]) {
    assert.equal(body.safeParse({ sessionId: 's', max }).success, false);
  }
  for (const cursor of ['', null, 1]) assert.equal(body.safeParse({ sessionId: 's', cursor }).success, false);
});

test('native chat source constraints are enforced beyond individually optional JSON Schema fields', async () => {
  const { inputSchema } = await detail('session/chat');
  assert.deepEqual(inputSchema.required, ['sessionId']);
  assert.equal(Intents['session/chat'].body.safeParse({
    sessionId: 's', source: 'persisted', types: ['assistant.message'],
  }).success, false);
  assert.equal(Intents['session/chat'].body.safeParse({
    sessionId: 's', beforeMsgId: 'older', afterMsgId: 'newer',
  }).success, false);
});

test('chat returns events with native expiry rather than messages or chat SSE', async () => {
  const { resultSchema } = await detail('session/chat');
  assert.equal(schemaAt(resultSchema, 'properties', 'events').type, 'array');
  assert.equal('messages' in object(resultSchema.properties), false);
  assert.deepEqual(schemaAt(resultSchema, 'properties', 'cursorStatus').enum, ['ok', 'expired']);
  const page = { sessionId: 's', source: 'persisted', direction: 'backward', events: [],
    cursor: 'native', cursorStatus: 'ok', hasMore: false, read: { rpc: 1, events: 0 } };
  assert.deepEqual(Intents['session/chat'].result.parse(page), page);
  assert.equal(Intents['session/chat'].result.safeParse({ page }).success, false);
  assert.equal(ServerEvent.safeParse({ type: 'session/history-page', page }).success, false);
  assert.equal(ServerEvent.safeParse({ type: 'session/history-page', ...page }).success, false);
  assert.equal(ServerEvent.safeParse({ type: 'session/reset', page }).success, false);
  assert.equal(ServerEvent.options.some((event) => String(event.shape.type.value) === 'session/history-page'), false);
});

test('schedule requires exactly one timing selector although each selector is individually optional in JSON Schema', async () => {
  const { inputSchema } = await detail('schedule/add');
  assert.deepEqual(inputSchema.required, ['sessionId', 'prompt']);
  for (const [selector, type] of [['interval', 'string'], ['at', 'number']]) {
    assert.equal(schemaAt(inputSchema, 'properties', selector).type, type);
  }
  const selectors = { interval: '5m', at: 1_800_000_000_000 };
  const entries = Object.entries(selectors);
  for (let mask = 0; mask < 4; mask++) {
    const selected = entries.filter((_, index) => mask & (1 << index));
    const body = { sessionId: 's', prompt: 'check status', ...Object.fromEntries(selected) };
    assert.equal(Intents['schedule/add'].body.safeParse(body).success, selected.length === 1, JSON.stringify(body));
  }
});

test('push endpoints require HTTPS beyond the advertised URI format', async () => {
  const keys = { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) };
  const { inputSchema } = await detail('push/subscribe');
  const endpoint = schemaAt(inputSchema, 'properties', 'subscription', 'properties', 'endpoint');
  assert.equal(endpoint.type, 'string');
  assert.equal(endpoint.format, 'uri');
  assert.equal(Intents['push/subscribe'].body.safeParse({
    subscription: { endpoint: 'https://push.example/subscription', keys },
  }).success, true);
  for (const endpoint of ['http://push.example/subscription', 'ftp://push.example/subscription', '/subscription', '']) {
    assert.equal(Intents['push/subscribe'].body.safeParse({ subscription: { endpoint, keys } }).success, false);
  }
});

test('rewind exposes optional rollbackFiles while interaction modes remain distinct from permissions', async () => {
  const rewind = (await detail('session/rewind')).inputSchema;
  assert.deepEqual(rewind.required, ['sessionId', 'toMsgId']);
  assert.deepEqual(schemaAt(rewind, 'properties', 'rollbackFiles'), { type: 'boolean' });
  const mode = (await detail('setMode')).inputSchema;
  assert.deepEqual(mode.required, ['sessionId', 'mode']);
  assert.deepEqual(schemaAt(mode, 'properties', 'mode').enum, ['interactive', 'plan', 'autopilot']);
  assert.equal(Intents.setMode.body.safeParse({ sessionId: 's', mode: 'allow-all' }).success, false);
});

test('skills/global advertises optional nonempty cwd without requiring a session', async () => {
  const { inputSchema } = await detail('skills/global');
  assert.deepEqual(Object.keys(object(inputSchema.properties)), ['cwd']);
  assert.deepEqual(inputSchema.required ?? [], []);
  assert.deepEqual(schemaAt(inputSchema, 'properties', 'cwd'), { type: 'string', minLength: 1 });
  for (const body of [{}, { cwd: '/workspace/project' }]) {
    assert.equal(Intents['skills/global'].body.safeParse(body).success, true);
  }
  for (const cwd of ['', null, 42]) {
    assert.equal(Intents['skills/global'].body.safeParse({ cwd }).success, false);
  }
});

test('prompt advertises one optional uploaded attachment with a literal stored URL, not a client path', async () => {
  const { inputSchema } = await detail('prompt');
  assert.deepEqual(inputSchema.required, ['sessionId', 'text']);
  const attachment = schemaAt(inputSchema, 'properties', 'attachment');
  assert.equal(attachment.type, 'object');
  assert.deepEqual(attachment.required, ['kind', 'name', 'url']);
  assert.deepEqual(Object.keys(object(attachment.properties)).sort(), ['kind', 'mime', 'name', 'size', 'url']);
  assert.deepEqual(schemaAt(inputSchema, 'properties', 'attachment', 'properties', 'kind').enum, ['image', 'file']);
  const url = schemaAt(inputSchema, 'properties', 'attachment', 'properties', 'url');
  assert.equal(url.type, 'string');
  assert.equal(typeof url.pattern, 'string');
  assert.match(String(url.description), /literal local upload URL/i);
  assert.equal(Intents.prompt.body.safeParse({ sessionId: 's', text: 'hello' }).success, true);
  for (const kind of ['image', 'file']) {
    assert.equal(Intents.prompt.body.safeParse({
      sessionId: 's', text: '', attachment: { kind, name: 'picture.png', url: '/uploads/stored-picture.png' },
    }).success, true);
  }
  for (const url of [
    '/uploads/../picture.png', '/uploads/picture..png', '/uploads/%70icture.png',
    '/uploads/picture.png?download=1', '/uploads/picture.png#preview',
    'https://files.example/picture.png', '/workspace/picture.png', '/uploads/picture.png\n',
  ]) {
    assert.equal(Intents.prompt.body.safeParse({
      sessionId: 's', text: '', attachment: { kind: 'image', name: 'picture.png', url },
    }).success, false, url);
  }
});

test('detail preserves nested enums, optional fields, and shared enum references', async () => {
  const prompt = (await detail('prompt')).inputSchema;
  assert.deepEqual(schemaAt(prompt, 'properties', 'mode').enum, ['enqueue', 'immediate']);
  assert.deepEqual(prompt.required, ['sessionId', 'text']);
  const model = (await detail('setModel')).inputSchema;
  assert.deepEqual(schemaAt(model, 'properties', 'contextTier').enum, ['default', 'long_context']);

  const result = (await detail('session/get')).resultSchema;
  const meta = schemaAt(result, 'properties', 'meta', 'anyOf', 0);
  assert.deepEqual(schemaAt(result, 'properties', 'meta', 'anyOf', 1), { type: 'null' });
  assert.deepEqual(schemaAt(result, 'properties', 'meta', 'anyOf', 0, 'properties', 'status').enum, ['unloaded', 'idle', 'running', 'error']);
  const plan = schemaAt(result, 'properties', 'meta', 'anyOf', 0, 'properties', 'planRequest', 'anyOf', 0);
  const properties = object(plan.properties);
  const actions = schemaAt(result, 'properties', 'meta', 'anyOf', 0, 'properties', 'planRequest', 'anyOf', 0, 'properties', 'actions', 'items');
  assert.deepEqual(actions.enum, ['exit_only', 'interactive', 'autopilot', 'autopilot_fleet']);
  assert.deepEqual(resolveSchema(result, properties.recommendedAction), actions);
  assert.ok(Array.isArray(meta.required) && meta.required.includes('sessionId'));
});

test('native event schema preserves identity and opaque payload without a recursive message graph', async () => {
  const result = (await detail('session/chat')).resultSchema;
  const event = schemaAt(result, 'properties', 'events', 'items');
  assert.equal(event.type, 'object');
  assert.deepEqual(event.required, ['id', 'type', 'data']);
  const properties = object(event.properties);
  for (const key of ['id', 'type', 'agentId', 'parentToolCallId']) assert.equal(object(properties[key]).type, 'string');
  assert.equal(object(properties.data).type, 'object');
  assert.equal('subMessages' in properties, false);
});

test('session/purge requires an explicit literal confirm:true', async () => {
  const { inputSchema } = await detail('session/purge');
  assert.ok(Array.isArray(inputSchema.required) && inputSchema.required.includes('sessionId'));
  assert.ok(Array.isArray(inputSchema.required) && inputSchema.required.includes('confirm'));
  assert.deepEqual(schemaAt(inputSchema, 'properties', 'confirm'), { type: 'boolean', const: true });
  assert.equal(Intents['session/purge'].body.safeParse({ sessionId: 'test', confirm: true }).success, true);
  for (const body of [
    { sessionId: 'test' }, { sessionId: 'test', confirm: false },
    { sessionId: 'test', confirm: 'true' }, { sessionId: 'test', confirm: 1 },
  ]) {
    assert.equal(Intents['session/purge'].body.safeParse(body).success, false);
  }
});

test('retired capability families and set-spawned-by are absent from listings', async (t) => {
  for (const prefix of ['hook/', 'flow/', 'flow-schedule/', 'session/set-spawned-by']) {
    await t.test(prefix, async () => {
      assert.deepEqual((await listing(`?prefix=${encodeURIComponent(prefix)}`)).intents, []);
      assert.deepEqual(names.filter((name) => name.startsWith(prefix)), []);
    });
  }
});

test('every retired capability detail returns 404', async (t) => {
  for (const name of retired) {
    await t.test(name, async () => {
      const response = await app.inject({
        method: 'GET', url: `/capabilities?name=${encodeURIComponent(name)}`,
      });
      assert.equal(response.statusCode, 404, `${name} must not expose a capability detail`);
      assert.equal(isIntentName(name), false);
    });
  }
});

function transportKeys(transports: Transport[]): string[] {
  for (const transport of transports) {
    assert.deepEqual(Object.keys(transport).sort(), ['method', 'path']);
  }
  return transports.map(({ method, path }) => `${method} ${path}`).sort();
}

test('the actual no-boot server advertises all GET/POST transports without implicit HEAD', async () => {
  const { transports } = await listing();
  assert.deepEqual(transportKeys(transports), [
    'GET /capabilities', 'GET /events', 'GET /health', 'GET /status', 'GET /uploads/:name',
    'POST /admin/restart', 'POST /intent/*', 'POST /upload',
  ].sort());
  for (const { method, path } of transports) {
    assert.ok(method === 'GET' || method === 'POST');
    assert.equal(app.hasRoute({ method, url: path }), true);
  }
  assert.equal(app.hasRoute({ method: 'HEAD', url: '/capabilities' }), true);
  assert.equal(app.server.listening, false);
});

test('onRoute captures multi-method and plugin routes once and keeps inventories app-local', async (t) => {
  const isolated = Fastify({ logger: false });
  t.after(() => isolated.close());
  registerCapabilities(isolated);
  isolated.route({ method: ['GET', 'POST'], url: '/dual', handler: async () => ({ ok: true }) });
  isolated.register(async (scope) => {
    scope.get('/nested', async () => ({ ok: true }));
  }, { prefix: '/v1' });
  const response = await isolated.inject({ method: 'GET', url: '/capabilities' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(transportKeys(response.json<Listing>().transports), [
    'GET /capabilities', 'GET /dual', 'GET /v1/nested', 'POST /dual',
  ]);
  assert.equal(isolated.hasRoute({ method: 'HEAD', url: '/dual' }), true);
  assert.equal((await listing()).transports.some(({ path }) => path === '/dual'), false);
});
