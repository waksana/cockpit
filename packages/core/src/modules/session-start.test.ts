import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Intents, type IntentBody } from '@cockpit/protocol';
import type { InternalSessionStart } from '../engine.ts';
import { SessionStartCoordinator, SessionStartFailure, type PreparedSessionStart } from './session-start.ts';

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(process.cwd(), '.first-message-')), userRoot = join(root, 'u');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const effects = { preparations: 0, associations: 0, creates: 0, sends: 0 };
  const supplied: InternalSessionStart[] = [];
  let fail: 'create' | 'ready' | 'send' | undefined;
  let pause: Promise<unknown> | undefined;
  const input: IntentBody<'session/start'> = { operationId: 'first-real-operation', cwd: root, text: 'private first message' };
  const engine = { async startSession(body: InternalSessionStart): Promise<{ ok: true }> {
    supplied.push(body);
    assert.equal(JSON.parse(readFileSync(join(userRoot, 'session-starts', `${body.operationId}.json`), 'utf8')).operation.state, 'creating');
    await body.beforeCreate?.(body.sessionId);
    effects.creates++;
    writeFileSync(join(root, `${body.sessionId}.created`), 'native creation side effect');
    if (fail === 'create') throw new Error('native creation acknowledgement lost');
    if (pause) await pause;
    if (fail === 'ready') throw new Error('role readiness failed');
    effects.sends++;
    writeFileSync(join(root, `${body.sessionId}.sent`), 'native send side effect');
    if (fail === 'send') throw new Error('private first message may have been accepted');
    return { ok: true };
  } };
  const prepare = (body: IntentBody<'session/start'>): PreparedSessionStart => {
    effects.preparations++;
    return { text: body.text, associate: id => {
      effects.associations++;
      writeFileSync(join(root, `${id}.associated`), 'retained artifacts associated with planned identity');
    } };
  };
  const coordinator = new SessionStartCoordinator({ userRoot, engine, prepare });
  return { root, userRoot, input, engine, prepare, coordinator, effects, supplied,
    fail(value: typeof fail) { fail = value; }, pause(value: Promise<unknown>) { pause = value; } };
}

test('session/start rejects blank or invalid content before allocating any identity or receipt', async t => {
  const f = fixture(t);
  for (const content of [
    { text: '' }, { text: ' \n\t ' }, { text: '', parts: [{ type: 'text', text: ' ' }] },
    { text: '', attachments: [] }, { text: '', parts: [] },
    { text: 'text', parts: [{ type: 'text', text: 'part' }] },
    { text: '', attachment: { kind: 'file', name: 'a', url: '/etc/passwd' } },
    { text: '', attachment: { kind: 'file', name: 'a', url: '/uploads/a' }, attachments: [{ kind: 'file', name: 'b', url: '/uploads/b' }] },
    { text: 'real', sessionId: randomUUID() },
  ]) {
    await assert.rejects(f.coordinator.start({ ...f.input, ...content } as IntentBody<'session/start'>));
  }
  assert.deepEqual(f.effects, { preparations: 0, associations: 0, creates: 0, sends: 0 });
  assert.equal(existsSync(f.userRoot), false);
  assert.equal(f.coordinator.get(f.input.operationId), null);
  assert.equal(Intents['session/new'].body.safeParse({ cwd: f.root }).success, true, 'legacy low-level creation remains compatible');
});

test('session/start accepts text, files and ordered parts with existing prompt form rules', () => {
  const file = { kind: 'file' as const, name: 'file', url: '/uploads/file.txt' };
  for (const content of [
    { text: 'real text' }, { text: '', attachment: file }, { text: '', attachments: [file] },
    { text: '', parts: [{ type: 'text', text: ' first ' }] },
    { text: '', parts: [{ type: 'file', attachment: file }] },
  ]) assert.equal(Intents['session/start'].body.safeParse({ operationId: 'valid-operation', cwd: '/fixture', ...content }).success, true);
  const tooMany = Array.from({ length: 21 }, () => ({ type: 'file', attachment: file }));
  assert.equal(Intents['session/start'].body.safeParse({ operationId: 'valid-operation', cwd: '/fixture', text: '', parts: tooMany }).success, false);
});

