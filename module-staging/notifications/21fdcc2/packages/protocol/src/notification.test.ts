import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import {
  isUnreadAttention, unreadSessionCount, SessionMeta, Snapshot, ServerEvent,
  NotificationPayload, PushEndpoint, PushSubscriptionJson, PushDelivery, PushStatus, Intents,
} from './index.ts';

type Schema = {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
};

function roundTrip(schema: Schema, value: unknown) {
  assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(value))), value);
}

const badCounters = [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, '1', null, true];

function checkCounters(schema: Schema, base: Record<string, unknown>, fields: readonly string[]) {
  for (const field of fields) {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
      roundTrip(schema, { ...base, [field]: value });
    }
    for (const value of badCounters) {
      assert.equal(schema.safeParse({ ...base, [field]: value }).success, false, `${field}: ${String(value)}`);
    }
  }
}

const meta = {
  sessionId: 's1', title: 'Session', cwd: '/workspace/project', lastActivity: 1,
  status: 'idle', error: null, loaded: true, queue: [], ask: null,
} satisfies SessionMeta;
const snapshot = {
  type: 'snapshot', agentStatus: 'up', models: [], sessions: [], permissionPolicy: 'allow-all',
} satisfies Snapshot;
const notification = {
  type: 'notification', kind: 'ready', sessionId: 's1', title: 'Reply ready',
  body: 'Your reply is ready.', tag: 'session:s1', url: '/?sessionId=s1',
} satisfies NotificationPayload;
const endpoint = 'https://push.example/subscriptions/one';
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const keys = {
  p256dh: ecdh.getPublicKey().toString('base64url'),
  auth: randomBytes(16).toString('base64url'),
};
const subscription = { endpoint, keys } satisfies PushSubscriptionJson;
const rejectedEndpoints = [
  '', 'not-a-url', '/relative', 'http://push.example/x', 'file:///etc/passwd',
  'https://user@push.example/x', 'https://user:password@push.example/x',
  'https://push.example/x#fragment', 'https://push.example/x#',
  ' https://push.example/x', 'https://push.example/x ', 'https://push.example/a b',
  'https://push.exa\tmple/x', 'https://push.example/x\n', 'https://push.example/\rpath',
  'https://push.example/\u0000', 'https://push.example/\u001f', 'https://push.example/\u007f',
  'https://localhost/x', 'https://LOCALHOST/x', 'https://localhost./x',
  'https://sub.localhost/x', 'https://sub.localhost./x',
  ...[
    '0.0.0.0', '0.255.255.255', '10.0.0.1', '10.255.255.255',
    '100.64.0.0', '100.127.255.255', '127.0.0.1', '127.255.255.255',
    '169.254.0.0', '169.254.255.255', '172.16.0.0', '172.31.255.255',
    '192.168.0.0', '192.168.255.255', '224.0.0.0', '239.255.255.255',
    '240.0.0.0', '255.255.255.255', '2130706433', '127.1', '0x7f000001',
  ].map((host) => `https://${host}/x`),
  ...[
    '::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fdff::1', 'fe80::1', 'febf::1',
    'ff00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '::ffff:808:808', '0:0:0:0:0:ffff:0808:0808',
  ].map((host) => `https://[${host}]/x`),
  `${endpoint}/${'x'.repeat(4096)}`,
];

test('unread attention requires a present kind and a newer attention ID', () => {
  assert.equal(isUnreadAttention({}), false);
  for (const attention of [undefined, null] as const) {
    assert.equal(isUnreadAttention({ attention, attnId: 10, seenId: 0 }), false);
  }
  for (const attention of ['ready', 'choice'] as const) {
    for (const [ids, expected] of [
      [{}, false],
      [{ attnId: 0 }, false],
      [{ seenId: 1 }, false],
      [{ attnId: 1 }, true],
      [{ attnId: 2, seenId: 1 }, true],
      [{ attnId: 2, seenId: 2 }, false],
      [{ attnId: 2, seenId: 3 }, false],
      [{ attnId: Number.MAX_SAFE_INTEGER, seenId: Number.MAX_SAFE_INTEGER - 1 }, true],
    ] as const) {
      assert.equal(isUnreadAttention({ attention, ...ids }), expected, `${attention}: ${JSON.stringify(ids)}`);
    }
  }
});

