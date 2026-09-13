// Unit tests for the upload storage module. Isolates within apps/server via the
// COCKPIT_UPLOAD_DIR env override (read at module load, so set BEFORE importing).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync,
  statSync, symlinkSync, chmodSync, renameSync, truncateSync } from 'node:fs';
import crypto, { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachmentPrompt, type Attachment } from '@cockpit/protocol';
import { Readable } from 'node:stream';

const TEST_ROOT = relative(process.cwd(), fileURLToPath(
  new URL(`../.cockpit-uploads-test-${process.pid}-${randomUUID()}`, import.meta.url),
));
mkdirSync(TEST_ROOT);
const previousUploadDir = process.env.COCKPIT_UPLOAD_DIR;
after(() => {
  rmSync(TEST_ROOT, { force: true, recursive: true });
  if (previousUploadDir === undefined) delete process.env.COCKPIT_UPLOAD_DIR;
  else process.env.COCKPIT_UPLOAD_DIR = previousUploadDir;
});
const TEST_DIR = join(TEST_ROOT, 'uploads');
process.env.COCKPIT_UPLOAD_DIR = TEST_DIR;

// Import AFTER setting the env (module reads UPLOAD_DIR at load time).
const { saveUploadStream, resolveUpload, resolveStoredAttachment, openUpload, mimeForStored,
  validateUploadInput, UploadError, UPLOAD_DIR, MAX_UPLOAD_BYTES } = await import('./uploads.ts');
const metadataPath = (name: string) => join(TEST_DIR, '.metadata', `${name}.json`);
const inventory = () => readdirSync(TEST_DIR, { recursive: true }).sort();
const status = (statusCode: number) => (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { statusCode: number }).statusCode, statusCode);
  return true;
};
const attachment = (url: string): Attachment => ({ kind: 'file', name: 'client lie', url });
const ioError = () => Object.assign(new Error('Injected storage failure'), { code: 'EIO' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=', 'base64');
const saveBytes = (bytes: Buffer, name: string, mime: string) =>
  saveUploadStream(Readable.from([bytes]), name, mime);

function legacySidecarFixture(bytes: Buffer, name: string, mime: string) {
  mkdirSync(join(TEST_DIR, '.metadata'), { recursive: true, mode: 0o700 });
  const storedName = `upload-v1-1700000000000-${randomUUID().replaceAll('-', '')}.bin`;
  const path = resolve(TEST_DIR, storedName);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(metadataPath(storedName), JSON.stringify({
    version: 1, storedName, name, mime, size: bytes.length,
  }), { flag: 'wx', mode: 0o600 });
  return { kind: mime.startsWith('image/') ? 'image' as const : 'file' as const,
    storedName, path, url: `/uploads/${storedName}`, name, mime, size: bytes.length };
}

async function storageAt(dir: string) {
  process.env.COCKPIT_UPLOAD_DIR = dir;
  try {
    return await import(`./uploads.ts?fixture=${randomUUID()}`) as typeof import('./uploads.ts');
  } finally {
    process.env.COCKPIT_UPLOAD_DIR = TEST_DIR;
  }
}

test('UPLOAD_DIR honors the env override', () => {
  assert.equal(UPLOAD_DIR, TEST_DIR);
});

test('streamed uploads reject overflow, interruption and disk-full without publishing partial files', async (t) => {
  const dir = join(TEST_ROOT, `stream-${randomUUID()}`);
  const storage = await storageAt(dir);
  const original = await storage.saveUploadStream(Readable.from([Buffer.from('keep me')]), 'kept.txt', 'text/plain');
  const before = readdirSync(dir, { recursive: true }).sort();
  async function* oversized() {
    for (let i = 0; i < 26; i++) yield Buffer.alloc(1024 * 1024);
  }
  await assert.rejects(storage.saveUploadStream(oversized(), 'huge.mp4', 'video/mp4'), status(413));
  async function* broken() {
    yield Buffer.from('partial');
    throw new Error('interrupted incoming transfer');
  }
  await assert.rejects(storage.saveUploadStream(broken(), 'interrupted.bin', 'application/octet-stream'), /storage failed/);
  assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before);
  const mock = t.mock.method(fs, 'writeFileSync', () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); });
  await assert.rejects(storage.saveUploadStream(Readable.from([Buffer.from('new')]), 'new.bin', ''), status(507));
  mock.mock.restore();
  assert.equal(readFileSync(original.path, 'utf8'), 'keep me');
  assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before);
});

test('stable source streaming retries retain one original and fail on changed bytes', async () => {
  const dir = join(TEST_ROOT, `source-${randomUUID()}`);
  const storage = await storageAt(dir);
  const context = { source: 'org.example.external-feed', sessionId: 'isolated', sourceId: 'message:item:0' };
  const save = () => storage.saveUploadStream(Readable.from([Buffer.from('same bytes')]), 'original.txt', 'text/plain', context);
  const [first, second] = await Promise.all([save(), save()]);
  assert.equal(first.url, second.url);
  assert.equal(first.sha256, crypto.createHash('sha256').update('same bytes').digest('hex'));
  await assert.rejects(storage.saveUploadStream(Readable.from([Buffer.from('different')]), 'changed.txt', 'text/plain', context), status(409));
  assert.deepEqual(storage.listUploads({}).files.map(file => file.url), [first.url]);
  const resumed = await storageAt(dir);
  assert.equal(resumed.retainedSource(context)?.url, first.url, 'lookup survives reloading storage');
  assert.equal(resumed.retainedSource({ ...context, sessionId: 'foreign' }), null);
  rmSync(join(dir, '.metadata', `${first.storedName}.json`));
  assert.equal(resumed.listUploads({}).errors?.[0]?.url, first.url);
  assert.throws(() => resumed.retainedSource(context), status(500));
  const repaired = await save();
  assert.equal(repaired.url, first.url, 'a byte-identical source retry can complete interrupted metadata publication');
  assert.equal(readFileSync(first.path, 'utf8'), 'same bytes');
  await assert.rejects(storage.saveUploadStream(Readable.from([Buffer.from('bad')]), 'bad', '', { ...context, sessionId: '../escape' }), status(400));
});

