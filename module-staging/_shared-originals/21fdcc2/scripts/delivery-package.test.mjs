import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
test('the committed runtime closure includes bundled skills instead of relying on global copies', async () => {
  const config = JSON.parse(await readFile(join(repository, 'service-delivery.json'), 'utf8'));
  assert.ok(config.build.artifactPaths.includes('skills'), 'Root bundled skills must be packaged');
  assert.ok(config.build.artifactPaths.includes('packages/core/src'), 'Packaged core must resolve its own skill directory');
  assert.equal(config.build.artifactPaths.includes('modules'), false, 'Business module payloads are not main artifacts');
});

test('archive guard accepts complete fixtures and rejects omitted skills or broken references', {
  skip: Boolean(process.env.COCKPIT_RELEASE_ARCHIVE),
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-skill-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), archive = join(root, 'runtime.tar.gz');
  await mkdir(join(source, 'skills/self-context-reset'), { recursive: true });
  await mkdir(join(source, 'packages/core/src'), { recursive: true });
  await writeFile(join(source, 'packages/core/src/paths.ts'),
    await readFile(join(repository, 'packages/core/src/paths.ts')));
  await writeFile(join(source, 'skills/self-context-reset/SKILL.md'),
    await readFile(join(repository, 'skills/self-context-reset/SKILL.md')));
  await writeFile(join(source, 'delivery-manifest.json'), JSON.stringify({
    files: { 'skills/self-context-reset/SKILL.md': { sha256: 'a'.repeat(64) } },
  }));
  const check = () => {
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    return () => execFileSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], {
      env: { ...environment, COCKPIT_RELEASE_ARCHIVE: archive }, stdio: 'pipe',
    });
  };
  assert.doesNotThrow(check());
  await writeFile(join(source, 'skills/self-context-reset/SKILL.md'),
    '---\nname: self-context-reset\n---\n[Required procedure](references/missing.md)\n');
  assert.throws(check());
  await rm(join(source, 'skills/self-context-reset/SKILL.md'));
  assert.throws(check());
});

test('actual release archive resolves bundled skills and readable local references inside its package', {
  skip: !process.env.COCKPIT_RELEASE_ARCHIVE,
}, async t => {
  const archive = resolve(process.env.COCKPIT_RELEASE_ARCHIVE);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n');
  assert.ok(entries.every(path => !path.startsWith('/') && !path.split('/').includes('..')));
  assert.ok(entries.includes('./skills/self-context-reset/SKILL.md'), 'Actual archive omits self-context-reset');
  assert.equal(entries.some(path => /^\.\/(?:modules\/|packages\/core\/src\/modules\/.+|scripts\/consumer\/module-runner\.mjs$)/.test(path)),
    false, 'Actual main archive must not ship business modules or their retired runtime');
  const root = await mkdtemp(join(tmpdir(), 'cockpit-skill-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('tar', ['-xzf', archive, '-C', root, './skills', './packages/core/src/paths.ts', './delivery-manifest.json']);
  const manifest = JSON.parse(await readFile(join(root, 'delivery-manifest.json'), 'utf8'));
  assert.ok(manifest.files['skills/self-context-reset/SKILL.md']?.sha256);
  const { bundledSkillsDirectory } = await import(pathToFileURL(join(root, 'packages/core/src/paths.ts')).href);
  assert.equal(resolve(bundledSkillsDirectory), join(root, 'skills'));
  const definition = await readFile(join(bundledSkillsDirectory, 'self-context-reset/SKILL.md'), 'utf8');
  assert.match(definition, /^name: self-context-reset$/m);
  async function check(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const actual = await realpath(file);
      assert.ok(actual.startsWith(`${root}${sep}`), 'Bundled skill must not point into a development/user directory');
      if (entry.isDirectory()) { await check(file); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = await readFile(file, 'utf8');
      for (const [, link] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        if (/^(?:[a-z]+:|#)/i.test(link)) continue;
        const target = await realpath(resolve(dirname(file), link.split('#')[0]));
        assert.ok(target.startsWith(`${root}${sep}`), 'Local skill reference escapes release');
        assert.ok((await stat(target)).isFile(), `Unreadable bundled reference: ${link}`);
      }
    }
  }
  await check(bundledSkillsDirectory);
});