test('unread session count accepts readonly structural metadata without mutation', () => {
  const sessions = Object.freeze([
    Object.freeze({ sessionId: 'ready', attention: 'ready', attnId: 2, seenId: 1 } as const),
    Object.freeze({ sessionId: 'choice', attention: 'choice', attnId: 3 } as const),
    Object.freeze({ sessionId: 'seen-choice', attention: 'choice', attnId: 3, seenId: 3 } as const),
    Object.freeze({ sessionId: 'legacy', attention: 'ready' } as const),
    Object.freeze({ sessionId: 'cleared', attention: null, attnId: 4 } as const),
    Object.freeze({ sessionId: 'absent', attnId: 4 } as const),
  ] as const);
  const before = JSON.stringify(sessions);
  assert.equal(unreadSessionCount(sessions), 2);
  assert.equal(unreadSessionCount(sessions), 2);
  assert.equal(unreadSessionCount(Object.freeze([])), 0);
  assert.equal(isUnreadAttention(sessions[0]), true);
  assert.equal(JSON.stringify(sessions), before);
});

test('session attention and seen IDs are optional nonnegative safe integers', () => {
  roundTrip(SessionMeta, meta);
  roundTrip(SessionMeta, { ...meta, attention: 'choice', attnId: 3, seenId: 3 });
  checkCounters(SessionMeta, meta, ['attnId', 'seenId']);
});

test('snapshot unread metadata survives the schema and server event union', () => {
  for (const schema of [Snapshot, ServerEvent]) {
    roundTrip(schema, snapshot);
    roundTrip(schema, { ...snapshot, unreadCount: 2, inboxRevision: 9 });
    checkCounters(schema, snapshot, ['unreadCount', 'inboxRevision']);
  }
});

test('session/notify supports legacy events and validated unread metadata for both kinds', () => {
  for (const attention of ['ready', 'choice'] as const) {
    const event = { type: 'session/notify', sessionId: 's1', title: 'Notice', attention, body: 'Ready' };
    roundTrip(ServerEvent, event);
    roundTrip(ServerEvent, { ...event, attnId: 3, inboxRevision: 9, unreadCount: 2 });
    checkCounters(ServerEvent, event, ['attnId', 'inboxRevision', 'unreadCount']);
    for (const invalid of [null, 'test', 'other']) {
      assert.equal(ServerEvent.safeParse({ ...event, attention: invalid }).success, false);
    }
  }
});

test('notification payloads preserve ready, choice, benign test, and legacy badge metadata', () => {
  for (const kind of ['ready', 'choice'] as const) {
    roundTrip(NotificationPayload, { ...notification, kind });
    roundTrip(NotificationPayload, {
      ...notification, kind, attnId: 3, inboxRevision: 9, unreadCount: 2, badge: 7,
    });
  }
  const benign = {
    type: 'notification', kind: 'test', title: 'Test notification', body: '',
    tag: 'push:test', url: '/', inboxRevision: 9, unreadCount: 2,
  } satisfies NotificationPayload;
  roundTrip(NotificationPayload, benign);
  roundTrip(NotificationPayload, { ...benign, sessionId: 's1' });
  roundTrip(NotificationPayload, { ...notification, badge: 4 });
  assert.equal('unreadCount' in NotificationPayload.parse({ ...notification, badge: 4 }), false);
  assert.equal('badge' in NotificationPayload.parse({ ...notification, unreadCount: 2 }), false);
});

test('notification payloads enforce individual string bounds but not aggregate byte limits', () => {
  const limits = { title: 256, body: 2048, tag: 256, url: 4096, sessionId: 256 };
  const largest = {
    ...notification, title: '界'.repeat(256), body: '界'.repeat(2048),
    tag: 't'.repeat(256), url: `/${'u'.repeat(4095)}`, sessionId: 's'.repeat(256),
  };
  roundTrip(NotificationPayload, largest);
  roundTrip(NotificationPayload, { ...notification, body: '' });
  for (const [field, limit] of Object.entries(limits)) {
    assert.equal(NotificationPayload.safeParse({ ...notification, [field]: 'x'.repeat(limit + 1) }).success, false, field);
    for (const value of [null, 1, ...(field === 'body' ? [] : [''])]) {
      assert.equal(NotificationPayload.safeParse({ ...notification, [field]: value }).success, false, field);
    }
  }
});

test('notification payloads require session IDs for ready and choice and reject invalid discriminants', () => {
  for (const kind of ['ready', 'choice'] as const) {
    const { sessionId: _sessionId, ...withoutSession } = notification;
    assert.equal(NotificationPayload.safeParse({ ...withoutSession, kind }).success, false);
  }
  for (const field of ['type', 'kind', 'title', 'body', 'tag', 'url']) {
    const missing: Record<string, unknown> = { ...notification };
    delete missing[field];
    assert.equal(NotificationPayload.safeParse(missing).success, false, field);
  }
  assert.equal(NotificationPayload.safeParse({ ...notification, type: 'session/notify' }).success, false);
  assert.equal(NotificationPayload.safeParse({ ...notification, kind: 'error' }).success, false);
});

