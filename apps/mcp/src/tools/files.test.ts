import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { MOCK_ORIGIN, mockHttp, type MockResponse, type ReceivedRequest } from '../../test-support/mock-http.ts';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

const originalCwd = process.cwd();
const fixture = resolve(`.mcp-file-fixture-${randomUUID()}`);
const work = join(fixture, 'workspace');
const sources = join(fixture, 'sources');
const outside = join(fixture, 'outside');
const extra = join(fixture, 'extra-downloads');
const home = join(fixture, 'home');
const temporary = join(fixture, 'artifacts');
await mkdir(work, { recursive: true });
await mkdir(sources);
await mkdir(outside);
await mkdir(extra);
await mkdir(home);
await mkdir(temporary);
const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
  COCKPIT_URL: process.env.COCKPIT_URL,
  COCKPIT_API_TOKEN: process.env.COCKPIT_API_TOKEN,
  COCKPIT_TIMEOUT_MS: process.env.COCKPIT_TIMEOUT_MS,
  COCKPIT_UPLOAD_DIRS: process.env.COCKPIT_UPLOAD_DIRS,
  COCKPIT_DOWNLOAD_DIRS: process.env.COCKPIT_DOWNLOAD_DIRS,
};

const requests: ReceivedRequest[] = [];
let respond: (res: MockResponse, request: ReceivedRequest) => void;
let onWrite: ((chunk: Buffer) => void | Promise<void>) | undefined;
mockHttp((response, request) => {
  requests.push(request);
  respond(response, request);
}, chunk => onWrite?.(chunk));
process.env.COCKPIT_API_TOKEN = 'file-test-token';
delete process.env.COCKPIT_TIMEOUT_MS;
process.env.HOME = process.env.USERPROFILE = home;
process.env.TMPDIR = process.env.TMP = process.env.TEMP = temporary;
process.chdir(work);

// Import only after configuring the mock origin: config is cached on first import.
const { COCKPIT_URL } = await import('../config.ts');
assert.equal(COCKPIT_URL, MOCK_ORIGIN);
const { CockpitError, MAX_TRANSFER_BYTES } = await import('../cockpit.ts');
const { downloadFile, uploadFile, validateUploadUrl } = await import('../file-client.ts');
const { registerFileTools, resolveUploadPath } = await import('./files.ts');
const mcp = new McpServer({ name: 'file-test-server', version: '1.0.0' });
registerFileTools(mcp);
const client = new Client({ name: 'file-test-client', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await mcp.connect(serverTransport);
await client.connect(clientTransport);
after(async () => {
  await client.close();
  await mcp.close();
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
});

const storedUrl = '/uploads/1788750000000-a1b2c3d4e5f6.png';
const image = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

beforeEach(async () => {
  process.env.COCKPIT_UPLOAD_DIRS = sources;
  delete process.env.COCKPIT_DOWNLOAD_DIRS;
  for (const dir of [work, sources, outside, extra]) {
    for (const child of await readdir(dir)) await rm(join(dir, child), { recursive: true, force: true });
  }
  requests.length = 0;
  onWrite = undefined;
  respond = (response, request) => {
    if (request.method === 'POST' && request.url.startsWith('/upload?')) {
      const url = new URL(request.url, COCKPIT_URL);
      const mime = url.searchParams.get('mime') ?? 'application/octet-stream';
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        kind: mime.startsWith('image/') ? 'image' : 'file',
        name: url.searchParams.get('name'),
        url: storedUrl,
        path: '/remote-backend-only/uploads/image.png',
        storedName: '1788750000000-a1b2c3d4e5f6.png',
        mime,
        size: request.body.length,
      }));
    } else {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length });
      response.end(image);
    }
  };
});

const ToolReply = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
});
async function call(name: string, args: Record<string, unknown>) {
  const result = ToolReply.parse(await client.callTool({ name, arguments: args }));
  assert.ok(result.content[0]);
  return { error: result.isError, text: result.content[0].text };
}
async function absent(path: string) {
  await assert.rejects(() => stat(path), { code: 'ENOENT' });
}

