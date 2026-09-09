import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type https from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { after, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  NotificationPayload, PushDelivery, PushStatus, PushSubscriptionJson,
} from '@cockpit/protocol';
import {
  configurePush, createPushSender, FilePushStorage, PUSH_FILES, PushManager,
  type PushManagerOptions, type PushSender, type PushStorage,
} from './push.ts';

const SUBJECT = 'https://cockpit.example';
const NOW = 1_700_000_000_000;
const previousSubject = process.env.COCKPIT_PUSH_SUBJECT;
process.env.COCKPIT_PUSH_SUBJECT = SUBJECT;
after(() => {
  if (previousSubject === undefined) delete process.env.COCKPIT_PUSH_SUBJECT;
  else process.env.COCKPIT_PUSH_SUBJECT = previousSubject;
});

function fixture(t: TestContext): string {
  const server = relative(process.cwd(), fileURLToPath(new URL('../', import.meta.url)));
  const root = join(server, `.push-fixture-${process.pid}-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function keypair() {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  const privateKey = Buffer.alloc(32);
  const scalar = pair.getPrivateKey();
  scalar.copy(privateKey, privateKey.length - scalar.length);
  return {
    publicKey: pair.getPublicKey().toString('base64url'),
    privateKey: privateKey.toString('base64url'),
  };
}

function subscription(endpoint = `https://push.example/subscriptions/${randomUUID()}`): PushSubscriptionJson {
  return {
    endpoint, expirationTime: null,
    keys: { p256dh: keypair().publicKey, auth: randomBytes(16).toString('base64url') },
  };
}

type IsolatedOptions = PushManagerOptions & ({ root: string } | { storage: PushStorage });

function harness(options: IsolatedOptions) {
  const calls: Parameters<PushSender>[] = [];
  const logs: PushDelivery[] = [];
  const sender = options.sender ?? (async () => ({ statusCode: 201 }));
  const manager = new PushManager({
    legacyRoot: null, now: () => NOW, ...options,
    sender: async (...args) => {
      calls.push(args);
      return sender(...args);
    },
    log: (result) => logs.push(result),
  });
  return { manager, calls, logs };
}

function configured(t: TestContext, options: Omit<PushManagerOptions, 'root' | 'storage'> = {}) {
  const root = fixture(t);
  configurePush({ root, legacyRoot: null, subject: SUBJECT });
  return { root, ...harness({ root, ...options }) };
}

function contents(root: string, name: typeof PUSH_FILES[keyof typeof PUSH_FILES]): string {
  return readFileSync(join(root, name), 'utf8');
}

function storedSubscriptions(root: string) {
  return JSON.parse(contents(root, PUSH_FILES.subscriptions)) as {
    publicKey: string; subscriptions: PushSubscriptionJson[];
  };
}

function assertRedacted(value: unknown, ...secrets: string[]): void {
  const json = JSON.stringify(value);
  for (const secret of secrets) assert.equal(json.includes(secret), false, 'secret leaked in observable result');
}

function blockSubscriptionRename(root: string): () => void {
  const path = join(root, PUSH_FILES.subscriptions);
  const backup = `${path}.saved`;
  renameSync(path, backup);
  mkdirSync(path);
  return () => {
    rmSync(path, { recursive: true });
    renameSync(backup, path);
  };
}

test('missing keys stay unconfigured without boot writes, sends, or replacement of lost keys', async (t) => {
  const parent = fixture(t);
  const root = join(parent, 'not-created');
  const { manager, calls } = harness({ root });
  const sub = subscription();
  assert.equal(manager.publicKey, null);
  assert.deepEqual(
    { ...manager.status(), error: undefined },
    { configured: false, publicKey: null, subscriptionCount: 0, error: undefined },
  );
  assert.match(manager.status().error!, /PUSH_UNCONFIGURED/);
  assert.throws(() => manager.subscribe(sub), /PUSH_UNCONFIGURED/);
  assert.equal((await manager.test(sub.endpoint, true)).status, 'failed');
  await manager.sendAttention('Synthetic reply', 'session', 'ready', 'The requested analysis is ready.');
  assert.equal(calls.length, 0);
  assert.equal(existsSync(root), false);
  assert.deepEqual(readdirSync(parent), []);

  const lost = fixture(t);
  const storage = new FilePushStorage(lost);
  const raw = JSON.stringify({ publicKey: keypair().publicKey, subscriptions: [sub] });
  storage.writeAtomic(PUSH_FILES.subscriptions, raw);
  assert.throws(() => configurePush({ root: lost, legacyRoot: null }), /PUSH_KEYS_MISSING_WITH_SUBSCRIPTIONS/);
  assert.equal(contents(lost, PUSH_FILES.subscriptions), raw);
  assert.equal(existsSync(join(lost, PUSH_FILES.config)), false);
  const restarted = harness({ root: lost });
  assert.equal(restarted.manager.status().configured, false);
  assert.equal((await restarted.manager.test(sub.endpoint, true)).status, 'failed');
  assert.equal(restarted.calls.length, 0);
});

test('explicit setup generates a real VAPID pair and is durable and idempotent across restarts', (t) => {
  const root = fixture(t);
  const file = new FilePushStorage(root);
  let writes = 0;
  const storage: PushStorage = {
    read: (name) => file.read(name),
    writeAtomic: (...args) => { writes++; file.writeAtomic(...args); },
  };
  const result = configurePush({ storage, legacyRoot: null, subject: SUBJECT });
  assert.equal(result.configured, true);
  assert.equal(writes, 1);
  const raw = contents(root, PUSH_FILES.config);
  const config = JSON.parse(raw);
  const pair = createECDH('prime256v1');
  pair.setPrivateKey(Buffer.from(config.privateKey, 'base64url'));
  assert.equal(pair.getPublicKey().toString('base64url'), result.publicKey);
  assert.equal(config.publicKey, result.publicKey);
  assert.equal(config.subject, SUBJECT);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(root, PUSH_FILES.config)).mode & 0o777, 0o600);
  }
  for (let restart = 0; restart < 2; restart++) {
    const { manager, calls } = harness({ storage });
    assert.deepEqual(manager.status(), {
      configured: true, publicKey: result.publicKey, subscriptionCount: 0,
    });
    assert.deepEqual(configurePush({ storage, legacyRoot: null, subject: SUBJECT }), result);
    assert.equal(calls.length, 0);
  }
  assert.equal(writes, 1);
  assert.equal(contents(root, PUSH_FILES.config), raw);
});

