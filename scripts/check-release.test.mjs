import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkRelease, checkSourceVersion, checkTagTarget } from './check-release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['', 'apps/server', 'apps/mcp', 'apps/web', 'packages/core', 'packages/protocol', 'packages/module-api']) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  }
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'apps/mcp/src'));
  writeFileSync(join(root, 'apps/mcp/src/index.ts'),
    "const server = new McpServer({ name: 'cockpit-mcp-server', version: MCP_SERVER_VERSION });\n");
  writeFileSync(join(root, 'docs/release-notes.md'), '# Cockpit 0.1.0\n');
  const manifest = { format: 1, product: 'cockpit', version: '0.1.0', sourceSha: 'a'.repeat(40),
    node: process.versions.node, platform: 'linux', arch: 'x64' };
  const archive = join(root, 'runtime.tar.gz');
  const pack = () => {
    writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify(manifest));
    execFileSync('tar', ['-czf', archive, '-C', root, './runtime-manifest.json']);
    const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(`${archive}.sha256`, `${hash}  runtime.tar.gz\n`);
  };
  pack();
  return { root, archive, manifest, pack, check: () => checkRelease('v0.1.0', 'a'.repeat(40), archive, root) };
}

test('checked-in workspace, MCP and delivery notes use one version', () => {
  checkSourceVersion(fileURLToPath(new URL('..', import.meta.url)));
});

test('delivery rejects a hard-coded MCP self-reported version', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'apps/mcp/src/index.ts'),
    "const server = new McpServer({ name: 'cockpit-mcp-server', version: '0.1.0' });\n");
  assert.throws(f.check, /MCP self-reported version/);
});

test('delivery rejects a module SDK workspace version that differs from its host', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'packages/module-api/package.json'), JSON.stringify({ version: '0.0.9' }));
  assert.throws(f.check, /packages\/module-api version/);
});

test('release metadata binds the tag, all workspace versions, fixed archive and current Node platform', t => {
  const f = fixture(t);
  assert.equal(f.check().sourceSha, f.manifest.sourceSha);
  assert.throws(() => checkRelease('modules-stable', f.manifest.sourceSha, f.archive, f.root), /Release tags/);
  writeFileSync(join(f.root, 'apps/mcp/package.json'), JSON.stringify({ version: '0.0.9' }));
  assert.throws(f.check, /apps\/mcp version/);
});

test('release rejects a checksum mismatch or a package built from another commit', t => {
  const f = fixture(t);
  writeFileSync(`${f.archive}.sha256`, `${'0'.repeat(64)}  runtime.tar.gz\n`);
  assert.throws(f.check);
  f.manifest.sourceSha = 'b'.repeat(40);
  f.pack();
  assert.throws(f.check);
});

test('release rejects an unsupported package platform or different Node version', t => {
  const f = fixture(t);
  f.manifest.platform = 'darwin';
  f.pack();
  assert.throws(f.check);
  f.manifest.platform = 'linux';
  f.manifest.node = '0.0.0';
  f.pack();
  assert.throws(f.check);
});

test('release notes cannot describe a different version than the artifact', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'docs/release-notes.md'), '# Cockpit 0.0.9\n');
  assert.throws(f.check, /Release notes must match the workspace version/);
});

test('release binds both lightweight and annotated remote tags and rejects moved or missing tags', () => {
  const sha = 'a'.repeat(40), other = 'b'.repeat(40);
  checkTagTarget('v0.1.0', sha, `${sha}\trefs/tags/v0.1.0\n`);
  checkTagTarget('v0.1.0', sha, `${other}\trefs/tags/v0.1.0\n${sha}\trefs/tags/v0.1.0^{}\n`);
  assert.throws(() => checkTagTarget('v0.1.0', sha, `${other}\trefs/tags/v0.1.0\n`), /tag moved/);
  assert.throws(() => checkTagTarget('v0.1.0', sha, `${sha}\trefs/tags/v0.1.0\n${other}\trefs/tags/v0.1.0^{}\n`), /tag moved/);
  assert.throws(() => checkTagTarget('v0.1.0', sha, ''), /no longer exists/);
});