test('upload source guard accepts explicit roots, not arbitrary workspace or backend state', async () => {
  const path = join(sources, 'report.txt');
  await writeFile(path, 'hello');
  assert.equal(await resolveUploadPath(path), await realpath(path));
  await writeFile(join(outside, 'private.txt'), 'private fixture');
  await assert.rejects(() => resolveUploadPath(join(outside, 'private.txt')), /outside the allowed upload directories/);
  await assert.rejects(() => resolveUploadPath('report.txt'), /absolute path is required/);
  await assert.rejects(() => resolveUploadPath(`${sources}/../outside/private.txt`), /traversal/);
  await assert.rejects(() => resolveUploadPath(join(sources, 'missing')), /cannot resolve/);
  await assert.rejects(() => resolveUploadPath(sources), /not a regular file/);
  await symlink(join(outside, 'private.txt'), join(sources, 'escape'));
  await assert.rejects(() => resolveUploadPath(join(sources, 'escape')), /outside the allowed upload directories/);
  await symlink(path, join(sources, 'internal'));
  assert.equal(await resolveUploadPath(join(sources, 'internal')), await realpath(path));
  assert.equal(requests.length, 0);
});

test('path-delimited source extensions require absolute roots', async () => {
  process.env.COCKPIT_UPLOAD_DIRS = [sources, outside].join(delimiter);
  await writeFile(join(outside, 'report.txt'), 'allowed fixture');
  assert.equal(await resolveUploadPath(join(outside, 'report.txt')), await realpath(join(outside, 'report.txt')));
  process.env.COCKPIT_UPLOAD_DIRS = 'relative-root';
  await assert.rejects(() => resolveUploadPath(join(sources, 'report.txt')), /must contain only absolute directories/);
});

test('download preserves original response filename as display metadata without changing its destination', async () => {
  respond = response => {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': 8,
      'content-disposition': "attachment; filename*=UTF-8''%E5%8E%9F%E7%A8%BF%20%25.txt" });
    response.end('original');
  };
  const path = join(work, 'chosen-destination.bin');
  const result = await downloadFile('/uploads/managed-source.txt', path);
  assert.equal(result.name, '原稿 %.txt');
  assert.equal(result.path, path);
  assert.equal((await readFile(path)).toString(), 'original');
  assert.deepEqual(await readdir(work), ['chosen-destination.bin']);
});

test('default artifact roots support session files, received uploads and temporary images', async () => {
  delete process.env.COCKPIT_UPLOAD_DIRS;
  const paths = [
    join(home, '.copilot', 'session-state', 'session-a', 'files', 'report.png'),
    join(home, '.copilot', 'session-state', 'uploads', 'shared.png'),
    join(home, '.copilot', 'cockpit-uploads', 'received.png'),
    join(temporary, 'generated.png'),
  ];
  for (const path of paths) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, image);
    assert.equal(await resolveUploadPath(path), await realpath(path));
    const result = await uploadFile(path);
    assert.equal(result.kind, 'image');
    assert.equal(result.size, image.length);
    assert.deepEqual(requests.at(-1)?.body, image);
  }
  for (const path of [
    join(home, '.ssh', 'id_rsa'),
    join(home, '.copilot', 'session-store.db'),
    join(home, '.copilot', 'cockpit-prefs.json'),
  ]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'private fixture');
    await assert.rejects(() => resolveUploadPath(path), /outside the allowed upload directories/);
  }
});