test('setup requires an explicit valid subject and never invents a contact', (t) => {
  const root = fixture(t);
  const saved = process.env.COCKPIT_PUSH_SUBJECT;
  delete process.env.COCKPIT_PUSH_SUBJECT;
  try {
    assert.throws(() => configurePush({ root, legacyRoot: null }), /PUSH_SUBJECT_REQUIRED/);
    assert.deepEqual(readdirSync(root), []);
    for (const subject of ['mailto:localhost', 'http://cockpit.example', 'https://cockpit.example/contact']) {
      assert.throws(() => configurePush({ root, legacyRoot: null, subject }), /PUSH_SUBJECT_REQUIRED/);
      assert.deepEqual(readdirSync(root), []);
    }
    const original = JSON.stringify(keypair());
    writeFileSync(join(root, PUSH_FILES.config), original);
    const { manager, calls } = harness({ root });
    assert.equal(manager.status().configured, false);
    assert.match(manager.status().error!, /PUSH_SUBJECT_REQUIRED/);
    assert.throws(() => configurePush({ root, legacyRoot: null }), /PUSH_SUBJECT_REQUIRED/);
    assert.equal(contents(root, PUSH_FILES.config), original);
    assert.equal(calls.length, 0);
  } finally {
    if (saved === undefined) delete process.env.COCKPIT_PUSH_SUBJECT;
    else process.env.COCKPIT_PUSH_SUBJECT = saved;
  }
});