test('file sources are generic bounded labels rather than registered module identities', async () => {
  const storage = await storageAt(join(TEST_ROOT, `source-label-${randomUUID()}`));
  for (const source of ['web', 'mcp', 'org.example.external-feed', 'historical-source', 'constructor']) {
    assert.equal(storage.validateUploadContext({ source }).source, source);
  }
  for (const source of ['', '../escape', 'bad source', 'source\n', 'x'.repeat(121)]) {
    assert.throws(() => storage.validateUploadContext({ source }), status(400));
  }
});

test('an overlapping same-source retry can recover after the earlier stream fails', async () => {
  const storage = await storageAt(join(TEST_ROOT, `retry-${randomUUID()}`));
  const context = { source: 'org.example.external-feed', sessionId: 'fixture', sourceId: 'retry-0' };
  let release!: () => void;
  const interrupted = new Promise<void>(resolve => { release = resolve; });
  async function* firstBody() {
    yield Buffer.from('partial');
    await interrupted;
    throw new Error('first connection interrupted');
  }
  let retryConsumed = false;
  async function* secondBody() { retryConsumed = true; yield Buffer.from('complete'); }
  const first = storage.saveUploadStream(firstBody(), 'file.txt', 'text/plain', context);
  const second = storage.saveUploadStream(secondBody(), 'file.txt', 'text/plain', context);
  const outcomes = Promise.allSettled([first, second]);
  release();
  const [failed, recovered] = await outcomes;
  assert.equal(failed.status, 'rejected');
  assert.equal(recovered.status, 'fulfilled');
  assert.ok(retryConsumed);
  assert.equal(storage.listUploads({}).files.length, 1);
  assert.equal(readFileSync(storage.retainedSource(context)!.path, 'utf8'), 'complete');
});

test('original-byte integrity catches same-size corruption before download or native use', async () => {
  const storage = await storageAt(join(TEST_ROOT, `integrity-${randomUUID()}`));
  const file = await storage.saveUploadStream(Readable.from([Buffer.from('original')]), 'file.txt', 'text/plain');
  storage.verifyUpload(file);
  const original = storage.openUpload(file.path, { start: 0, end: 2 });
  for await (const _chunk of original) { /* complete the first verified range */ }
  writeFileSync(file.path, 'modified');
  assert.throws(() => storage.verifyUpload(file), /integrity check failed/);
  assert.throws(() => storage.openUpload(file.path), /integrity check failed/);
  assert.throws(() => storage.openUpload(file.path, { start: 0, end: 2 }), /integrity check failed/);
  assert.throws(() => storage.associateUpload(file.url, 'fixture'), /integrity check failed/);
  assert.equal(readFileSync(file.path, 'utf8'), 'modified', 'detection never silently overwrites or deletes evidence');
});

test('metadata-backed listing reads no original prefixes, while legacy originals are still sniffed', async t => {
  const dir = join(TEST_ROOT, `metadata-read-${randomUUID()}`);
  const storage = await storageAt(dir);
  const originals = await Promise.all(['one', 'two', 'three'].map(name =>
    storage.saveUploadStream(Readable.from([PNG]), `${name}.png`, 'image/png')));
  const paths = new Set(originals.map(file => resolve(file.path)));
  const opens = t.mock.method(fs, 'openSync');
  const reads = t.mock.method(fs, 'readSync');
  const page = storage.listUploads({ limit: 1 });
  assert.equal(page.files.length, 1);
  const originalFds = new Set(opens.mock.calls.filter(call => paths.has(resolve(String(call.arguments[0])))).map(call => call.result));
  assert.equal(originalFds.size > 0, true, 'descriptor and size checks remain');
  assert.equal(reads.mock.calls.filter(call => originalFds.has(call.arguments[0])).length, 0,
    'pagination/filtering must not read unused original prefixes');
  opens.mock.restore();
  reads.mock.restore();

  const legacyPath = join(dir, 'legacy.bin');
  writeFileSync(legacyPath, PNG);
  const legacyReads = t.mock.method(fs, 'readSync');
  assert.equal(storage.resolveUpload('legacy.bin')?.mime, 'image/png');
  assert.equal(legacyReads.mock.callCount(), 1, 'no-sidecar legacy files still need one prefix read');
});