test('image upload posts exact source bytes and preserves canonical remote metadata without markers', async () => {
  const path = join(sources, 'chart & 图.png');
  await writeFile(path, image);
  const result = await call('cockpit_upload_file', { path, response_format: 'json' });
  assert.ok(!result.error, result.text);
  const data = JSON.parse(result.text);
  assert.deepEqual(data, {
    kind: 'image', name: 'chart & 图.png', url: storedUrl,
    path: '/remote-backend-only/uploads/image.png', mime: 'image/png', size: image.length,
    storedName: '1788750000000-a1b2c3d4e5f6.png',
    markdown: `![chart & 图.png](${storedUrl})`,
    attachment: { kind: 'image', name: 'chart & 图.png', url: storedUrl, size: image.length, mime: 'image/png' },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.headers.authorization, 'Bearer file-test-token');
  assert.equal(requests[0]?.headers['content-type'], 'application/octet-stream');
  assert.equal(requests[0]?.method, 'POST');
  assert.deepEqual(requests[0]?.body, image);
});

test('upload preserves explicit MIME and renders native attachment JSON', async () => {
  const path = join(sources, 'report.bin');
  await writeFile(path, 'report');
  const result = await call('cockpit_upload_file', { path, mime: 'application/pdf' });
  assert.ok(!result.error, result.text);
  assert.match(result.text, /Uploaded \*\*report.bin\*\* \(file, 6 bytes\)/);
  assert.ok(result.text.includes(`[report.bin](${storedUrl})`));
  assert.ok(result.text.includes(JSON.stringify({
    kind: 'file', name: 'report.bin', url: storedUrl, size: 6, mime: 'application/pdf',
  })));
  assert.doesNotMatch(result.text, /<cockpit-attachment/);
});

test('video upload streams bounded chunks and forwards source and session association', async () => {
  const path = join(sources, 'clip.mp4');
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  await writeFile(path, bytes);
  const chunks: number[] = [];
  onWrite = chunk => { chunks.push(chunk.length); };
  const result = await call('cockpit_upload_file', { path, source: 'mcp', session_id: 'session-a', response_format: 'json' });
  assert.ok(!result.error, result.text);
  assert.equal(JSON.parse(result.text).mime, 'video/mp4');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(size => size <= 64 * 1024));
  assert.deepEqual(requests[0]?.body, bytes);
  const query = new URL(requests[0]!.url, COCKPIT_URL).searchParams;
  assert.equal(query.get('source'), 'mcp');
  assert.equal(query.get('sessionId'), 'session-a');
});

test('upload reads the pinned original despite a source replaced by an escaping symlink', async () => {
  const path = join(sources, 'clip.mp4');
  const original = Buffer.alloc(2 * 1024 * 1024, 7);
  await writeFile(path, original);
  const secret = join(outside, 'private.bin');
  await writeFile(secret, 'private fixture');
  onWrite = async () => {
    onWrite = undefined;
    await rename(path, join(sources, 'original.mp4'));
    await symlink(secret, path);
  };
  // Renaming can update ctime; refusing the changed inode is also safe.
  try { await uploadFile(path); } catch (error) { assert.match(String(error), /changed/); }
  assert.ok(requests.every(request => request.body.equals(original)));
  assert.equal(await readFile(secret, 'utf8'), 'private fixture');
});

test('upload rejects changing source size without completing or retrying the request', async () => {
  for (const size of [1, 3 * 1024 * 1024]) {
    const path = join(sources, 'changing.mp4');
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 7));
    onWrite = async () => {
      onWrite = undefined;
      await truncate(path, size);
    };
    await assert.rejects(() => uploadFile(path), /changed/);
  }
  assert.equal(requests.length, 0);
});

test('upload verifies authoritative SHA-256 metadata', async () => {
  const path = join(sources, 'image.png');
  await writeFile(path, image);
  for (const sha256 of [createHash('sha256').update(image).digest('hex'), '0'.repeat(64)]) {
    respond = res => res.end(JSON.stringify({
      kind: 'image', name: 'image.png', url: storedUrl, path: '/remote/image.png', size: image.length, mime: 'image/png', sha256,
    }));
    if (sha256.startsWith('0000')) await assert.rejects(() => uploadFile(path), /mismatched SHA-256/);
    else assert.equal((await uploadFile(path)).sha256, sha256);
  }
});

test('upload preserves detected MIME and opaque source-based URL instead of trusting the local suffix', async () => {
  const path = join(sources, 'misnamed.mp4');
  await writeFile(path, image);
  const sha256 = createHash('sha256').update(image).digest('hex');
  const url = `/uploads/upload-v1-source-${sha256}.png`;
  respond = res => res.end(JSON.stringify({
    kind: 'image', name: 'misnamed.mp4', url, path: `/remote${url}`, size: image.length,
    mime: 'image/png', sha256, source: 'mcp',
  }));
  const result = await call('cockpit_upload_file', { path, response_format: 'json' });
  assert.ok(!result.error, result.text);
  const uploaded = JSON.parse(result.text);
  assert.deepEqual(uploaded.attachment, { kind: 'image', name: 'misnamed.mp4', url, size: image.length, mime: 'image/png' });
  assert.equal(uploaded.sha256, sha256);
  assert.equal(uploaded.source, 'mcp');
  assert.equal(uploaded.markdown, `![misnamed.mp4](${url})`);
  validateUploadUrl(`/uploads/upload-v1-source-${sha256}`);
});