test('corrupt JSON, invalid keypairs, and invalid stored subjects fail closed without replacement', async (t) => {
  const pair = keypair();
  const other = keypair();
  const invalid = [
    '{"privateKey":"synthetic-secret",',
    JSON.stringify({ ...pair, publicKey: other.publicKey, subject: SUBJECT }),
    JSON.stringify({ ...pair, privateKey: Buffer.alloc(32).toString('base64url'), subject: SUBJECT }),
    JSON.stringify({ ...pair, subject: 'not-a-contact' }),
  ];
  for (const raw of invalid) {
    const root = fixture(t);
    writeFileSync(join(root, PUSH_FILES.config), raw);
    const { manager, calls, logs } = harness({ root });
    assert.equal(manager.status().configured, false);
    assert.equal(manager.publicKey, null);
    assert.match(manager.status().error!, /PUSH_CONFIG_INVALID/);
    assert.throws(() => configurePush({ root, legacyRoot: null, subject: SUBJECT }), /PUSH_CONFIG_INVALID/);
    assert.throws(() => manager.subscribe(subscription()), /PUSH_CONFIG_INVALID/);
    await manager.sendAttention('Reply', 's1', 'ready', 'Synthetic content.');
    assert.equal(calls.length, 0);
    assert.equal(contents(root, PUSH_FILES.config), raw);
    assert.deepEqual(readdirSync(root), [PUSH_FILES.config]);
    assertRedacted([manager.status(), logs], pair.privateKey, 'synthetic-secret', root);
  }
});

test('real subscription keys are validated and endpoint updates deduplicate durably across restart', async (t) => {
  const { root, manager } = configured(t);
  const first = subscription();
  const replacement = subscription(first.endpoint);
  manager.subscribe(first);
  manager.subscribe(replacement);
  manager.subscribe(replacement);
  assert.equal(manager.status(first.endpoint).registered, true);
  assert.equal(manager.status().subscriptionCount, 1);
  assert.deepEqual(storedSubscriptions(root), {
    publicKey: manager.publicKey, subscriptions: [replacement],
  });

  const invalidPoint = Buffer.alloc(65);
  invalidPoint[0] = 4;
  const invalid = { ...subscription(), keys: { ...first.keys, p256dh: invalidPoint.toString('base64url') } };
  assert.equal(PushSubscriptionJson.safeParse(invalid).success, true, 'the shape alone cannot validate the curve');
  const before = contents(root, PUSH_FILES.subscriptions);
  assert.throws(() => manager.subscribe(invalid), /PUSH_SUBSCRIPTION_INVALID/);
  assert.equal(contents(root, PUSH_FILES.subscriptions), before);
  assert.equal(manager.status().subscriptionCount, 1);

  const restarted = harness({ root });
  assert.equal(restarted.manager.status(first.endpoint).registered, true);
  assert.equal((await restarted.manager.test(first.endpoint, true)).status, 'accepted');
  assert.deepEqual(restarted.calls[0]![0], replacement);
  restarted.manager.unsubscribe(first.endpoint);
  assert.deepEqual(storedSubscriptions(root).subscriptions, []);
  assert.equal(harness({ root }).manager.status(first.endpoint).registered, false);
});

test('explicit legacy import preserves original files and keys and uses the subject environment', (t) => {
  const parent = fixture(t);
  const legacyRoot = join(parent, 'legacy');
  const root = join(parent, 'new');
  mkdirSync(legacyRoot);
  const pair = keypair();
  const sub = subscription();
  const originalConfig = JSON.stringify(pair, null, 2);
  const originalSubs = JSON.stringify([sub], null, 2);
  writeFileSync(join(legacyRoot, PUSH_FILES.config), originalConfig);
  writeFileSync(join(legacyRoot, PUSH_FILES.subscriptions), originalSubs);

  const result = configurePush({ root, legacyRoot });
  assert.equal(result.publicKey, pair.publicKey);
  assert.deepEqual(JSON.parse(contents(root, PUSH_FILES.config)), { ...pair, subject: SUBJECT });
  assert.deepEqual(storedSubscriptions(root), { publicKey: pair.publicKey, subscriptions: [sub] });
  for (let restart = 0; restart < 2; restart++) {
    const { manager, calls } = harness({ root, legacyRoot });
    assert.equal(manager.status(sub.endpoint).configured, true);
    assert.equal(manager.status(sub.endpoint).registered, true);
    assert.deepEqual(configurePush({ root, legacyRoot }), result);
    assert.equal(calls.length, 0);
  }
  assert.equal(contents(legacyRoot, PUSH_FILES.config), originalConfig);
  assert.equal(contents(legacyRoot, PUSH_FILES.subscriptions), originalSubs);
  assert.deepEqual(readdirSync(legacyRoot).sort(), Object.values(PUSH_FILES).sort());

  const otherRoot = join(parent, 'unrelated-key');
  configurePush({ root: otherRoot, subject: SUBJECT });
  const mixed = harness({ root: otherRoot, legacyRoot });
  assert.equal(mixed.manager.status(sub.endpoint).configured, false);
  assert.match(mixed.manager.status().error!, /PUSH_KEYS_CHANGED/);
  assert.equal(storedSubscriptions(otherRoot).publicKey, pair.publicKey);
  assert.notEqual(JSON.parse(contents(otherRoot, PUSH_FILES.config)).publicKey, pair.publicKey);

  writeFileSync(join(legacyRoot, PUSH_FILES.subscriptions), '{');
  const brokenTarget = join(parent, 'broken-import');
  assert.throws(() => configurePush({ root: brokenTarget, legacyRoot }), /PUSH_SUBSCRIPTIONS_INVALID/);
  assert.equal(existsSync(brokenTarget), false, 'both legacy files must validate before either is copied');
  assert.equal(contents(legacyRoot, PUSH_FILES.config), originalConfig);
  assert.equal(contents(legacyRoot, PUSH_FILES.subscriptions), '{');
});

