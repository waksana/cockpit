import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateScriptRejection } from './hooks.ts';

// COCKPIT_FLOWS_DIR is read at call time, so each test points it at a fresh temp dir —
// no real ~/.copilot/flows file is ever touched.

async function withFlowsDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-flows-'));
  const prev = process.env.COCKPIT_FLOWS_DIR;
  process.env.COCKPIT_FLOWS_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.COCKPIT_FLOWS_DIR;
    else process.env.COCKPIT_FLOWS_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test('accepts a safe-basename path inside the flows dir (not yet written)', async () => {
  await withFlowsDir(async (dir) => {
    assert.equal(await gateScriptRejection(join(dir, 'welcome-gate.sh')), null);
  });
});

test('accepts a real gate file written into the flows dir', async () => {
  await withFlowsDir(async (dir) => {
    const f = join(dir, 'gate.sh');
    await writeFile(f, '#!/bin/sh\nexit 0\n');
    assert.equal(await gateScriptRejection(f), null);
  });
});

test('refuses an executable outside the flows dir', async () => {
  await withFlowsDir(async () => {
    const msg = await gateScriptRejection('/usr/bin/curl');
    assert.ok(msg);
    assert.match(msg!, /inside the flows dir/);
  });
});

test('refuses traversal escaping the flows dir', async () => {
  await withFlowsDir(async (dir) => {
    const msg = await gateScriptRejection(join(dir, '..', '..', '.ssh', 'id_rsa'));
    assert.ok(msg);
    assert.match(msg!, /inside the flows dir/);
  });
});

test('refuses an unsafe basename inside the flows dir', async () => {
  await withFlowsDir(async (dir) => {
    const msg = await gateScriptRejection(join(dir, '.hidden'));
    assert.ok(msg);
    assert.match(msg!, /inside the flows dir/);
  });
});

test('refuses a symlink in the flows dir that escapes it', async () => {
  if (!existsSync('/etc/passwd')) return;
  await withFlowsDir(async (dir) => {
    const link = join(dir, 'evil');
    await symlink('/etc/passwd', link);
    const msg = await gateScriptRejection(link);
    assert.ok(msg);
    assert.match(msg!, /escapes the flows dir/);
  });
});