test('managed resolution failure precedes claim, native create and artifact association', async t => {
  const f = fixture(t);
  const coordinator = new SessionStartCoordinator({ userRoot: f.userRoot, engine: f.engine,
    prepare: () => { throw new Error('managed upload missing or corrupt'); } });
  await assert.rejects(coordinator.start({ ...f.input, text: '', attachment: { kind: 'file', name: 'x', url: '/uploads/missing' } }), /missing/);
  assert.equal(existsSync(f.userRoot), false);
  assert.equal(f.effects.creates, 0);
  assert.equal(f.effects.associations, 0);
});

test('first-message failure preserves its cause without copying it into the durable receipt or public result', async t => {
  const f = fixture(t);
  f.fail('ready');
  await assert.rejects(f.coordinator.start(f.input), error => {
    assert.ok(error instanceof SessionStartFailure);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, 'role readiness failed');
    assert.equal(JSON.stringify(error).includes('role readiness failed'), false);
    return true;
  });
  const receipt = readFileSync(join(f.userRoot, 'session-starts', `${f.input.operationId}.json`), 'utf8');
  assert.equal(receipt.includes('role readiness failed'), false);
  assert.equal(receipt.includes(f.input.text), false);
  assert.equal(f.coordinator.get(f.input.operationId)?.state, 'unknown');
});

test('durable start claims precede native effects, duplicate success is readback-only and contains no message text', async t => {
  const f = fixture(t);
  const result = await f.coordinator.start(f.input);
  assert.equal(result.state, 'accepted');
  assert.match(result.sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(f.supplied[0]?.sessionId, result.sessionId);
  assert.deepEqual(await f.coordinator.start(f.input), result);
  const reopened = new SessionStartCoordinator({ userRoot: f.userRoot, engine: f.engine, prepare: () => { throw new Error('duplicate must not resolve files'); } });
  assert.deepEqual(await reopened.start(f.input), result);
  assert.deepEqual(f.effects, { preparations: 1, associations: 1, creates: 1, sends: 1 });
  const file = join(f.userRoot, 'session-starts', `${f.input.operationId}.json`);
  assert.equal(readFileSync(file, 'utf8').includes(f.input.text), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.userRoot, 'session-starts')).mode & 0o777, 0o700);
  await assert.rejects(reopened.start({ ...f.input, text: 'changed input' }), /different first-message/);
  assert.equal(f.effects.sends, 1);
});

test('concurrent duplicate while creating never dispatches or associates another first message', async t => {
  const f = fixture(t), paused = gate();
  f.pause(paused.promise);
  const starting = f.coordinator.start(f.input);
  await Promise.resolve(); await Promise.resolve();
  const current = f.coordinator.get(f.input.operationId)!;
  assert.equal(current.state, 'creating');
  const second = new SessionStartCoordinator({ userRoot: f.userRoot, engine: f.engine, prepare: f.prepare });
  const duplicate = await second.start(f.input);
  assert.equal(duplicate.state, 'creating');
  assert.equal(duplicate.sessionId, current.sessionId);
  assert.equal(f.effects.creates, 1);
  assert.equal(f.effects.sends, 0);
  paused.resolve();
  assert.equal((await starting).state, 'accepted');
  assert.equal(f.effects.creates, 1);
  assert.equal(f.effects.sends, 1);
});

test('competing preparations claim just one identity and create/send once', async t => {
  const f = fixture(t), prepared = gate();
  const options = { userRoot: f.userRoot, engine: f.engine, prepare: async (input: IntentBody<'session/start'>) => {
    await prepared.promise; return f.prepare(input);
  } };
  const a = new SessionStartCoordinator(options), b = new SessionStartCoordinator(options);
  const first = a.start(f.input), second = b.start(f.input);
  assert.equal(existsSync(f.userRoot), false);
  prepared.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0]!.sessionId, results[1]!.sessionId);
  assert.equal(f.effects.creates, 1);
  assert.equal(f.effects.sends, 1);
  assert.equal(readdirSync(join(f.userRoot, 'session-starts')).length, 1);
});

