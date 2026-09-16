import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { NativeObservation } from '@cockpit/module-api';
import { ModuleHost } from './module-host.ts';
import { installLocalModule, selectModule } from './module-install.ts';

async function writableTree(root: string): Promise<void> {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) return;
  await chmod(root, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) {
    for (const name of await readdir(root)) await writableTree(join(root, name));
  }
}

test('independently packaged file module installs and serves uploads and new native snapshots without an SDK process', {
  skip: !process.env.COCKPIT_FILE_MODULE_ARCHIVE, timeout: 30_000,
}, async t => {
  const archive = resolve(process.env.COCKPIT_FILE_MODULE_ARCHIVE!);
  const root = await mkdtemp(fileURLToPath(new URL('../../../node_modules/file-module-integration-', import.meta.url)));
  const hostRoot = join(root, 'home', '.cockpit');
  const sources = join(root, 'sources');
  await mkdir(sources);
  const observers = new Set<(event: NativeObservation) => void | Promise<void>>();
  const observer = {
    onNativeEvent(handler: (event: NativeObservation) => void | Promise<void>) {
      observers.add(handler);
      return () => { observers.delete(handler); };
    },
  };
  const errors: unknown[] = [];
  const host = new ModuleHost({ hostRoot, observer, report: (_id, error) => { errors.push(error); } });
  const app = Fastify();
  t.after(async () => {
    host.close();
    await app.close();
    await writableTree(root);
    await rm(root, { recursive: true, force: true });
  });
  const installed = await installLocalModule(archive, { hostRoot, trustLocalCode: true, enable: true });
  assert.equal(installed.manifest.id, 'cockpit-file');
  await host.register(app);
  await app.ready();
  const bootstrap = (await app.inject('/_modules')).json();
  assert.deepEqual(bootstrap.errors, []);
  assert.equal(bootstrap.modules.length, 1);
  const module = host.bootstrap().modules[0]!;
  assert.equal(module.digest, installed.digest);
  assert.ok(module.apiBase.includes(installed.digest));
  assert.equal((await app.inject(module.entry)).statusCode, 200);
  const sharedUrl = new URL('../shared/files.js', `http://127.0.0.1${module.entry}`).pathname;
  assert.equal((await app.inject(sharedUrl)).statusCode, 200);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==', 'base64');
  const upload = await app.inject({
    method: 'POST', url: `${module.apiBase}/upload?name=fixture.png&operationId=fixture-upload`,
    headers: { 'content-type': 'application/octet-stream', 'x-cockpit-module-digest': module.digest },
    payload: png,
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const file = upload.json();
  assert.equal(file.attachment.type, 'file');
  assert.ok(file.attachment.path.startsWith(String(module.config.nativePathPrefix)));
  assert.equal((await app.inject({ method: 'HEAD', url: file.url })).headers['content-length'], String(png.length));
  const image = await app.inject(file.url);
  assert.equal(image.statusCode, 200);
  assert.deepEqual(image.rawPayload, png);
  assert.match(String(image.headers['content-type']), /^image\/png/);
  assert.equal((await app.inject({
    method: 'HEAD', url: file.url, headers: { 'x-cockpit-module-digest': '0'.repeat(64) },
  })).statusCode, 409);

  const source = join(sources, 'result.txt');
  await writeFile(source, 'first version');
  let serial = 0;
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const messageIdentity = (label: string) => `33333333-3333-4333-8333-333333333333-${label}`;
  const emit = async (type: string, messageId: string, content: string) => {
    const event: NativeObservation = {
      sessionId, cwd: sources,
      event: {
        id: `fixture-event-${++serial}`, type, timestamp: new Date().toISOString(),
        ...(type !== 'assistant.message' ? { ephemeral: true } : {}),
        data: type === 'assistant.message_delta'
          ? { messageId: messageIdentity(messageId), deltaContent: content } : { messageId: messageIdentity(messageId), content },
      },
    };
    for (const handle of observers) await handle(event);
  };
  const messageUrl = (id: string) => `${module.apiBase}/messages/${Buffer.from(JSON.stringify([
    sessionId, messageIdentity(id), './result.txt',
  ])).toString('base64url')}`;
  const waitReady = async (url: string) => {
    const deadline = Date.now() + 5000;
    let result = await app.inject({ method: 'HEAD', url });
    while ([202, 404].includes(result.statusCode) && Date.now() < deadline) {
      await delay(10);
      result = await app.inject({ method: 'HEAD', url });
    }
    assert.equal(result.statusCode, 200, result.body);
  };
  await emit('assistant.message', 'old', '[old](./result.txt)');
  assert.equal((await app.inject(messageUrl('old'))).statusCode, 404);
  await emit('assistant.message_start', 'first', '');
  await emit('assistant.message_delta', 'first', '[result](./res');
  assert.equal((await app.inject({ method: 'HEAD', url: messageUrl('first') })).statusCode, 404);
  await emit('assistant.message_delta', 'first', 'ult.txt)');
  await waitReady(messageUrl('first'));
  await writeFile(source, 'second version');
  await emit('assistant.message', 'first', '[result](./result.txt)');
  await emit('assistant.message_start', 'second', '');
  await emit('assistant.message_delta', 'second', '[result](./result.txt)');
  await waitReady(messageUrl('second'));
  assert.equal((await app.inject(messageUrl('first'))).body, 'first version');
  assert.equal((await app.inject(messageUrl('second'))).body, 'second version');
  assert.equal(errors.length, 1, 'Only the deliberate stale-version request should be reported');
  const reported = errors[0];
  assert.ok(reported instanceof Error && 'code' in reported);
  assert.equal(reported.code, 'MODULE_VERSION_MISMATCH');

  await selectModule(module.id, { hostRoot, enabled: false });
  assert.equal(host.bootstrap().modules.length, 1, 'Selection changes cannot hot-unload an active module');
  host.close();
  await app.close();
  assert.equal(observers.size, 0);
  const next = new ModuleHost({ hostRoot, observer });
  const nextApp = Fastify();
  try {
    await next.register(nextApp);
    await nextApp.ready();
    assert.equal(next.bootstrap().modules.length, 0);
    assert.deepEqual(await readFile(file.attachment.path), png);
  } finally { next.close(); await nextApp.close(); }
});