test('key rotation is detected both while running and on restart without sending or replacing keys', async (t) => {
  const { root, manager, calls, logs } = configured(t);
  const sub = subscription();
  manager.subscribe(sub);
  const originalSubs = contents(root, PUSH_FILES.subscriptions);
  const rotated = { ...keypair(), subject: SUBJECT };
  new FilePushStorage(root).writeAtomic(PUSH_FILES.config, JSON.stringify(rotated));
  assert.equal(manager.status(sub.endpoint).configured, false);
  assert.match(manager.status().error!, /PUSH_CONFIG_CHANGED/);
  assert.equal(manager.publicKey, null);
  assert.throws(() => manager.subscribe(subscription()), /PUSH_CONFIG_CHANGED/);
  assert.equal((await manager.test(sub.endpoint, true)).status, 'failed');
  await manager.sendAttention('Reply', 's1', 'ready', 'Must not use rotated keys.');
  assert.equal(calls.length, 0);

  const restarted = harness({ root });
  assert.equal(restarted.manager.status().configured, false);
  assert.match(restarted.manager.status().error!, /PUSH_KEYS_CHANGED/);
  assert.throws(() => configurePush({ root, legacyRoot: null }), /PUSH_KEYS_CHANGED/);
  assert.throws(() => restarted.manager.subscribe(subscription()), /PUSH_KEYS_CHANGED/);
  assert.equal((await restarted.manager.test(sub.endpoint, true)).status, 'failed');
  assert.equal(restarted.calls.length, 0);
  assert.equal(contents(root, PUSH_FILES.subscriptions), originalSubs);
  assert.deepEqual(JSON.parse(contents(root, PUSH_FILES.config)), rotated);
  assertRedacted([manager.status(), logs, restarted.logs], sub.endpoint, sub.keys.auth, rotated.privateKey);

  restarted.manager.unsubscribe(sub.endpoint);
  assert.equal(restarted.manager.status().configured, true);
  restarted.manager.subscribe(subscription());
  assert.equal(storedSubscriptions(root).publicKey, rotated.publicKey);
});

test('actual atomic rename failures do not acknowledge or mutate registrations and remain redacted', (t) => {
  const { root, manager, logs, calls } = configured(t);
  const old = subscription();
  const next = subscription();
  manager.subscribe(old);
  const before = contents(root, PUSH_FILES.subscriptions);
  const restore = blockSubscriptionRename(root);
  try {
    assert.throws(() => manager.subscribe(next), /PUSH_STORAGE_WRITE_FAILED/);
    assert.throws(() => manager.unsubscribe(old.endpoint), /PUSH_STORAGE_WRITE_FAILED/);
    const status = PushStatus.parse(manager.status(old.endpoint));
    assert.equal(status.configured, false);
    assert.equal(status.registered, true);
    assert.equal(status.subscriptionCount, 1);
    assert.equal(manager.status(next.endpoint).registered, false);
    assert.equal(manager.status().lastDelivery?.status, 'failed');
    assert.equal(calls.length, 0);
    assertRedacted([status, logs], old.endpoint, next.endpoint, old.keys.auth, next.keys.p256dh, root);
    assert.equal(readdirSync(root).some((name) => name.endsWith('.pending')), false);
  } finally { restore(); }
  assert.equal(contents(root, PUSH_FILES.subscriptions), before);
  const restarted = harness({ root }).manager;
  assert.equal(restarted.status(old.endpoint).registered, true);
  assert.equal(restarted.status(next.endpoint).registered, false);
});

