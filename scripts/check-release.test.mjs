import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  checkRelease,
  checkSdkRelease,
  checkSdkSourceVersion,
  checkSdkTagTarget,
  checkSourceVersion,
  checkTagTarget,
} from './check-release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['', 'apps/server', 'apps/mcp', 'apps/web', 'packages/core', 'packages/protocol']) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  }
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'apps/mcp/src'));
  writeFileSync(join(root, 'apps/mcp/src/index.ts'),
    "const server = new McpServer({ name: 'cockpit-mcp-server', version: MCP_SERVER_VERSION });\n");
  writeFileSync(join(root, 'docs/release-notes.md'), '# Cockpit 0.1.0\n');
  mkdirSync(join(root, 'packages/module-api'), { recursive: true });
  writeFileSync(join(root, 'packages/module-api/package.json'), JSON.stringify({
    name: '@waksana/cockpit-module-sdk',
    version: '0.1.0',
    publishConfig: { registry: 'https://npm.pkg.github.com' },
  }));
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

test('release notes keep only the current version', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'docs/release-notes.md'), '# Cockpit 0.1.0\n\nChanges.\n\n## Upgrade notes\n\nNone.\n');
  checkSourceVersion(f.root);
  writeFileSync(join(f.root, 'docs/release-notes.md'),
    '# Cockpit 0.1.0\n\n## Upgrading from 0.0.9\n\n## Native SDK 1.0.14\n\n```sh\n# restart the service\n```\n');
  checkSourceVersion(f.root);
  for (const stale of ['# Cockpit 0.0.9\n', '## Cockpit 0.0.9\n', '# Unreleased source: feature\n', '### Unreleased\n']) {
    writeFileSync(join(f.root, 'docs/release-notes.md'), `# Cockpit 0.1.0\n\nChanges.\n\n---\n\n${stale}`);
    assert.throws(() => checkSourceVersion(f.root), /only the current version/);
  }
});

test('delivery rejects a hard-coded MCP self-reported version', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'apps/mcp/src/index.ts'),
    "const server = new McpServer({ name: 'cockpit-mcp-server', version: '0.1.0' });\n");
  assert.throws(f.check, /MCP self-reported version/);
});

test('host delivery permits an independently versioned module SDK', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'packages/module-api/package.json'), JSON.stringify({ version: '0.0.9' }));
  f.check();
});

test('SDK source version is independent but keeps strict package identity', t => {
  const f = fixture(t);
  assert.equal(checkSdkSourceVersion(f.root), '0.1.0');
  const manifest = JSON.parse(readFileSync(join(f.root, 'packages/module-api/package.json'), 'utf8'));
  manifest.version = '2.3.4';
  writeFileSync(join(f.root, 'packages/module-api/package.json'), JSON.stringify(manifest));
  assert.equal(checkSdkSourceVersion(f.root), '2.3.4');
  manifest.dependencies = { internal: 'workspace:*' };
  writeFileSync(join(f.root, 'packages/module-api/package.json'), JSON.stringify(manifest));
  assert.throws(() => checkSdkSourceVersion(f.root), /runtime dependencies|workspace/);
});

test('SDK release binds its independent tag to the packed name and version', t => {
  const f = fixture(t);
  const sdkRoot = join(f.root, 'sdk-pack');
  mkdirSync(join(sdkRoot, 'package/dist'), { recursive: true });
  writeFileSync(join(sdkRoot, 'package/package.json'), readFileSync(join(f.root, 'packages/module-api/package.json')));
  writeFileSync(join(sdkRoot, 'package/dist/index.js'), 'export {};\n');
  writeFileSync(join(sdkRoot, 'package/dist/index.d.ts'), 'export {};\n');
  const archive = join(f.root, 'sdk.tgz');
  execFileSync('tar', ['-czf', archive, '-C', sdkRoot, 'package']);
  assert.equal(checkSdkRelease('module-sdk-v0.1.0', 'a'.repeat(40), archive, f.root).package,
    '@waksana/cockpit-module-sdk');
  assert.throws(() => checkSdkRelease('v0.1.0', 'a'.repeat(40), archive, f.root), /SDK release tags/);
  assert.throws(() => checkSdkRelease('module-sdk-v0.1.1', 'a'.repeat(40), archive, f.root), /match the tag/);
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

test('SDK release binds its own tag namespace without accepting host tags', () => {
  const sha = 'a'.repeat(40);
  checkSdkTagTarget('module-sdk-v0.1.0', sha, `${sha}\trefs/tags/module-sdk-v0.1.0\n`);
  assert.throws(() => checkSdkTagTarget('v0.1.0', sha, `${sha}\trefs/tags/v0.1.0\n`));
});