test('corrupt or missing new metadata never reads a prefix or leaks its open original descriptor', async t => {
  const dir = join(TEST_ROOT, `metadata-failure-${randomUUID()}`);
  const storage = await storageAt(dir);
  const file = await storage.saveUploadStream(Readable.from([PNG]), 'new.png', 'image/png');
  const metadata = join(dir, '.metadata', `${file.storedName}.json`);
  const original = readFileSync(metadata);
  for (const invalid of ['corrupt', 'missing', 'size'] as const) {
    if (invalid === 'missing') rmSync(metadata);
    else writeFileSync(metadata, invalid === 'corrupt' ? '{invalid' : JSON.stringify({ ...JSON.parse(original.toString()), size: file.size + 1 }));
    const opens = t.mock.method(fs, 'openSync');
    const reads = t.mock.method(fs, 'readSync');
    const closes = t.mock.method(fs, 'closeSync');
    assert.throws(() => storage.resolveUpload(file.storedName), /metadata/);
    const fd = opens.mock.calls.find(call => resolve(String(call.arguments[0])) === resolve(file.path))?.result;
    assert.equal(typeof fd, 'number');
    assert.equal(reads.mock.calls.filter(call => call.arguments[0] === fd).length, 0);
    assert.equal(closes.mock.calls.filter(call => call.arguments[0] === fd).length, 1);
    opens.mock.restore(); reads.mock.restore(); closes.mock.restore();
    writeFileSync(metadata, original);
  }
});

test('cleanup failure after durable publication does not remove a retained original', async (t) => {
  const storage = await storageAt(join(TEST_ROOT, `published-${randomUUID()}`));
  const unlink = fs.unlinkSync;
  let failed = false;
  const mock = t.mock.method(fs, 'unlinkSync', (path) => {
    if (!failed && String(path).includes('.pending-')) { failed = true; throw ioError(); }
    return unlink(path);
  });
  await assert.rejects(storage.saveUploadStream(Readable.from([Buffer.from('retained')]), 'file.txt', 'text/plain'),
    /Original retained at \/uploads\/.*cleanup failed/);
  mock.mock.restore();
  const files = storage.listUploads({}).files;
  assert.equal(files.length, 1);
  assert.equal(readFileSync(files[0]!.path, 'utf8'), 'retained');
  storage.verifyUpload(files[0]!);
});

