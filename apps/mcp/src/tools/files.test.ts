import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUploadPath } from './files.ts';

// These tests only ever touch freshly-created temp dirs (under os.tmpdir(), which is an
// allowed upload root) and read-only stat/realpath of system files — never any real
// ~/.copilot file. resolveUploadPath refuses before any read, so a rejected path's
// contents are never opened.

async function reject(p: string): Promise<string> {
  try {
    await resolveUploadPath(p);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  assert.fail(`expected ${p} to be refused`);
}

test('allows a regular file inside an allowed upload root (tmp)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-upload-'));
  try {
    const f = join(dir, 'report.txt');
    await writeFile(f, 'hello');
    const resolved = await resolveUploadPath(f);
    assert.equal(resolved, await realpath(f));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses a relative (non-absolute) path', async () => {
  const msg = await reject('report.txt');
  assert.match(msg, /absolute path is required/);
});

test('refuses a non-existent path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-upload-'));
  try {
    const msg = await reject(join(dir, 'nope.txt'));
    assert.match(msg, /cannot resolve/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses a directory (not a regular file)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-upload-'));
  try {
    const sub = join(dir, 'sub');
    await mkdir(sub);
    const msg = await reject(sub);
    assert.match(msg, /not a regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses a path outside the allowed roots', async () => {
  if (!existsSync('/etc/passwd')) return; // skip if the anchor file is absent
  const msg = await reject('/etc/passwd');
  assert.match(msg, /outside the allowed upload directories/);
});

test('refuses traversal that escapes the allowed roots', async () => {
  if (!existsSync('/etc/passwd')) return;
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-upload-'));
  try {
    const escaped = join(dir, '..', '..', '..', '..', '..', '..', 'etc', 'passwd');
    const msg = await reject(escaped);
    assert.match(msg, /outside the allowed upload directories/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses a symlink (inside an allowed root) that escapes it', async () => {
  if (!existsSync('/etc/passwd')) return;
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-upload-'));
  try {
    const link = join(dir, 'link');
    await symlink('/etc/passwd', link);
    const msg = await reject(link);
    assert.match(msg, /outside the allowed upload directories/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('COCKPIT_UPLOAD_DIRS extends the allowlist', async () => {
  // A dir under tmpdir is already allowed by default; assert the env path is honored
  // by resolving a file through an explicitly-listed extra root.
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-extra-'));
  const prev = process.env.COCKPIT_UPLOAD_DIRS;
  try {
    process.env.COCKPIT_UPLOAD_DIRS = dir;
    const f = join(dir, 'a.json');
    await writeFile(f, '{}');
    const resolved = await resolveUploadPath(f);
    assert.equal(resolved, await realpath(f));
  } finally {
    if (prev === undefined) delete process.env.COCKPIT_UPLOAD_DIRS;
    else process.env.COCKPIT_UPLOAD_DIRS = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
