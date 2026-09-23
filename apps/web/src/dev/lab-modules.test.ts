import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { labModuleHandler, loadLabModules } from '../../lab-modules';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-module-lab-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist/web'), { recursive: true });
  await mkdir(join(root, 'dist/server'), { recursive: true });
  const manifest = {
    apiVersion: 1, id: 'cockpit-file', name: 'Synthetic Files', version: '0.2.0',
    backend: 'dist/server/index.js',
    frontend: {
      entry: 'dist/web/index.js', styles: ['dist/web/styles.css'], assets: ['dist/web'],
    },
  };
  const content = new Map([
    ['cockpit.module.json', JSON.stringify(manifest)],
    ['dist/web/index.js', 'export const entry = true;'],
    ['dist/web/styles.css', '.entry-fixture { color: black; }'],
    ['dist/server/index.js', 'throw new Error("Backend must never execute");'],
  ]);
  const files: { path: string; bytes: number; sha256: string }[] = [];
  for (const [path, value] of content) {
    await writeFile(join(root, path), value);
    files.push({ path, bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') });
  }
  await writeFile(join(root, 'module-build.json'), JSON.stringify({
    format: 1, product: manifest.id, version: manifest.version, sourceSha: 'a'.repeat(40), files,
  }));
  return root;
}

test('module lab serves only inventoried frontend assets from clean receipt-bound packages', async t => {
  const root = await fixture(t);
  const loaded = await loadLabModules({ file: root });
  assert.equal(loaded.modules.length, 1);
  const [module] = loaded.modules;
  assert.match(module.digest, /^[a-f0-9]{64}$/);
  assert.ok(loaded.assets.has(module.entry));
  assert.deepEqual(module.styles.map(style => loaded.assets.has(style)), [true]);
  assert.equal([...loaded.assets.keys()].some(path => path.includes('/server/')), false);
  await assert.rejects(loadLabModules({ file: 'relative' }), /absolute/);
  await writeFile(join(root, 'dist/web/index.js'), 'tampered');
  await assert.rejects(loadLabModules({ file: root }), /Unsafe|receipt/);
});

test('synthetic file requests cover actual upload shape, media and discard without a backend', async t => {
  const loaded = await loadLabModules({ file: await fixture(t) });
  const handler = labModuleHandler(loaded);
  const server = createServer((request, response) => {
    void handler.handle(request, response).then(handled => {
      if (!handled) response.writeHead(404).end('Unknown synthetic route');
    }, error => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { handler.dispose(); server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const bootstrap = await (await fetch(`${origin}/_modules`)).json();
  assert.equal(bootstrap.modules[0].id, 'cockpit-file');
  const module = loaded.modules[0];
  const api = `${origin}${module.apiBase}`;
  const result = await (await fetch(`${api}/upload?name=synthetic.png&operationId=synthetic-operation`, {
    method: 'POST', headers: { 'x-file-mime': 'image/png' }, body: new Uint8Array([1, 2, 3]),
  })).json();
  assert.equal(result.attachment.type, 'file');
  assert.match(result.attachment.path, /^\/synthetic\/lab\/files\/f_[a-f0-9]{64}\/ready\/body$/);
  const url = `${api}/files/${result.fileId}/body`;
  const metadata = await fetch(url, { method: 'HEAD' });
  assert.equal(metadata.headers.get('content-type'), 'image/png');
  assert.equal(metadata.headers.get('content-length'), '3');
  assert.deepEqual(new Uint8Array(await (await fetch(url)).arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal((await fetch(`${api}/uploads/synthetic-operation`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(`${origin}/intent/prompt`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${origin}${module.entry}`)).headers.get('content-type'), 'text/javascript');
  assert.equal((await fetch(`${origin}/_modules/assets/cockpit-file/${module.digest}/dist/server/index.js`)).status, 404);
});