test('read-only storage refuses writes without losing prior registrations', (t) => {
  const { root, manager: original } = configured(t);
  const old = subscription();
  const next = subscription();
  original.subscribe(old);
  const before = contents(root, PUSH_FILES.subscriptions);
  const file = new FilePushStorage(root);
  const canEnforcePermissions = process.platform !== 'win32' && process.getuid?.() !== 0;
  const storage: PushStorage = canEnforcePermissions ? file : {
    read: (name) => file.read(name),
    writeAtomic: () => { throw new Error(`${next.endpoint} ${next.keys.auth} ${root}`); },
  };
  const { manager, logs, calls } = harness({ storage });
  if (canEnforcePermissions) {
    chmodSync(join(root, PUSH_FILES.subscriptions), 0o400);
    chmodSync(root, 0o500);
  }
  try {
    assert.throws(() => manager.subscribe(next), /PUSH_STORAGE_WRITE_FAILED/);
    assert.throws(() => manager.unsubscribe(old.endpoint), /PUSH_STORAGE_WRITE_FAILED/);
    assert.equal(manager.status().configured, false);
    assert.equal(manager.status().subscriptionCount, 1);
    assert.equal(manager.status(old.endpoint).registered, true);
    assert.equal(manager.status(next.endpoint).registered, false);
    assert.equal(contents(root, PUSH_FILES.subscriptions), before);
    assert.equal(calls.length, 0);
    assertRedacted([manager.status(), logs], old.endpoint, next.endpoint, next.keys.auth, root);
  } finally {
    if (canEnforcePermissions) {
      chmodSync(root, 0o700);
      chmodSync(join(root, PUSH_FILES.subscriptions), 0o600);
    }
  }
  assert.equal(harness({ root }).manager.status(old.endpoint).registered, true);
});

test('corrupt subscription reads and actual or injected read failures fail closed', async (t) => {
  const { root, manager: original } = configured(t);
  const sub = subscription();
  original.subscribe(sub);
  const corrupt = '{"subscriptions":"synthetic-read-secret",';
  writeFileSync(join(root, PUSH_FILES.subscriptions), corrupt);
  const broken = harness({ root });
  assert.match(broken.manager.status().error!, /PUSH_SUBSCRIPTIONS_INVALID/);
  assert.throws(() => broken.manager.subscribe(sub), /PUSH_SUBSCRIPTIONS_INVALID/);
  assert.throws(() => configurePush({ root, legacyRoot: null }), /PUSH_SUBSCRIPTIONS_INVALID/);
  await broken.manager.sendAttention('Reply', 's1', 'ready', 'No corrupt-store sends.');
  assert.equal(broken.manager.status().configured, false);
  assert.equal(broken.calls.length, 0);
  assert.equal(contents(root, PUSH_FILES.subscriptions), corrupt);
  assertRedacted([broken.manager.status(), broken.logs], 'synthetic-read-secret', root);

  const unreadable = fixture(t);
  mkdirSync(join(unreadable, PUSH_FILES.config));
  const file = new FilePushStorage(unreadable);
  assert.throws(() => file.read(PUSH_FILES.config), /PUSH_STORAGE_READ_FAILED/);
  const failed = harness({ root: unreadable });
  assert.equal(failed.manager.status().configured, false);
  assert.match(failed.manager.status().error!, /PUSH_STORAGE_READ_FAILED/);
  assert.throws(() => configurePush({ root: unreadable, legacyRoot: null }), /PUSH_STORAGE_READ_FAILED/);
  assert.throws(() => failed.manager.subscribe(sub), /PUSH_STORAGE_READ_FAILED/);
  assert.equal(failed.calls.length, 0);

  const healthy = configured(t);
  healthy.manager.subscribe(sub);
  const disk = new FilePushStorage(healthy.root);
  const raw = contents(healthy.root, PUSH_FILES.subscriptions);
  let failRead = false;
  let writes = 0;
  const injected = harness({ storage: {
    read: (name) => {
      if (failRead) throw new Error(`PUSH_STORAGE_READ_FAILED ${sub.endpoint} ${sub.keys.auth}`);
      return disk.read(name);
    },
    writeAtomic: (...args) => { writes++; disk.writeAtomic(...args); },
  } });
  failRead = true;
  assert.equal(injected.manager.status().configured, false);
  assert.throws(() => injected.manager.subscribe(subscription()), /PUSH_STORAGE_READ_FAILED/);
  assert.equal((await injected.manager.test(sub.endpoint, true)).status, 'failed');
  assert.equal(injected.calls.length, 0);
  assert.equal(writes, 0);
  assert.equal(contents(healthy.root, PUSH_FILES.subscriptions), raw);
  assertRedacted([injected.manager.status(), injected.logs], sub.endpoint, sub.keys.auth, healthy.root);
});