test('upload then download transfers the actual source through the mock backend', async () => {
  const source = join(sources, 'roundtrip.png');
  const destination = join(work, 'roundtrip.png');
  await writeFile(source, image);
  let uploaded: Buffer | undefined;
  respond = (res, request) => {
    if (request.method === 'POST') {
      uploaded = request.body;
      res.end(JSON.stringify({
        kind: 'image', name: 'roundtrip.png', url: storedUrl,
        path: '/remote-only/roundtrip.png', mime: 'image/png', size: uploaded.length,
      }));
    } else {
      assert.ok(uploaded);
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': uploaded.length });
      res.end(uploaded);
    }
  };
  const upload = await uploadFile(source);
  const download = await downloadFile(upload.url, destination, { name: upload.name });
  assert.deepEqual(await readFile(destination), await readFile(source));
  assert.deepEqual(
    { kind: download.kind, name: download.name, url: download.url, size: download.size, mime: download.mime },
    { kind: upload.kind, name: upload.name, url: upload.url, size: upload.size, mime: upload.mime },
  );
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.headers.authorization === 'Bearer file-test-token'));
});

test('upload refuses empty and oversized sources before networking or reading large contents', async () => {
  const path = join(sources, 'large.bin');
  await writeFile(path, '');
  await assert.rejects(() => uploadFile(path), /empty/);
  await truncate(path, MAX_TRANSFER_BYTES + 1);
  await assert.rejects(() => uploadFile(path), /exceeds.*upload limit/);
  assert.equal(requests.length, 0);
});

test('upload validates response JSON, metadata, size and remote URL without probing remote path locally', async () => {
  const path = join(sources, 'file.txt');
  await writeFile(path, 'hello');
  const metadata = { kind: 'file', name: 'file.txt', url: storedUrl, path: '/remote/path', size: 5, mime: 'text/plain' };
  for (const body of [
    'not json',
    '{}',
    JSON.stringify({ ...metadata, size: 6 }),
    JSON.stringify({ ...metadata, url: 'https://example.invalid/leak' }),
  ]) {
    respond = (res) => res.end(body);
    await assert.rejects(() => uploadFile(path), (error: unknown) => error instanceof CockpitError && error.kind === 'protocol');
  }
  assert.equal(requests.length, 4);
});

test('upload HTTP errors and stalled headers/body never retry', async () => {
  const path = join(sources, 'file.txt');
  await writeFile(path, 'hello');
  respond = (res) => { res.writeHead(403); res.end('{"error":"denied"}'); };
  await assert.rejects(() => uploadFile(path), /denied/);
  for (const headers of [false, true]) {
    respond = (res) => { if (headers) res.write('{"pending":'); };
    await assert.rejects(
      () => uploadFile(path, { timeoutMs: 100 }),
      (error: unknown) => error instanceof CockpitError && error.kind === 'timeout' && /no retry/.test(error.message),
    );
  }
  assert.equal(requests.length, 3);
});

test('upload responses are bounded independently of the source file size', async () => {
  const path = join(sources, 'file.txt');
  await writeFile(path, 'hello');
  respond = (res) => { res.writeHead(200, { 'content-length': String(64 * 1024 + 1) }); res.flushHeaders(); };
  await assert.rejects(() => uploadFile(path, { timeoutMs: 1000 }), /exceeds.*byte limit/);
  assert.equal(requests.length, 1);
});

test('image download roundtrip returns metadata and private local file under the default cwd root', async () => {
  const path = join(work, 'local-image.png');
  const result = await call('cockpit_download_file', { url: storedUrl, path, name: 'Display image.png', response_format: 'json' });
  assert.ok(!result.error, result.text);
  assert.deepEqual(JSON.parse(result.text), {
    kind: 'image', name: 'Display image.png', url: storedUrl, mime: 'image/png', size: image.length, path,
  });
  assert.deepEqual(await readFile(path), image);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(requests[0]?.headers.authorization, 'Bearer file-test-token');
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.url, storedUrl);
});