test('streamed upload writes original bytes and returns durable metadata', async () => {
  const data = Buffer.from('hello cockpit');
  const r = await saveBytes(data, 'note.txt', 'text/plain');
  assert.equal(r.kind, 'file');
  assert.equal(r.name, 'note.txt');
  assert.equal(r.size, data.length);
  assert.equal(r.url, `/uploads/${r.storedName}`);
  assert.equal(r.path, resolve(TEST_DIR, r.storedName));
  assert.ok(existsSync(r.path));
  assert.equal(readFileSync(r.path, 'utf-8'), 'hello cockpit');
  assert.equal(r.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  assert.ok(Number.isSafeInteger(r.createdAt));
  assert.deepEqual(resolveUpload(r.storedName), r);
});

test('image mime → kind=image', async () => {
  const r = await saveBytes(PNG, 'pic.png', 'image/png');
  assert.equal(r.kind, 'image');
  assert.deepEqual(readFileSync(r.path), PNG);
});

test('long Unicode filenames remain safe to encode as native attachment prompts', async () => {
  for (const name of ['a'.repeat(199) + '😀.png', 'a'.repeat(198) + '😀.png', 'broken\uD800.png']) {
    const stored = await saveBytes(PNG, name, 'image/png');
    const attachment = resolveStoredAttachment(stored);
    assert.ok(attachment.name.length <= 200);
    assert.doesNotThrow(() => attachmentPrompt(attachment, 'caption'));
    assert.equal(resolveUpload(stored.storedName)?.name, attachment.name);
  }
});

test('stored name keeps only a safe extension; no user path chars', async () => {
  const r = await saveBytes(PNG, '../../etc/pwn.png', 'image/png');
  assert.match(r.storedName, /^upload-v1-\d+-[0-9a-f]{32}\.png$/);
  assert.ok(!r.storedName.includes('/'));
  assert.ok(!r.storedName.includes('..'));
  // The display name preserves the original (rendered as text, never a path).
  assert.equal(r.name, '../../etc/pwn.png');
});

test('newline/control chars stripped from display name', async () => {
  const r = await saveBytes(Buffer.from('x'), 'a\nb\tc\rd', 'text/plain');
  assert.ok(!/[\r\n\t]/.test(r.name));
});

test('resolveUpload finds a saved file, returns its size', async () => {
  const r = await saveBytes(Buffer.from('1234567890'), 'f.bin', 'application/octet-stream');
  const found = resolveUpload(r.storedName);
  assert.ok(found);
  assert.equal(found!.size, 10);
});

test('resolveUpload REJECTS path traversal + absolute paths', () => {
  for (const bad of [
    '../prefs.json',
    '../../etc/passwd',
    'sub/dir/file',
    'a\\b',
    '..',
    '/etc/passwd',
    '',
    '.metadata',
    'a%20b',
    'file.txt\n',
    'file.txt\r',
    'file.txt\u2028',
    'a?x',
    'a#x',
    'a'.repeat(201),
  ]) {
    assert.equal(resolveUpload(bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('resolveUpload rejects a name that escapes even if the file exists', () => {
  // Plant a file OUTSIDE the upload dir; a traversal name must NOT reach it.
  const outside = join(TEST_ROOT, 'secret-outside.txt');
  writeFileSync(outside, 'top secret');
  assert.equal(resolveUpload('../secret-outside.txt'), null);
});

test('resolveUpload returns null for a non-existent (but well-formed) name', () => {
  assert.equal(resolveUpload('1234-deadbeefcafe.png'), null);
});

test('openUpload streams the stored bytes', async () => {
  const r = await saveBytes(Buffer.from('streamed!'), 's.txt', 'text/plain');
  const stream = openUpload(r.path);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  assert.equal(Buffer.concat(chunks).toString(), 'streamed!');
});

test('mimeForStored maps extensions', () => {
  assert.equal(mimeForStored('x.png'), 'image/png');
  assert.equal(mimeForStored('x.jpg'), 'image/jpeg');
  assert.equal(mimeForStored('x.pdf'), 'application/pdf');
  assert.match(mimeForStored('x.txt'), /^text\/plain/);
  assert.equal(mimeForStored('x.unknownext'), 'application/octet-stream');
  assert.equal(mimeForStored('noext'), 'application/octet-stream');
  assert.equal(mimeForStored('UPPER.JPEG'), 'image/jpeg');
  assert.equal(mimeForStored('x.toString'), 'application/octet-stream');
});

test('new upload directories and files are private', async () => {
  const r = await saveBytes(Buffer.from('private'), 'private.txt', 'text/plain');
  assert.equal(statSync(TEST_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(TEST_DIR, '.metadata')).mode & 0o777, 0o700);
  assert.equal(statSync(r.path).mode & 0o777, 0o600);
  assert.equal(statSync(metadataPath(r.storedName)).mode & 0o777, 0o600);
});

test('literal percent filename is not decoded or used for storage', async () => {
  for (const name of ['100% real%20name.png', '%252e%252e%252fsecret', 'bad%escape.txt']) {
    const r = await saveBytes(PNG, name, 'image/png');
    assert.equal(r.name, name);
    assert.ok(!r.storedName.includes('%'));
    assert.deepEqual(resolveUpload(r.storedName), r);
  }
});

test('all control and bidi characters are removed from a bounded display name', async () => {
  const r = await saveBytes(Buffer.from('x'), '\0a\x01b\x7fc\x85d\u202ee\u2069f\n' + 'x'.repeat(300), '');
  assert.ok(!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(r.name));
  assert.ok(r.name.length <= 200);
  assert.deepEqual(resolveUpload(r.storedName), r);
  assert.deepEqual(validateUploadInput('\0\n\t', ''), { name: 'file', mime: 'application/octet-stream' });
});

test('detected MIME and original display name survive a fresh process', async () => {
  const uploads = [
    await saveBytes(PNG, 'extensionless', 'image/png'),
    await saveBytes(PNG, 'actually-a-png.txt', 'text/plain'),
    await saveBytes(Buffer.from('text'), 'not-an-image.jpg', 'text/plain; charset=utf-8'),
    await saveBytes(Buffer.from('not webp'), '100%real.bin', 'image/webp'),
  ];
  assert.deepEqual(uploads.map(file => file.mime),
    ['image/png', 'image/png', 'text/plain', 'application/octet-stream']);
  const moduleUrl = new URL('./uploads.ts', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { resolveUpload } from ${JSON.stringify(moduleUrl)};
     console.log(JSON.stringify(${JSON.stringify(uploads.map(r => r.storedName))}.map(resolveUpload)));`],
  { cwd: process.cwd(), env: { ...process.env, COCKPIT_UPLOAD_DIR: TEST_DIR }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), uploads);
  for (const upload of uploads) assert.deepEqual(resolveStoredAttachment(attachment(upload.url)), upload);
});

test('invalid metadata and non-binary streams fail without publishing files', async () => {
  const before = inventory();
  for (const mime of ['text', 'image/', '/png', 'image/*', '*/png', 'image/png\r\nX: y',
    'image/png\n', 'image/png\0', 'image/ png', ' text/plain', 'text/plain;', 'text/plain; charset',
    'text/plain; charset="unterminated', 'text/' + 'a'.repeat(513)]) {
    await assert.rejects(saveBytes(Buffer.from('x'), 'name', mime), status(400));
  }
  for (const [name, mime] of [[null, 'text/plain'], ['name', null], [42, 'image/png'], ['name', {}]]) {
    assert.throws(() => validateUploadInput(name, mime), status(400));
  }
  await assert.rejects(saveUploadStream(Readable.from(['not binary']), 'name', 'text/plain'), status(400));
  assert.deepEqual(inventory(), before);
});

test('valid MIME parameters are accepted and detected media determines classification', async () => {
  for (const mime of ['image/svg+xml', 'IMAGE/PNG', 'application/vnd.example+json',
    'text/plain; charset=utf-8', 'text/plain; charset="utf-8"']) {
    assert.equal(validateUploadInput('name', mime).mime, mime);
    const r = await saveBytes(PNG, 'name', mime);
    assert.equal(r.mime, 'image/png');
    assert.equal(r.kind, 'image');
    assert.deepEqual(resolveUpload(r.storedName), r);
  }
});

test('25 MB limit includes the boundary and rejects overflow without publishing files', async () => {
  const r = await saveBytes(Buffer.alloc(MAX_UPLOAD_BYTES), 'limit', '');
  assert.equal(resolveUpload(r.storedName)?.size, MAX_UPLOAD_BYTES);
  const before = inventory();
  await assert.rejects(saveBytes(Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'too-big', ''), status(413));
  assert.deepEqual(inventory(), before);
});

test('legacy files keep original links and display fallback, but require byte signatures for media', async () => {
  const dir = join(TEST_ROOT, 'legacy');
  mkdirSync(dir);
  const legacy = await storageAt(dir);
  for (const [name, mime] of [
    ['1700000000000-deadbeefcafe.PNG', 'image/png'],
    ['1700000000000-deadbeefcafe.txt', 'text/plain'],
    ['spoofed-image.png', 'application/octet-stream'],
    ['old-file.unknown', 'application/octet-stream'],
    ['old-file', 'application/octet-stream'],
  ] as const) {
    const path = resolve(dir, name);
    const bytes = mime === 'image/png'
      ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=', 'base64')
      : Buffer.from('legacy bytes');
    writeFileSync(path, bytes);
    const before = statSync(path);
    const found = legacy.resolveUpload(name);
    assert.deepEqual(found, {
      kind: mime.startsWith('image/') ? 'image' : 'file', name, storedName: name,
      url: `/uploads/${name}`, path, size: bytes.length, mime,
    });
    assert.deepEqual(legacy.resolveStoredAttachment(attachment(`/uploads/${name}`)), found);
    const chunks: Buffer[] = [];
    for await (const chunk of legacy.openUpload(path)) chunks.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(statSync(path).mtimeMs, before.mtimeMs);
    assert.equal(statSync(path).ino, before.ino);
  }
  assert.equal(readdirSync(dir).length, 5);
  assert.equal(existsSync(join(dir, '.metadata')), false);
});

test('attachment resolution ignores every client value other than the literal URL', async () => {
  const r = await saveBytes(PNG, 'real-name', 'image/png');
  const forged = { kind: 'file', name: 'forged', url: r.url, path: '/etc/passwd',
    mime: 'text/html', size: 9999, storedName: 'other-file' } as Attachment;
  assert.deepEqual(resolveStoredAttachment(forged), r);
});

test('unsafe attachment URLs are rejected as 400; missing files are 404', () => {
  for (const url of ['', '/uploads/', '/uploads/.', '/uploads/..', '/uploads/../outside',
    '/uploads/a/b', '/uploads/a\\b', '/uploads/a?x=1', '/uploads/a#fragment',
    '/uploads/%61', '/uploads/%2e%2e%2fsecret', '/uploads/%252e%252e%252fsecret',
    '/uploads/a%00', '/uploads/a%', '/uploads/a\n', '/uploads/a\r', '/uploads/a b',
    '/uploads//a', '/uploads/.metadata/a.json', 'uploads/a', '//uploads/a',
    'https://example.com/uploads/a', 'http://localhost/uploads/a', 'file:///uploads/a',
    '/etc/passwd', resolve(TEST_DIR, 'file'), '/UPLOADS/a']) {
    assert.throws(() => resolveStoredAttachment(attachment(url)), status(400), JSON.stringify(url));
  }
  for (const value of [null, undefined, {}, { url: 123 }]) {
    assert.throws(() => resolveStoredAttachment(value as unknown as Attachment), status(400));
  }
  assert.throws(() => resolveStoredAttachment(attachment('/uploads/nonexistent')), status(404));
});

test('openUpload rejects arbitrary, relative, and traversing paths', () => {
  for (const path of ['/etc/passwd', join(TEST_DIR, 'relative'), `${resolve(TEST_DIR)}/../secret`,
    `${resolve(TEST_DIR)}/a/../file`, `${resolve(TEST_DIR)}//file`]) {
    assert.throws(() => openUpload(path), status(400));
  }
  assert.throws(() => openUpload(resolve(TEST_DIR, 'missing')), status(404));
});

test('missing new sidecars never fall back to the extension or rewrite the bytes', async () => {
  const r = await saveBytes(Buffer.from('unchanged'), 'mismatch.jpg', 'image/png');
  rmSync(metadataPath(r.storedName));
  assert.throws(() => resolveUpload(r.storedName), status(500));
  assert.throws(() => resolveStoredAttachment(attachment(r.url)), status(500));
  assert.throws(() => openUpload(r.path), status(500));
  assert.equal(readFileSync(r.path, 'utf8'), 'unchanged');
  assert.equal(existsSync(metadataPath(r.storedName)), false);
});

test('corrupt or inconsistent sidecars are storage errors, never legacy fallbacks', async () => {
  const r = await saveBytes(Buffer.from('data'), 'display.txt', 'image/png');
  const path = metadataPath(r.storedName);
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  for (const value of ['{broken', 'null', '[]', '{}', 'x'.repeat(4097),
    JSON.stringify({ ...metadata, version: 2 }),
    JSON.stringify({ ...metadata, storedName: 'wrong-name' }),
    JSON.stringify({ ...metadata, size: 5 }),
    JSON.stringify({ ...metadata, size: '4' }),
    JSON.stringify({ ...metadata, name: 'bad\nname' }),
    JSON.stringify({ ...metadata, mime: 'image/png\n' }),
    JSON.stringify({ ...metadata, mime: '' })]) {
    writeFileSync(path, value);
    assert.throws(() => resolveUpload(r.storedName), status(500));
    assert.throws(() => resolveStoredAttachment(attachment(r.url)), status(500));
    assert.equal(readFileSync(path, 'utf8'), value);
    assert.equal(readFileSync(r.path, 'utf8'), 'data');
  }
});

test('metadata never supplies an arbitrary path, URL, or kind', async () => {
  const r = await saveBytes(PNG, 'real', 'image/png');
  const path = metadataPath(r.storedName);
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...metadata, path: '/etc/passwd', url: 'https://example.com',
    kind: 'file' }));
  assert.deepEqual(resolveUpload(r.storedName), r);
});

test('invalid UTF-8 sidecars are corrupt metadata, not repaired display names', async () => {
  const r = await saveBytes(Buffer.from('data'), 'name', 'image/png');
  const bytes = readFileSync(metadataPath(r.storedName));
  const index = bytes.indexOf('"name":"name"') + '"name":"'.length;
  assert.ok(index >= '"name":"'.length);
  bytes[index] = 0xff;
  writeFileSync(metadataPath(r.storedName), bytes);
  assert.throws(() => resolveUpload(r.storedName), status(500));
  assert.deepEqual(readFileSync(metadataPath(r.storedName)), bytes);
});

test('changed file sizes and oversized legacy files are explicit storage failures', async () => {
  const r = await saveBytes(Buffer.from('data'), 'real', 'image/png');
  writeFileSync(r.path, 'longer data');
  assert.throws(() => resolveUpload(r.storedName), status(500));
  const legacyPath = join(TEST_DIR, 'oversize-legacy.bin');
  writeFileSync(legacyPath, '');
  truncateSync(legacyPath, MAX_UPLOAD_BYTES + 1);
  assert.throws(() => resolveUpload('oversize-legacy.bin'), status(500));
});

test('file and metadata symlinks (including dangling links) are never followed', async () => {
  const outside = resolve(TEST_ROOT, 'symlink-target');
  writeFileSync(outside, 'outside');
  for (const [name, target] of [['linked', outside], ['dangling', `${outside}-missing`]]) {
    symlinkSync(target!, join(TEST_DIR, name!));
    assert.throws(() => resolveUpload(name!), status(500));
    assert.throws(() => openUpload(resolve(TEST_DIR, name!)), status(500));
    assert.throws(() => resolveStoredAttachment(attachment(`/uploads/${name}`)), status(500));
  }
  const r = await saveBytes(Buffer.from('data'), 'name', 'image/png');
  rmSync(metadataPath(r.storedName));
  symlinkSync(outside, metadataPath(r.storedName));
  assert.throws(() => resolveUpload(r.storedName), status(500));
  assert.equal(readFileSync(outside, 'utf8'), 'outside');
});

test('non-regular stored files and unsafe file permissions are rejected', async () => {
  mkdirSync(join(TEST_DIR, 'directory-not-file'));
  assert.throws(() => resolveUpload('directory-not-file'), status(500));
  const r = await saveBytes(Buffer.from('data'), 'name', 'text/plain');
  chmodSync(r.path, 0o666);
  assert.throws(() => resolveUpload(r.storedName), status(500));
  chmodSync(r.path, 0o600);
  chmodSync(metadataPath(r.storedName), 0o666);
  assert.throws(() => resolveUpload(r.storedName), status(500));
});

test('a file replaced with a symlink between resolution and opening is rejected', async (t) => {
  const r = await saveBytes(Buffer.from('data'), 'name', '');
  const outside = resolve(TEST_ROOT, 'open-race-outside');
  writeFileSync(outside, 'must not stream');
  const open = fs.openSync;
  let opens = 0;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === r.path && ++opens === 2) {
      rmSync(r.path);
      symlinkSync(outside, r.path);
    }
    return open(...args);
  });
  assert.throws(() => openUpload(r.path), status(500));
  assert.equal(readFileSync(outside, 'utf8'), 'must not stream');
});