test('test pushes require confirmation and registration and report acceptance, never delivery', async (t) => {
  const { manager, calls, logs } = configured(t);
  const sub = subscription();
  manager.subscribe(sub);
  assert.deepEqual(await manager.test(sub.endpoint, false), {
    status: 'failed', at: NOW, error: 'PUSH_TEST_CONFIRM_REQUIRED',
  });
  assert.deepEqual(await manager.test(subscription().endpoint, true), {
    status: 'failed', at: NOW, error: 'PUSH_NOT_REGISTERED',
  });
  assert.equal(calls.length, 0);
  const result = await manager.test(sub.endpoint, true);
  assert.deepEqual(PushDelivery.parse(result), { status: 'accepted', at: NOW });
  assert.equal('delivered' in result, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]![0], sub);
  const payload = JSON.parse(calls[0]![1]);
  assert.deepEqual(NotificationPayload.parse(payload), payload);
  assert.equal(payload.kind, 'test');
  assert.equal(payload.url, '/');
  assert.match(payload.title, /测试/);
  assert.match(payload.body, /测试/);
  for (const key of ['sessionId', 'unreadCount', 'badge', 'attnId', 'inboxRevision']) {
    assert.equal(key in payload, false, `${key} must be absent from a benign test`);
  }
  assert.deepEqual(manager.status(sub.endpoint).lastDelivery, result);
  assert.equal(manager.status(sub.endpoint).registered, true);
  assertRedacted([manager.status(), manager.status(sub.endpoint), logs, result], sub.endpoint, sub.keys.auth, sub.keys.p256dh);
});

test('404 and 410 prune durably, but failed expiry cleanup reports failure and not-ready status', async (t) => {
  for (const statusCode of [404, 410]) {
    const sender: PushSender = async () => {
      if (statusCode === 404) throw { statusCode, body: 'synthetic-secret' };
      return { statusCode };
    };
    const expired = configured(t, { sender });
    const sub = subscription();
    expired.manager.subscribe(sub);
    assert.deepEqual(await expired.manager.test(sub.endpoint, true), {
      status: 'expired', at: NOW, error: `PUSH_HTTP_${statusCode}: registration expired.`,
    });
    assert.equal(expired.manager.status().configured, true);
    assert.equal(expired.manager.status(sub.endpoint).registered, false);
    assert.equal(expired.manager.status().subscriptionCount, 0);
    assert.deepEqual(storedSubscriptions(expired.root).subscriptions, []);
    const restarted = harness({ root: expired.root });
    assert.equal(restarted.manager.status(sub.endpoint).registered, false);
    assert.equal((await restarted.manager.test(sub.endpoint, true)).status, 'failed');
    assert.equal(restarted.calls.length, 0);

    const blocked = configured(t, { sender });
    blocked.manager.subscribe(sub);
    const before = contents(blocked.root, PUSH_FILES.subscriptions);
    const restore = blockSubscriptionRename(blocked.root);
    try {
      const result = await blocked.manager.test(sub.endpoint, true);
      assert.equal(result.status, 'failed');
      assert.match(result.error!, /PUSH_EXPIRED_CLEANUP_FAILED/);
      assert.equal(blocked.manager.status().configured, false);
      assert.equal(blocked.manager.status().subscriptionCount, 1);
      assert.equal(blocked.manager.status(sub.endpoint).registered, true);
      assert.equal(blocked.manager.status().lastDelivery?.status, 'failed');
      assertRedacted([result, blocked.manager.status(), blocked.logs], sub.endpoint, sub.keys.auth, 'synthetic-secret');
    } finally { restore(); }
    assert.equal(contents(blocked.root, PUSH_FILES.subscriptions), before);
    assert.equal(harness({ root: blocked.root }).manager.status(sub.endpoint).registered, true);
  }
});