test('download to extra root preserves file MIME and uses URL basename as display-name fallback', async () => {
  process.env.COCKPIT_DOWNLOAD_DIRS = [extra, sources].join(delimiter);
  respond = (res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('download'); };
  const result = await downloadFile('/uploads/1788750000000-a1b2c3d4e5f6.txt', join(extra, 'note.txt'));
  assert.equal(result.kind, 'file');
  assert.equal(result.name, '1788750000000-a1b2c3d4e5f6.txt');
  assert.equal(result.mime, 'text/plain; charset=utf-8');
  assert.equal(result.size, 8);
  assert.equal(await readFile(result.path, 'utf8'), 'download');
});

test('download accepts only safe backend upload basenames before networking or file creation', async () => {
  for (const url of [
    '', 'uploads/a.png', 'http://example.invalid/uploads/a.png', '//example.invalid/uploads/a.png',
    '/health', '/uploads/', '/uploads/.', '/uploads/..', '/uploads/../a', '/uploads/a/b',
    '/uploads/a\\b', '/uploads/%2e%2e', '/uploads/%252e%252e', '/uploads/a%2fb',
    '/uploads/a.png?token=x', '/uploads/a.png#fragment', '/uploads/a..png', '/uploads/.hidden',
    '/uploads/a\u0000.png', '/uploads/a\r\n.png',
  ]) {
    assert.throws(() => validateUploadUrl(url), /safe-basename/);
    await assert.rejects(() => downloadFile(url, join(work, 'invalid')), /safe-basename/);
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(await readdir(work), []);
});

test('download refuses outside roots, relative paths, traversal, missing parents and unsafe display names', async () => {
  for (const path of [
    'relative.png', join(outside, 'escape.png'), `${work}/../outside/escape.png`,
    join(work, 'missing', 'image.png'), join(`${work}-prefix-escape`, 'image.png'),
  ]) await assert.rejects(() => downloadFile(storedUrl, path));
  for (const name of ['../escape', '/escape', 'a\\b', 'a\nb', '..']) {
    await assert.rejects(() => downloadFile(storedUrl, join(work, 'image.png'), { name }), /safe filename/);
  }
  process.env.COCKPIT_DOWNLOAD_DIRS = 'relative-root';
  await assert.rejects(() => downloadFile(storedUrl, join(work, 'image.png')), /absolute directories/);
  assert.equal(requests.length, 0);
  assert.deepEqual(await readdir(work), []);
});

test('download always refuses overwrite and final or parent symlinks, including dangling links', async () => {
  const protectedPath = join(work, 'existing.png');
  await writeFile(protectedPath, 'keep');
  await assert.rejects(() => downloadFile(storedUrl, protectedPath), { code: 'EEXIST' });
  const secret = join(outside, 'protected.txt');
  await writeFile(secret, 'private fixture');
  await symlink(secret, join(work, 'link'));
  await assert.rejects(() => downloadFile(storedUrl, join(work, 'link')));
  await symlink(join(outside, 'missing'), join(work, 'dangling'));
  await assert.rejects(() => downloadFile(storedUrl, join(work, 'dangling')));
  await symlink(outside, join(work, 'escape-parent'));
  await assert.rejects(() => downloadFile(storedUrl, join(work, 'escape-parent', 'new.png')), /outside the allowed download/);
  await mkdir(join(work, 'real-parent'));
  await symlink(join(work, 'real-parent'), join(work, 'internal-parent'));
  await assert.rejects(() => downloadFile(storedUrl, join(work, 'internal-parent', 'new.png')), /without symlinks/);
  assert.equal(await readFile(protectedPath, 'utf8'), 'keep');
  assert.equal(await readFile(secret, 'utf8'), 'private fixture');
  assert.deepEqual(await readdir(outside), ['protected.txt']);
  assert.equal(requests.length, 0);
});

test('upload and download redirects cannot reach another path or origin or spill credentials', async () => {
  const path = join(sources, 'file.txt');
  await writeFile(path, 'hello');
    for (const location of ['/redirect-target', 'http://other-origin.invalid/leak']) {
      respond = (res) => { res.writeHead(307, { location }); res.end(); };
      await assert.rejects(() => uploadFile(path), /redirect/);
      const destination = join(work, 'redirect.png');
      await assert.rejects(() => downloadFile(storedUrl, destination), /redirect/);
      await absent(destination);
    }
    assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => request.headers.authorization === 'Bearer file-test-token'));
    assert.ok(requests.every((request) => !request.url.includes('redirect-target')));
});

