// Unit tests for the upload storage module. Isolates to a temp dir via the
// COCKPIT_UPLOAD_DIR env override (read at module load, so set BEFORE importing).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DIR = mkdtempSync(join(tmpdir(), 'cockpit-uploads-test-'));
process.env.COCKPIT_UPLOAD_DIR = TEST_DIR;

// Import AFTER setting the env (module reads UPLOAD_DIR at load time).
const { saveUpload, resolveUpload, openUpload, mimeForStored, UPLOAD_DIR } = await import('./uploads.ts');

after(() => { rmSync(TEST_DIR, { force: true, recursive: true }); });

test('UPLOAD_DIR honors the env override', () => {
  assert.equal(UPLOAD_DIR, TEST_DIR);
});

test('saveUpload writes bytes + returns metadata', () => {
  const data = Buffer.from('hello cockpit');
  const r = saveUpload(data, 'note.txt', 'text/plain');
  assert.equal(r.kind, 'file');
  assert.equal(r.name, 'note.txt');
  assert.equal(r.size, data.length);
  assert.equal(r.url, `/uploads/${r.storedName}`);
  assert.ok(r.path.startsWith(TEST_DIR));
  assert.ok(existsSync(r.path));
  assert.equal(readFileSync(r.path, 'utf-8'), 'hello cockpit');
});

test('image mime → kind=image', () => {
  const r = saveUpload(Buffer.from([1, 2, 3]), 'pic.png', 'image/png');
  assert.equal(r.kind, 'image');
});

test('stored name keeps only a safe extension; no user path chars', () => {
  const r = saveUpload(Buffer.from('x'), '../../etc/pwn.png', 'image/png');
  // storedName is <ts>-<rand>.png — no slashes, dots-dots, or original basename.
  assert.match(r.storedName, /^\d+-[0-9a-f]{12}\.png$/);
  assert.ok(!r.storedName.includes('/'));
  assert.ok(!r.storedName.includes('..'));
  // The display name preserves the original (rendered as text, never a path).
  assert.equal(r.name, '../../etc/pwn.png');
});

test('newline/control chars stripped from display name', () => {
  const r = saveUpload(Buffer.from('x'), 'a\nb\tc\rd', 'text/plain');
  assert.ok(!/[\r\n\t]/.test(r.name));
});

test('resolveUpload finds a saved file, returns its size', () => {
  const r = saveUpload(Buffer.from('1234567890'), 'f.bin', 'application/octet-stream');
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
  ]) {
    assert.equal(resolveUpload(bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('resolveUpload rejects a name that escapes even if the file exists', () => {
  // Plant a file OUTSIDE the upload dir; a traversal name must NOT reach it.
  const outside = join(TEST_DIR, '..', 'secret-outside.txt');
  writeFileSync(outside, 'top secret');
  assert.equal(resolveUpload('../secret-outside.txt'), null);
  rmSync(outside, { force: true });
});

test('resolveUpload returns null for a non-existent (but well-formed) name', () => {
  assert.equal(resolveUpload('1234-deadbeefcafe.png'), null);
});

test('openUpload streams the stored bytes', async () => {
  const r = saveUpload(Buffer.from('streamed!'), 's.txt', 'text/plain');
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
});
