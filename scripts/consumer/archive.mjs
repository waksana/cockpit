import { execFileSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, verifyArtifact } from './artifact.mjs';
import { syncDirectory, writeJson } from './state.mjs';

const bundledExtractor = fileURLToPath(new URL(
  existsSync(fileURLToPath(new URL('extract.py', import.meta.url))) ? 'extract.py' : '../../.delivery/toolkit/bin/extract.py', import.meta.url));

export async function validateRelease(release, target, expectedManifestSha256) {
  const directory = await lstat(release);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(release) !== release) {
    throw new Error('Release must be an immutable canonical directory, not a link to another installation');
  }
  const manifestSha256 = await hashFile(join(release, 'delivery-manifest.json'));
  if (expectedManifestSha256 !== undefined && manifestSha256 !== expectedManifestSha256) {
    throw new Error('Installed manifest differs from the verified archive manifest');
  }
  const manifest = await verifyArtifact(release, { format: 1, sourceSha: target.sourceSha });
  const compatibility = JSON.parse(await readFile(join(release, 'consumer-runtime.json'), 'utf8'));
  if (compatibility.schemaVersion !== 1 || compatibility.automaticDataMigrations !== false
    || !/^[a-zA-Z0-9_.-]{1,100}$/.test(compatibility.dataCompatibility)) {
    throw new Error('Consumer release requires explicit no-automatic-migration compatibility declaration');
  }
  if (compatibility.moduleRunnerApi !== 1) throw new Error('Consumer release must explicitly support module runner API1; automatic runner upgrades are unsupported');
  for (const path of ['apps/server/src/index.ts', 'apps/server/package.json', 'apps/web/dist/index.html',
    'packages/core/src/index.ts', 'packages/core/src/modules/supervisor-entry.ts', 'packages/protocol/src/index.ts']) {
    if (!(await stat(join(release, path))).isFile()) throw new Error(`Release missing ${path}`);
  }
  const pkg = JSON.parse(await readFile(join(release, 'apps/server/package.json'), 'utf8'));
  if (pkg.version !== target.version) throw new Error('Signed version differs from packaged server version');
  // Resolve the existing platform runtime from server cwd; the root deliberately has no tsx.
  execFileSync(process.execPath, ['--import', 'tsx', '--eval', ''], {
    cwd: join(release, 'apps/server'), stdio: 'pipe', timeout: 30_000,
  });
  return { compatibility: compatibility.dataCompatibility, moduleRunnerApi: 1, manifest, manifestSha256 };
}

export async function retainAssets(root, release) {
  const source = join(release, 'apps/web/dist/assets');
  try { await lstat(source); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  async function copy(directory, destination) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const from = join(directory, entry.name), to = join(destination, entry.name);
      if (entry.isDirectory()) { await copy(from, to); continue; }
      if (!entry.isFile()) throw new Error('Web retained assets must be regular files');
      try { await copyFile(from, to, constants.COPYFILE_EXCL); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if ((await lstat(to)).isSymbolicLink() || await hashFile(from) !== await hashFile(to)) throw new Error('Retained Web asset content collision');
      }
    }
  }
  await copy(source, join(root, 'assets'));
}

export async function stageArchive(root, operation, extractor = bundledExtractor) {
  const { target, operationId } = operation;
  const archive = join(root, 'downloads', `${operation.downloadId}.zip`);
  const archiveStat = await lstat(archive);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size !== target.bytes || await hashFile(archive) !== target.sha256) {
    throw new Error('Downloaded archive no longer matches signed identity');
  }
  const stage = join(root, 'staging', operationId);
  await mkdir(stage, { mode: 0o700 });
  const extracted = join(stage, 'release');
  await mkdir(extracted, { mode: 0o700 });
  execFileSync('python3', [extractor, archive, extracted], { stdio: 'pipe', timeout: 120_000 });
  const { compatibility, moduleRunnerApi, manifestSha256 } = await validateRelease(extracted, target);
  await retainAssets(root, extracted);
  const release = join(root, 'releases', target.sha256);
  let existing = true;
  try { await lstat(release); } catch (error) { if (error.code !== 'ENOENT') throw error; existing = false; }
  if (existing) {
    await validateRelease(release, target, manifestSha256);
  } else {
    await rename(extracted, release);
    syncDirectory(join(root, 'releases'));
  }
  const selection = { target, release, compatibility, moduleRunnerApi, manifestSha256 };
  writeJson(join(stage, 'verified.json'), selection, true);
  return selection;
}