test('transport errors never expose endpoint, auth, keys, response bodies, or causes', async (t) => {
  let failure: unknown;
  const { root, manager, logs, calls } = configured(t, { sender: async () => { throw failure; } });
  const sub = subscription();
  manager.subscribe(sub);
  const config = JSON.parse(contents(root, PUSH_FILES.config));
  const secrets = [sub.endpoint, sub.keys.auth, sub.keys.p256dh, config.privateKey];
  const leaked = secrets.join(' ');
  const before = contents(root, PUSH_FILES.subscriptions);
  for (const [statusCode, expected] of [
    [401, 'PUSH_HTTP_401'], [429, 'PUSH_HTTP_429'], [503, 'PUSH_HTTP_503'],
    [undefined, 'PUSH_TRANSPORT_FAILED: request failed or timed out.'],
  ] as const) {
    failure = Object.assign(new Error(leaked, { cause: new Error(leaked) }), {
      statusCode, endpoint: sub.endpoint, headers: { authorization: leaked },
      body: leaked, subscription: sub, privateKey: config.privateKey,
    });
    const result = await manager.test(sub.endpoint, true);
    assert.deepEqual(result, { status: 'failed', at: NOW, error: expected });
    assert.deepEqual(logs.at(-1), result);
    assert.equal(manager.status(sub.endpoint).registered, true);
    assert.equal(manager.status().subscriptionCount, 1);
    assertRedacted([result, manager.status(), manager.status(sub.endpoint), logs], ...secrets);
  }
  assert.equal(calls.length, 4);
  assert.equal(contents(root, PUSH_FILES.subscriptions), before);
  assert.equal(harness({ root }).manager.status(sub.endpoint).registered, true);
});

test('ready and choice payloads retain concrete text, encoded targets, shared metadata, and byte bounds', async (t) => {
  const { manager, calls } = configured(t);
  manager.subscribe(subscription());
  const sessionId = 'project/选择 ?#%';
  const metadata = { attnId: 7, inboxRevision: 12 };
  for (const [kind, prefix, body] of [
    ['ready', '新回复', '分析已完成：这次只修改了测试文件。'],
    ['choice', '需要选择', '请选择下一步：继续验证还是查看结果？'],
  ] as const) {
    await manager.sendAttention('推送验证', sessionId, kind, body, 0, metadata);
    const raw = JSON.parse(calls.at(-1)![1]);
    assert.deepEqual(NotificationPayload.parse(raw), raw);
    assert.deepEqual(raw, {
      type: 'notification', kind, title: `${prefix} · 推送验证`, body,
      sessionId, tag: sessionId, url: `/session/${encodeURIComponent(sessionId)}`,
      unreadCount: 0, badge: 0, ...metadata,
    });
  }
  const longBody = '具体回复🙂'.repeat(700);
  await manager.sendAttention('长标题🙂'.repeat(300), sessionId, 'ready', longBody, 0, metadata);
  assert.equal(calls.length, 3);
  const json = calls.at(-1)![1];
  const bounded = NotificationPayload.parse(JSON.parse(json));
  assert.ok(Buffer.byteLength(json) <= 3000);
  assert.ok(Buffer.byteLength(bounded.body) <= 1200);
  assert.ok(Buffer.byteLength(bounded.body) >= 1196);
  assert.ok(longBody.startsWith(bounded.body));
  assert.equal(bounded.body.includes('\uFFFD'), false);
  assert.equal(bounded.unreadCount, 0);

  await manager.sendAttention('Reply', '界'.repeat(256), 'ready', longBody, 0, metadata);
  assert.equal(calls.length, 3, 'aggregate oversized payload must not reach the sender');
  assert.match(manager.status().lastDelivery?.error ?? '', /PUSH_PAYLOAD_INVALID/);
});