test('notification counters and the legacy badge alias are optional nonnegative safe integers', () => {
  checkCounters(NotificationPayload, notification, ['attnId', 'inboxRevision', 'unreadCount', 'badge']);
});

test('push endpoints accept arbitrary public hosts, public IPs, and the length boundary', () => {
  for (const value of [
    endpoint, 'https://arbitrary-provider.example/push?token=abc',
    'https://localhost.push.example/x', 'https://push.example:8443/%23?token=abc',
    'https://8.8.8.8/x', 'https://1.1.1.1/x',
    'https://100.63.255.255/x', 'https://100.128.0.0/x',
    'https://172.15.255.255/x', 'https://172.32.0.0/x',
    'https://[2606:4700:4700::1111]/x', 'https://[2001:4860:4860::8888]/x',
    endpoint + 'x'.repeat(4096 - endpoint.length),
  ]) {
    assert.equal(PushEndpoint.safeParse(value).success, true, value);
  }
  assert.equal(PushEndpoint.safeParse(endpoint + 'x'.repeat(4097 - endpoint.length)).success, false);
});

test('push endpoints reject unsafe URLs, local/private addresses, and normalized IP bypasses', () => {
  for (const value of rejectedEndpoints) {
    assert.equal(PushEndpoint.safeParse(value).success, false, JSON.stringify(value));
  }
});

test('push subscriptions round-trip realistic required keys and finite fractional expiration times', () => {
  assert.equal(keys.p256dh.length, 87);
  assert.equal(keys.auth.length, 22);
  roundTrip(PushSubscriptionJson, subscription);
  for (const expirationTime of [null, 0, 0.5, 1_700_000_000_000, Number.MAX_VALUE]) {
    roundTrip(PushSubscriptionJson, { ...subscription, expirationTime });
  }
  for (const expirationTime of [-1, NaN, Infinity, -Infinity, '0', false]) {
    assert.equal(PushSubscriptionJson.safeParse({ ...subscription, expirationTime }).success, false, String(expirationTime));
  }
  for (const value of rejectedEndpoints) {
    assert.equal(PushSubscriptionJson.safeParse({ ...subscription, endpoint: value }).success, false, value);
  }
});

test('push subscriptions require both keys with canonical unpadded base64url encodings', () => {
  for (const invalidKeys of [undefined, null, {}, { p256dh: keys.p256dh }, { auth: keys.auth }]) {
    assert.equal(PushSubscriptionJson.safeParse({ endpoint, keys: invalidKeys }).success, false);
  }
  for (const [field, length, endings] of [
    ['p256dh', 87, 'AEIMQUYcgkosw048'], ['auth', 22, 'AQgw'],
  ] as const) {
    // The schema validates encoding; the subscription manager validates the EC point.
    for (const ending of endings) {
      roundTrip(PushSubscriptionJson, {
        endpoint, keys: { ...keys, [field]: 'A'.repeat(length - 1) + ending },
      });
    }
    for (const value of [
      '', 'A'.repeat(length - 1), 'A'.repeat(length + 1), 'A'.repeat(length - 1) + 'B',
      'A'.repeat(length - 1) + '=', '+'.repeat(length), '/'.repeat(length),
      ' '.repeat(length), 'A'.repeat(length - 1) + '\n', null, 1,
    ]) {
      assert.equal(PushSubscriptionJson.safeParse({ endpoint, keys: { ...keys, [field]: value } }).success, false, `${field}: ${String(value)}`);
    }
  }
});

test('push delivery reports service acceptance, failure, or expiration with a finite nonnegative timestamp', () => {
  for (const status of ['accepted', 'failed', 'expired'] as const) {
    for (const at of [0, 0.5, 1_700_000_000_000, Number.MAX_VALUE]) {
      const delivery = { status, at } satisfies PushDelivery;
      roundTrip(PushDelivery, delivery);
      roundTrip(PushDelivery, { ...delivery, error: 'Provider response' });
    }
  }
  for (const at of [undefined, null, -1, NaN, Infinity, -Infinity, '2026-09-08']) {
    assert.equal(PushDelivery.safeParse({ status: 'accepted', at }).success, false, String(at));
  }
  for (const status of [undefined, null, 'delivered', 'pending']) {
    assert.equal(PushDelivery.safeParse({ status, at: 1 }).success, false);
  }
  assert.equal(PushDelivery.safeParse({ status: 'failed', at: 1, error: 1 }).success, false);
});