test('an open stream uses its checked descriptor and does not read appended bytes', async () => {
  const r = await saveBytes(Buffer.from('original'), 'name', '');
  const stream = openUpload(r.path);
  fs.appendFileSync(r.path, 'extra');
  renameSync(r.path, `${r.path}-moved`);
  symlinkSync(resolve(TEST_ROOT, 'nonexistent-target'), r.path);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  assert.equal(Buffer.concat(chunks).toString(), 'original');
});

test('legacy empty uploads remain readable while new empty streams are rejected', async () => {
  const r = legacySidecarFixture(Buffer.alloc(0), 'empty', 'application/octet-stream');
  assert.deepEqual(resolveStoredAttachment(attachment(r.url)), r);
  const stream = openUpload(r.path);
  fs.appendFileSync(r.path, 'added later');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  assert.equal(Buffer.concat(chunks).length, 0);
  const before = inventory();
  await assert.rejects(saveBytes(Buffer.alloc(0), 'empty', ''), status(400));
  assert.deepEqual(inventory(), before);
});

test('legacy sidecars preserve declared MIME and display names without digest or creation time', async () => {
  for (const [name, mime] of [
    ['extensionless', 'image/png'], ['actually-a-png.txt', 'image/png'],
    ['not-an-image.jpg', 'text/plain; charset=utf-8'], ['100%real.bin', 'image/webp'],
  ] as const) {
    const bytes = Buffer.from('legacy bytes');
    const r = legacySidecarFixture(bytes, name, mime);
    const sidecar = readFileSync(metadataPath(r.storedName));
    const before = statSync(r.path);
    assert.deepEqual(resolveUpload(r.storedName), r);
    assert.deepEqual(resolveStoredAttachment(attachment(r.url)), r);
    const chunks: Buffer[] = [];
    for await (const chunk of openUpload(r.path)) chunks.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.deepEqual(readFileSync(metadataPath(r.storedName)), sidecar);
    assert.equal(statSync(r.path).mtimeMs, before.mtimeMs);
    assert.equal(statSync(r.path).ino, before.ino);
  }
});