test('overlapping broadcasts and test requests share a bounded sender concurrency limit', async (t) => {
  let active = 0;
  let maximum = 0;
  const releases: (() => void)[] = [];
  const { manager, calls } = configured(t, {
    concurrency: 2,
    sender: async () => {
      active++;
      maximum = Math.max(maximum, active);
      try { await new Promise<void>((resolve) => releases.push(resolve)); }
      finally { active--; }
      return { statusCode: 201 };
    },
  });
  const subs = Array.from({ length: 5 }, () => subscription());
  for (const sub of subs) manager.subscribe(sub);
  const jobs = [
    manager.sendAttention('First', 's1', 'ready', 'First concrete reply.'),
    manager.sendAttention('Second', 's2', 'choice', 'Which option?'),
    ...Array.from({ length: 6 }, () => manager.test(subs[0]!.endpoint, true)),
  ];
  let settled = false;
  const done = Promise.all(jobs).finally(() => { settled = true; });
  const initialCalls = calls.length;
  for (let batch = 0; batch < 20 && !settled; batch++) {
    for (const release of releases.splice(0)) release();
    await setImmediate();
  }
  assert.equal(settled, true, 'all bounded queued requests must make progress');
  await done;
  assert.equal(initialCalls, 2, 'excess requests must wait rather than start');
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(calls.length, 16);
  assert.equal(manager.status().lastDelivery?.status, 'accepted');
});

test('sender timeout options bound timed-out work without overlapping requests or pruning registrations', async (t) => {
  let active = 0;
  let maximum = 0;
  const { root, manager, calls, logs } = configured(t, {
    concurrency: 1, timeoutMs: 100,
    sender: async (sub) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await setTimeout(100);
        throw Object.assign(new Error(`${sub.endpoint} ${sub.keys.auth}`), { code: 'ETIMEDOUT' });
      } finally { active--; }
    },
  });
  const subs = Array.from({ length: 3 }, () => subscription());
  for (const sub of subs) manager.subscribe(sub);
  await manager.sendAttention('Reply', 's1', 'ready', 'A synthetic timed-out notification.');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(([, , options]) => options.timeout), [100, 100, 100]);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.equal(manager.status().lastDelivery?.status, 'failed');
  assert.equal(manager.status().subscriptionCount, 3);
  assert.deepEqual(logs, Array.from({ length: 3 }, () => ({
    status: 'failed', at: NOW, error: 'PUSH_TRANSPORT_FAILED: request failed or timed out.',
  })));
  assertRedacted([manager.status(), logs], ...subs.flatMap((sub) => [sub.endpoint, sub.keys.auth, sub.keys.p256dh]));
  assert.equal(harness({ root }).manager.status().subscriptionCount, 3);
});

test('encrypted HTTP sender cancels stalled and truncated responses and releases slots', { timeout: 5000 }, async (t) => {
  const modes = ['abort', 'close', 'request-close', 'stall', 'success', 'expired'] as const;
  let requests = 0;
  let destroyed = 0;
  const encrypted: Buffer[] = [];
  const request = ((_url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    assert.equal(options.method, 'POST');
    assert.equal((options.headers as Record<string, string>)['Content-Encoding'], 'aes128gcm');
    const mode = modes[requests++];
    const req = Object.assign(new EventEmitter(), {
      destroy: () => { destroyed++; return req; },
      end: (body: Buffer) => {
        encrypted.push(body);
        queueMicrotask(() => {
          if (mode === 'stall') return;
          if (mode === 'request-close') { req.emit('close'); return; }
          const res = Object.assign(new EventEmitter(), {
            statusCode: mode === 'expired' ? 410 : 201,
            complete: false,
            destroy: () => res,
            resume: () => res,
          });
          callback(res as unknown as IncomingMessage);
          if (mode === 'abort') res.emit('aborted');
          else if (mode === 'close') res.emit('close');
          else {
            res.complete = true;
            res.emit('end');
          }
        });
        return req;
      },
    });
    return req as unknown as ClientRequest;
  }) as typeof https.request;
  const { manager } = configured(t, {
    sender: createPushSender(request), concurrency: 1, timeoutMs: 100,
  });
  const sub = subscription();
  manager.subscribe(sub);
  const results = await Promise.all(modes.map(() => manager.test(sub.endpoint, true)));
  assert.deepEqual(results.map((result) => result.status), ['failed', 'failed', 'failed', 'failed', 'accepted', 'expired']);
  assert.equal(requests, 6, 'every queued request progressed after a failed response');
  assert.equal(destroyed, 5);
  assert.ok(encrypted.every((body) => Buffer.isBuffer(body) && !body.includes('推送测试')));
  assert.equal(manager.status(sub.endpoint).registered, false);
});