test('download timeout covers both headers and body and removes incomplete local files without retries', async () => {
  for (const headers of [false, true]) {
    respond = (res) => {
      if (headers) { res.writeHead(200, { 'content-length': '1000' }); res.write('partial'); }
    };
    const path = join(work, 'timeout.png');
    await assert.rejects(
      () => downloadFile(storedUrl, path, { timeoutMs: 100 }),
      (error: unknown) => error instanceof CockpitError && error.kind === 'timeout',
    );
    await absent(path);
  }
  assert.equal(requests.length, 2);
});

test('download does not follow a parent replaced by a symlink while the HTTP body arrives', async () => {
  const parent = join(work, 'parent');
  const moved = join(work, 'moved');
  await mkdir(parent);
  respond = (res) => {
    void (async () => {
      await rename(parent, moved);
      await symlink(outside, parent);
      res.end(image);
    })().catch((error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))));
  };
  await assert.rejects(() => downloadFile(storedUrl, join(parent, 'image.png')), /parent changed/);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(moved), []);
});

test('download preserves a destination created concurrently with the HTTP transfer', async () => {
  const path = join(work, 'concurrent.png');
  respond = (res) => {
    void writeFile(path, 'other writer', { flag: 'wx' }).then(() => res.end(image)).catch(
      (error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  };
  await assert.rejects(() => downloadFile(storedUrl, path), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), 'other writer');
});

test('configured root symlinks are canonicalized while descendant symlinks remain fenced', async () => {
  const uploadAlias = join(work, 'source-alias');
  const downloadAlias = join(work, 'download-alias');
  await symlink(sources, uploadAlias);
  await symlink(extra, downloadAlias);
  process.env.COCKPIT_UPLOAD_DIRS = uploadAlias;
  process.env.COCKPIT_DOWNLOAD_DIRS = downloadAlias;
  const source = join(uploadAlias, 'image.png');
  await writeFile(source, image);
  assert.equal((await uploadFile(source)).size, image.length);
  const result = await downloadFile(storedUrl, join(downloadAlias, 'image.png'));
  assert.equal(result.path, join(extra, 'image.png'));
  assert.deepEqual(await readFile(result.path), image);
});

test('download bounds declared Content-Length before consuming a stalled oversized body', async () => {
  respond = (res) => { res.writeHead(200, { 'content-length': String(MAX_TRANSFER_BYTES + 1) }); res.flushHeaders(); };
  const path = join(work, 'oversized.png');
  await assert.rejects(() => downloadFile(storedUrl, path, { timeoutMs: 1000 }), /exceeds.*byte limit/);
  await absent(path);
});

test('download measures chunked response bytes and removes oversized incomplete files', async () => {
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(MAX_TRANSFER_BYTES + 1));
  };
  const path = join(work, 'oversized-stream.bin');
  await assert.rejects(() => downloadFile(storedUrl, path), /exceeds.*byte limit/);
  await absent(path);
  assert.deepEqual(await readdir(work), []);
});

test('download streams to private staging and verifies hash before publishing the complete original', async () => {
  const path = join(work, 'video.mp4');
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let observedStaging = false;
  respond = res => {
    res.writeHead(200, { 'content-type': 'video/mp4', etag: `"${sha256}"`, 'content-length': bytes.length });
    res.write(bytes.subarray(0, 64 * 1024));
    void (async () => {
      await absent(path);
      const staged = (await readdir(work)).filter(name => name.startsWith('.cockpit-download-'));
      assert.equal(staged.length, 1);
      assert.equal((await stat(join(work, staged[0]!))).mode & 0o777, 0o600);
      observedStaging = true;
      res.end(bytes.subarray(64 * 1024));
    })().catch(error => res.destroy(error));
  };
  const result = await downloadFile('/uploads/video.mp4', path);
  assert.ok(observedStaging);
  assert.equal(result.sha256, sha256);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readdir(work), ['video.mp4']);
});