test('creation, readiness and lost send acceptance failures retain the original planned identity without replay', async t => {
  for (const failure of ['create', 'ready', 'send'] as const) await t.test(failure, async inner => {
    const f = fixture(inner);
    f.fail(failure);
    await assert.rejects(f.coordinator.start(f.input), error => {
      assert.ok(error instanceof SessionStartFailure);
      assert.equal(error.operation.state, 'unknown');
      assert.equal(error.sessionId, f.supplied[0]?.sessionId);
      return true;
    });
    const operation = f.coordinator.get(f.input.operationId)!;
    assert.equal(operation.state, 'unknown');
    assert.ok(existsSync(join(f.root, `${operation.sessionId}.associated`)));
    f.fail(undefined);
    const reopened = new SessionStartCoordinator({ userRoot: f.userRoot, engine: f.engine, prepare: f.prepare });
    assert.deepEqual(await reopened.start(f.input), operation);
    assert.equal(f.effects.creates, 1);
    assert.equal(f.effects.sends, failure === 'send' ? 1 : 0);
    assert.equal(readFileSync(join(f.userRoot, 'session-starts', `${f.input.operationId}.json`), 'utf8').includes('private first message'), false);
  });
});

test('interrupted persisted creating reads unknown passively and repeated request never resumes it', async t => {
  const f = fixture(t);
  const done = await f.coordinator.start(f.input);
  const file = join(f.userRoot, 'session-starts', `${f.input.operationId}.json`);
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  receipt.operation.state = 'creating';
  writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  const before = readFileSync(file, 'utf8');
  const reopened = new SessionStartCoordinator({ userRoot: f.userRoot, engine: f.engine, prepare: f.prepare });
  const unknown = reopened.get(f.input.operationId)!;
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.sessionId, done.sessionId);
  assert.deepEqual(await reopened.start(f.input), unknown);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(f.effects.sends, 1);
});

test('stale exclusive claim is never stolen and cannot allocate another planned identity', async t => {
  const f = fixture(t);
  mkdirSync(join(f.userRoot, 'session-starts'), { recursive: true, mode: 0o700 });
  const lock = join(f.userRoot, 'session-starts', `${f.input.operationId}.lock`);
  writeFileSync(lock, '{"pid":99999999}', { mode: 0o600 });
  await assert.rejects(f.coordinator.start(f.input), /locked/);
  assert.equal(f.coordinator.get(f.input.operationId), null);
  assert.deepEqual(readdirSync(join(f.userRoot, 'session-starts')), [`${f.input.operationId}.lock`]);
  assert.equal(f.effects.creates, 0);
});

function driver(userRoot: string, root: string, input: IntentBody<'session/start'>, mode = 'normal') {
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./session-start-driver.fixture.mjs', import.meta.url).pathname,
    userRoot, root, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value.toString(); });
  child.stderr.on('data', value => { stderr += value.toString(); });
  child.stdin.end(JSON.stringify(input));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('two processes observe one durable identity and never create or send twice', async t => {
  const f = fixture(t);
  const first = driver(f.userRoot, f.root, f.input);
  try {
    for (let attempt = 0; attempt < 500 && !f.coordinator.get(f.input.operationId); attempt++) await sleep(10);
    const planned = f.coordinator.get(f.input.operationId);
    assert.ok(planned);
    const duplicate = await driver(f.userRoot, f.root, f.input);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).state, 'unknown', 'a different process cannot claim the original in-flight executor is still active');
    assert.equal(JSON.parse(duplicate.stdout).sessionId, planned.sessionId);
    assert.equal(readdirSync(f.root).filter(name => name.endsWith('.native-create')).length, 1);
    assert.equal(readdirSync(f.root).filter(name => name.endsWith('.native-send')).length, 0);
  } finally {
    writeFileSync(join(f.root, 'release'), 'release synthetic send');
    assert.equal((await first).code, 0);
  }
  assert.equal(f.coordinator.get(f.input.operationId)?.state, 'accepted');
  assert.equal(readdirSync(f.root).filter(name => name.endsWith('.native-send')).length, 1);
});

test('process interruption after durable claim but before native creation remains unknown without restart', async t => {
  const f = fixture(t);
  const failed = await driver(f.userRoot, f.root, f.input, 'crash-before-create');
  assert.equal(failed.code, 17);
  const operation = f.coordinator.get(f.input.operationId);
  assert.equal(operation?.state, 'unknown');
  assert.equal(readdirSync(f.root).filter(name => name.endsWith('.native-create')).length, 0);
  const duplicate = await driver(f.userRoot, f.root, f.input);
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.deepEqual(JSON.parse(duplicate.stdout), operation);
  assert.equal(readdirSync(f.root).filter(name => name.endsWith('.native-send')).length, 0);
});