test('invalid, writable, and symlinked upload directories fail without following links', async () => {
  const target = join(TEST_ROOT, 'directory-target');
  mkdirSync(target);
  const linked = join(TEST_ROOT, 'linked-root');
  symlinkSync(resolve(target), linked);
  const regularFile = join(TEST_ROOT, 'not-a-directory');
  writeFileSync(regularFile, 'keep');
  const writable = join(TEST_ROOT, 'writable-root');
  mkdirSync(writable);
  chmodSync(writable, 0o777);
  for (const dir of [linked, join(linked, 'nested'), regularFile, writable]) {
    const storage = await storageAt(dir);
    await assert.rejects(storage.saveUploadStream(Readable.from([Buffer.from('x')]), 'name', 'text/plain'), status(500));
    assert.throws(() => storage.resolveUpload('legacy'), status(500));
  }
  assert.deepEqual(readdirSync(target), []);
  assert.equal(readFileSync(regularFile, 'utf8'), 'keep');
});

test('missing directories resolve without creating storage', async () => {
  const dir = join(TEST_ROOT, 'does-not-exist', 'uploads');
  const storage = await storageAt(dir);
  assert.equal(storage.resolveUpload('missing'), null);
  assert.throws(() => storage.resolveStoredAttachment(attachment('/uploads/missing')), status(404));
  assert.equal(existsSync(join(TEST_ROOT, 'does-not-exist')), false);
  const r = await storage.saveUploadStream(Readable.from([Buffer.from('x')]), 'created', '');
  assert.equal(storage.resolveUpload(r.storedName)?.size, 1);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('metadata directory symlinks and files block saves and resolution', async () => {
  const target = resolve(TEST_ROOT, 'metadata-target');
  mkdirSync(target);
  for (const type of ['symlink', 'file', 'writable']) {
    const dir = join(TEST_ROOT, `bad-metadata-${type}`);
    const storage = await storageAt(dir);
    const r = await storage.saveUploadStream(Readable.from([Buffer.from('kept')]), 'name', 'image/png');
    const metadataDir = join(dir, '.metadata');
    renameSync(metadataDir, join(dir, '.metadata-original'));
    if (type === 'symlink') symlinkSync(target, metadataDir);
    else if (type === 'file') writeFileSync(metadataDir, 'keep');
    else { mkdirSync(metadataDir); chmodSync(metadataDir, 0o777); }
    await assert.rejects(storage.saveUploadStream(Readable.from([Buffer.from('x')]), 'name', 'image/png'), status(500));
    assert.throws(() => storage.resolveUpload(r.storedName), status(500));
    assert.equal(readFileSync(r.path, 'utf8'), 'kept');
  }
  assert.deepEqual(readdirSync(target), []);
});

test('exclusive creation never overwrites an existing upload or its metadata', async (t) => {
  t.mock.method(Date, 'now', () => 123456789);
  t.mock.method(crypto, 'randomBytes', (size: number) => Buffer.alloc(size, 0xab));
  const r = await saveBytes(Buffer.from('first'), 'name.png', 'text/plain');
  const sidecar = readFileSync(metadataPath(r.storedName));
  const before = inventory();
  await assert.rejects(saveBytes(Buffer.from('second'), 'other.png', 'text/plain'), status(409));
  assert.deepEqual(inventory(), before);
  assert.equal(readFileSync(r.path, 'utf8'), 'first');
  assert.deepEqual(readFileSync(metadataPath(r.storedName)), sidecar);
  assert.deepEqual(resolveUpload(r.storedName), r);
});

test('an existing orphaned sidecar is never replaced on a name collision', async (t) => {
  t.mock.method(Date, 'now', () => 123456790);
  t.mock.method(crypto, 'randomBytes', (size: number) => Buffer.alloc(size, 0xcd));
  const r = await saveBytes(Buffer.from('first'), 'name.png', 'text/plain');
  const sidecar = readFileSync(metadataPath(r.storedName));
  rmSync(r.path);
  const before = inventory();
  await assert.rejects(saveBytes(Buffer.from('second'), 'name.png', 'text/plain'), status(500));
  assert.deepEqual(inventory(), before);
  assert.deepEqual(readFileSync(metadataPath(r.storedName)), sidecar);
  assert.equal(existsSync(r.path), false);
});

test('exclusive creation leaves colliding untracked files and symlinks untouched', async (t) => {
  t.mock.method(Date, 'now', () => 123456792);
  t.mock.method(crypto, 'randomBytes', (size: number) => Buffer.alloc(size, 0x42));
  const storedName = `upload-v1-123456792-${'42'.repeat(16)}.bin`;
  const path = join(TEST_DIR, storedName);
  writeFileSync(path, 'preexisting');
  const inode = statSync(path).ino;
  await assert.rejects(saveBytes(Buffer.from('replacement'), 'name', ''), status(500));
  assert.equal(statSync(path).ino, inode);
  assert.equal(readFileSync(path, 'utf8'), 'preexisting');
  rmSync(path);
  const target = resolve(TEST_ROOT, 'exclusive-target');
  writeFileSync(target, 'target');
  symlinkSync(target, path);
  await assert.rejects(saveBytes(Buffer.from('replacement'), 'name', ''), status(500));
  assert.ok(fs.lstatSync(path).isSymbolicLink());
  assert.equal(readFileSync(target, 'utf8'), 'target');
  assert.equal(existsSync(metadataPath(storedName)), false);
});

test('a fresh request can succeed after a conflicting generated name is refused', async (t) => {
  t.mock.method(Date, 'now', () => 123456791);
  const original = crypto.randomBytes;
  const collision = t.mock.method(crypto, 'randomBytes', (size: number) => Buffer.alloc(size, 0xef));
  const first = await saveBytes(Buffer.from('first'), 'name', '');
  await assert.rejects(saveBytes(Buffer.from('second'), 'name', ''), status(409));
  collision.mock.mockImplementation(original);
  const second = await saveBytes(Buffer.from('second'), 'name', '');
  assert.notEqual(first.storedName, second.storedName);
  assert.equal(readFileSync(first.path, 'utf8'), 'first');
  assert.equal(readFileSync(second.path, 'utf8'), 'second');
});

test('metadata publication is atomic, exclusive, and ordered after file fsync', async (t) => {
  const synced = new Set<number>();
  const fsync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    fsync(fd);
    synced.add(fs.fstatSync(fd).ino);
  });
  const link = fs.linkSync;
  let observed = false;
  t.mock.method(fs, 'linkSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (!String(destination).endsWith('.json')) {
      assert.ok(synced.has(statSync(source).ino));
      assert.equal(existsSync(destination), false);
      return link(source, destination);
    }
    const metadata = JSON.parse(readFileSync(source, 'utf8'));
    const dataPath = resolve(TEST_DIR, metadata.storedName);
    assert.ok(synced.has(statSync(dataPath).ino));
    assert.ok(synced.has(statSync(source).ino));
    assert.ok(synced.has(statSync(TEST_DIR).ino));
    assert.equal(existsSync(destination), false);
    assert.throws(() => resolveUpload(metadata.storedName), status(500));
    link(source, destination);
    assert.equal(resolveUpload(metadata.storedName)?.mime, 'image/png');
    observed = true;
  });
  const r = await saveBytes(PNG, 'mismatch.txt', 'image/png');
  assert.ok(observed);
  assert.ok(synced.has(statSync(join(TEST_DIR, '.metadata')).ino));
  assert.deepEqual(resolveUpload(r.storedName), r);
  assert.ok(!readdirSync(join(TEST_DIR, '.metadata')).some(name => name.startsWith('.pending-')));
});