test('download refuses hash mismatches, partial HTTP success and length mismatches without publishing', async () => {
  for (const [status, headers] of [
    [200, { etag: `"${'0'.repeat(64)}"` }],
    [206, {}],
    [200, { 'content-length': '1' }],
    [200, { 'content-length': '1000' }],
  ] as const) {
    respond = res => { res.writeHead(status, headers); res.end(image); };
    await assert.rejects(() => downloadFile(storedUrl, join(work, 'invalid.png')));
    assert.deepEqual(await readdir(work), []);
  }
  assert.equal(requests.length, 4);
});

test('download accepts exactly the byte limit', async () => {
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(MAX_TRANSFER_BYTES) });
    res.end(Buffer.alloc(MAX_TRANSFER_BYTES, 7));
  };
  const path = join(work, 'bounded.bin');
  const result = await downloadFile('/uploads/bounded.bin', path);
  assert.equal(result.size, MAX_TRANSFER_BYTES);
  assert.equal((await stat(path)).size, MAX_TRANSFER_BYTES);
});

test('download rejects truncated and encoded bodies and backend errors with cleanup', async () => {
  const responders: typeof respond[] = [
    (res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('short');
      const timer = setTimeout(() => res.destroy(), 20);
      res.once('close', () => clearTimeout(timer));
    },
    (res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end('not identity'); },
    (res) => { res.writeHead(404); res.end('{"error":"not found"}'); },
  ];
  for (const handler of responders) {
    respond = handler;
    const path = join(work, 'failed.png');
    await assert.rejects(() => downloadFile(storedUrl, path));
    await absent(path);
  }
  assert.equal(requests.length, 3);
});

test('download tool failures are reported and directory browsing remains an authenticated remote intent', async () => {
  const result = await call('cockpit_download_file', { url: '/health', path: join(work, 'invalid') });
  assert.equal(result.error, true);
  assert.match(result.text, /safe-basename/);
  assert.equal(requests.length, 0);
  respond = (res) => res.end(JSON.stringify({ path: '/remote/home', parent: '/remote', entries: [{ name: 'project', isDir: true }] }));
  const listing = await call('cockpit_list_dir', { path: '/remote/home', response_format: 'json' });
  assert.ok(!listing.error, listing.text);
  assert.equal(JSON.parse(listing.text).path, '/remote/home');
  assert.equal(requests[0]?.url, '/intent/fs/listDir');
  assert.equal(requests[0]?.headers.authorization, 'Bearer file-test-token');
  assert.deepEqual(JSON.parse(requests[0]?.body.toString() ?? ''), { path: '/remote/home' });
});

test('directory tool omission requests home while explicit bad paths fail once in both formats', async () => {
  respond = res => res.end(JSON.stringify({ path: '/remote/home', parent: '/remote', entries: [] }));
  const homeListing = await call('cockpit_list_dir', { response_format: 'json' });
  assert.ok(!homeListing.error, homeListing.text);
  assert.equal(JSON.parse(homeListing.text).path, '/remote/home');
  assert.deepEqual(JSON.parse(requests[0]!.body.toString()), {});
  for (const response_format of ['markdown', 'json']) {
    for (const [path, status, code] of [
      ['/remote/missing', 404, 'ENOENT'],
      ['/remote/file', 400, 'ENOTDIR'],
      ['/remote/denied', 403, 'EACCES'],
      ['', 400, 'INVALID_DIRECTORY_PATH'],
    ] as const) {
      const message = `${code}: cannot list directory '${path}'`;
      respond = res => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message, code }));
      };
      const count = requests.length;
      const result = await call('cockpit_list_dir', { path, response_format });
      assert.equal(result.error, true);
      assert.ok(result.text.includes(message), result.text);
      assert.equal(requests.length, count + 1, 'no retry or home fallback');
      assert.equal(requests.at(-1)!.url, '/intent/fs/listDir');
      assert.deepEqual(JSON.parse(requests.at(-1)!.body.toString()), { path });
    }
  }
});