test('push status preserves registration and delivery metadata and validates required fields', () => {
  const minimal = { configured: false, subscriptionCount: 0, publicKey: null } satisfies PushStatus;
  roundTrip(PushStatus, minimal);
  for (const registered of [true, false]) {
    for (const status of ['accepted', 'failed', 'expired'] as const) {
      roundTrip(PushStatus, {
        configured: true, registered, subscriptionCount: 2, publicKey: keys.p256dh,
        lastDelivery: { status, at: 0.5, error: 'Provider response' }, error: 'Status detail',
      });
    }
  }
  checkCounters(PushStatus, minimal, ['subscriptionCount']);
  for (const field of ['configured', 'subscriptionCount', 'publicKey']) {
    const missing: Record<string, unknown> = { ...minimal };
    delete missing[field];
    assert.equal(PushStatus.safeParse(missing).success, false, field);
  }
  for (const invalid of [
    { configured: 'true' }, { registered: null }, { registered: 'true' }, { publicKey: 1 },
    { error: 1 }, { lastDelivery: null }, { lastDelivery: { status: 'delivered', at: 1 } },
    { lastDelivery: { status: 'accepted', at: -1 } },
  ]) {
    assert.equal(PushStatus.safeParse({ ...minimal, ...invalid }).success, false);
  }
});

test('push intent bodies share endpoint validation and require explicit test confirmation', () => {
  const cases = [
    [Intents['push/status'].body, (value: string) => ({ endpoint: value })],
    [Intents['push/test'].body, (value: string) => ({ endpoint: value, confirm: true })],
    [Intents['push/unsubscribe'].body, (value: string) => ({ endpoint: value })],
    [Intents['push/subscribe'].body, (value: string) => ({ subscription: { ...subscription, endpoint: value } })],
  ] as const;
  for (const [schema, body] of cases) {
    roundTrip(schema, body(endpoint));
    for (const value of rejectedEndpoints) {
      assert.equal(schema.safeParse(body(value)).success, false, value);
    }
  }
  roundTrip(Intents['push/status'].body, {});
  assert.equal(Intents['push/status'].body.safeParse({ endpoint: null }).success, false);
  assert.equal(Intents['push/test'].body.safeParse({ confirm: true }).success, false);
  assert.equal(Intents['push/test'].body.safeParse({ endpoint }).success, false);
  for (const confirm of [undefined, false, 'true', 1, 0, null]) {
    assert.equal(Intents['push/test'].body.safeParse({ endpoint, confirm }).success, false);
  }
  assert.equal(Intents['push/unsubscribe'].body.safeParse({}).success, false);
  assert.equal(Intents['push/subscribe'].body.safeParse({}).success, false);
  assert.equal(Intents['push/subscribe'].body.safeParse({ subscription: { endpoint } }).success, false);
});

test('push intent results retain typed status, delivery, and acknowledgement metadata', () => {
  const status = {
    configured: true, registered: true, subscriptionCount: 1, publicKey: keys.p256dh,
    lastDelivery: { status: 'accepted', at: 0.5 }, error: 'Previous provider error',
  } satisfies PushStatus;
  roundTrip(Intents['push/status'].result, status);
  roundTrip(Intents['push/status'].result, { configured: false, subscriptionCount: 0, publicKey: null });
  checkCounters(Intents['push/status'].result, status, ['subscriptionCount']);
  assert.equal(Intents['push/status'].result.safeParse({ ok: true }).success, false);
  for (const outcome of ['accepted', 'failed', 'expired'] as const) {
    roundTrip(Intents['push/test'].result, { status: outcome, at: 1, error: 'Provider response' });
  }
  for (const invalid of [{ ok: true }, { status: 'delivered', at: 1 }, { status: 'accepted', at: -1 }]) {
    assert.equal(Intents['push/test'].result.safeParse(invalid).success, false);
  }
  for (const name of ['push/subscribe', 'push/unsubscribe', 'inbox/seen'] as const) {
    for (const ok of [true, false]) roundTrip(Intents[name].result, { ok });
    for (const invalid of [{}, { ok: 'true' }, { ok: 1 }]) {
      assert.equal(Intents[name].result.safeParse(invalid).success, false, name);
    }
  }
});

test('inbox/seen retains legacy requests and validates optional attention IDs', () => {
  const body = Intents['inbox/seen'].body;
  roundTrip(body, { sessionId: 's1' });
  checkCounters(body, { sessionId: 's1' }, ['attnId']);
  for (const invalid of [{}, { attnId: 1 }, { sessionId: null }, { sessionId: 1 }]) {
    assert.equal(body.safeParse(invalid).success, false);
  }
});