test('partial data and sidecar write failures remove only newly-created files', async (t) => {
  for (const failureAt of [1, 2]) {
    const before = inventory();
    const write = fs.writeFileSync;
    let calls = 0;
    const mock = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (++calls === failureAt) {
        write(args[0], 'partial');
        throw ioError();
      }
      return write(...args);
    });
    try {
      await assert.rejects(saveBytes(Buffer.from('data'), 'name', 'image/png'), status(500));
      assert.deepEqual(inventory(), before);
    } finally {
      mock.mock.restore();
    }
  }
});

test('publication and durability failures are explicit and roll back the upload', async (t) => {
  for (const operation of ['data-link', 'sidecar-link', 'data-fsync', 'sidecar-fsync',
    'data-directory-fsync', 'metadata-directory-fsync']) {
    const before = inventory();
    const link = fs.linkSync;
    const fsync = fs.fsyncSync;
    let fileSyncs = 0;
    let links = 0;
    t.mock.method(fs, 'linkSync', (...args: Parameters<typeof fs.linkSync>) => {
      links++;
      if ((operation === 'data-link' && links === 1)
        || (operation === 'sidecar-link' && links === 2)) throw ioError();
      link(...args);
    });
    t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isFile()) fileSyncs++;
      if ((operation === 'data-fsync' && fileSyncs === 1)
        || (operation === 'sidecar-fsync' && fileSyncs === 2)
        || (operation === 'data-directory-fsync' && links === 1)
        || (operation === 'metadata-directory-fsync' && links === 2)) throw ioError();
      fsync(fd);
    });
    try {
      await assert.rejects(saveBytes(Buffer.from('data'), 'name', 'image/png'), status(500));
      assert.deepEqual(inventory(), before);
    } finally {
      t.mock.restoreAll();
    }
  }
});

test('storage permission errors are 500, not missing uploads', async (t) => {
  const r = await saveBytes(Buffer.from('data'), 'name', '');
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === r.path) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return open(...args);
  });
  assert.throws(() => resolveUpload(r.storedName), status(500));
  assert.throws(() => resolveStoredAttachment(attachment(r.url)), status(500));
});

test('UploadError exposes an HTTP-classifiable status', () => {
  const error = new UploadError('Invalid upload', 400);
  assert.equal(error.name, 'UploadError');
  assert.equal(error.statusCode, 400);
  assert.equal(error.message, 'Invalid upload');
});
