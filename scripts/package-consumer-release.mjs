#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyArtifact } from '../.delivery/toolkit/lib/artifact.mjs';
import { ModuleReleaseMetadata, ModuleReleaseTarget } from '../packages/protocol/src/modules.ts';

const extractor = fileURLToPath(new URL('../.delivery/toolkit/bin/extract.py', import.meta.url));
const maxBytes = 400 * 1024 * 1024;
export const bootstrapFiles = Object.freeze({
  'cli.mjs': 'scripts/consumer/cli.mjs', 'launcher.mjs': 'scripts/consumer/launcher.mjs',
  'state.mjs': 'scripts/consumer/state.mjs', 'channel.mjs': 'scripts/consumer/channel.mjs',
  'archive.mjs': 'scripts/consumer/archive.mjs',
  'module-runner.mjs': 'scripts/consumer/module-runner.mjs',
  'release-transport.mjs': 'packages/core/src/consumer/release-transport.mjs',
  'artifact.mjs': '.delivery/toolkit/lib/artifact.mjs', 'extract.py': '.delivery/toolkit/bin/extract.py',
});

async function signJson(value, key, path) {
  const payload = Buffer.from(JSON.stringify(value));
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
  const fd = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
  try { await fd.writeFile(JSON.stringify(envelope)); await fd.sync(); }
  finally { await fd.close(); }
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size };
}

function https(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Publisher URL must be HTTPS without credentials or fragment');
  }
}

/** Wrap an already-built CI tar unchanged; never rebuild from the publisher's working tree. */
export async function packageConsumerRelease({ runtime, metadataFile, keyFile, output }) {
  if (process.platform !== 'linux' || process.arch !== 'x64'
    || Number(process.versions.node.split('.')[0]) !== 24 || !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error('Consumer publisher packaging requires Linux x64/glibc and Node 24');
  }
  for (const path of [runtime, metadataFile, keyFile, output]) {
    if (!isAbsolute(path)) throw new Error('Publisher paths must be absolute');
  }
  const specification = JSON.parse(await readFile(metadataFile, 'utf8'));
  const { version, sourceSha, url, ...channel } = specification;
  const metadata = ModuleReleaseMetadata.omit({ targets: true }).strict().parse(channel);
  ModuleReleaseTarget.omit({ moduleId: true }).strict().parse({
    version, sourceSha, url, platform: 'linux', arch: 'x64', nodeMajor: 24,
    sha256: '0'.repeat(64), bytes: 1,
  });
  https(url);
  const now = Date.now();
  if (Date.parse(metadata.issuedAt) > now + 300_000 || Date.parse(metadata.expiresAt) <= now
    || Date.parse(metadata.expiresAt) <= Date.parse(metadata.issuedAt)) {
    throw new Error('Publisher metadata validity interval is invalid');
  }
  const keyStat = await lstat(keyFile);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.nlink !== 1 || keyStat.size > 16_384
    || keyStat.uid !== process.getuid() || (keyStat.mode & 0o077)) {
    throw new Error('Publisher key must be an owner-only regular file');
  }
  const key = createPrivateKey(await readFile(keyFile));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Publisher key must be Ed25519');
  const runtimeStat = await lstat(runtime);
  if (!runtimeStat.isFile() || runtimeStat.isSymbolicLink() || runtimeStat.size > maxBytes) {
    throw new Error('Expected a bounded regular CI runtime.tar.gz');
  }
  // Exclusive output creation deliberately leaves failed attempts inspectable; never retry/overwrite.
  await mkdir(output, { mode: 0o700 });
  const archive = join(output, 'cockpit-linux-x64.zip');
  execFileSync('python3', ['-c',
    'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[2],"x",compression=zipfile.ZIP_STORED) as z: z.write(sys.argv[1],"runtime.tar.gz")',
    runtime, archive], { stdio: 'pipe' });
  const verifyRoot = join(output, 'verification');
  await mkdir(verifyRoot, { mode: 0o700 });
  const extracted = join(verifyRoot, 'release');
  await mkdir(extracted, { mode: 0o700 });
  try {
    execFileSync('python3', [extractor, archive, extracted], { stdio: 'pipe' });
    const manifest = await verifyArtifact(extracted, { format: 1, sourceSha });
    for (const relative of ['apps/server/src/index.ts', 'apps/server/package.json', 'apps/web/dist/index.html',
      'packages/core/src/index.ts', 'packages/core/src/modules/supervisor-entry.ts', 'packages/protocol/src/index.ts']) {
      if (!(await stat(join(extracted, relative))).isFile()) throw new Error(`Main release omits ${relative}`);
    }
    const mainPackage = JSON.parse(await readFile(join(extracted, 'apps/server/package.json'), 'utf8'));
    if (mainPackage.version !== version) throw new Error('Publisher version differs from packaged server version');
    const compatibility = JSON.parse(await readFile(join(extracted, 'consumer-runtime.json'), 'utf8'));
    if (compatibility.schemaVersion !== 1 || compatibility.automaticDataMigrations !== false
      || !/^[a-zA-Z0-9_.-]{1,100}$/.test(compatibility.dataCompatibility)) throw new Error('Missing consumer data/config compatibility declaration');
    if (compatibility.moduleRunnerApi !== 1) throw new Error('Consumer publisher requires module runner API1 compatibility');
    const bytes = (await stat(archive)).size;
    if (bytes > maxBytes) throw new Error('Consumer archive exceeds signed transport limit');
    const { sha256 } = await digest(archive);
    const target = { moduleId: 'cockpit', version, platform: 'linux', arch: 'x64', nodeMajor: 24,
      sourceSha, sha256, bytes, url };
    const bootstrapDirectory = join(verifyRoot, 'bootstrap');
    await mkdir(bootstrapDirectory, { mode: 0o700 });
    for (const [destination, source] of Object.entries(bootstrapFiles)) {
      await copyFile(join(extracted, source), join(bootstrapDirectory, destination), constants.COPYFILE_EXCL);
    }
    const bootstrapArchive = join(output, 'cockpit-bootstrap.zip');
    execFileSync('python3', ['-c',
      'import os,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2],"x",compression=zipfile.ZIP_DEFLATED) as z:\n for name in sorted(os.listdir(sys.argv[1])): z.write(os.path.join(sys.argv[1],name),name)',
      bootstrapDirectory, bootstrapArchive], { stdio: 'pipe' });
    const bootstrapEnvelope = join(output, 'bootstrap.signed.json');
    await signJson({ schemaVersion: 1, kind: 'cockpit-bootstrap', sourceSha, ...await digest(bootstrapArchive) }, key, bootstrapEnvelope);
    const envelopePath = join(output, 'stable.signed.json');
    await signJson({ ...metadata, targets: [target] }, key, envelopePath);
    return { archive, envelope: envelopePath, target, bootstrapArchive, bootstrapEnvelope, configSha256: manifest.configSha256 };
  } finally {
    await rm(verifyRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 6) {
    console.error('Usage: node scripts/package-consumer-release.mjs RUNTIME_TAR_GZ METADATA_JSON PRIVATE_KEY_FILE NEW_OUTPUT_DIRECTORY');
    process.exitCode = 2;
  } else {
    const [runtime, metadataFile, keyFile, output] = process.argv.slice(2).map(path => resolve(path));
    try { console.log(JSON.stringify(await packageConsumerRelease({ runtime, metadataFile, keyFile, output }))); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Consumer packaging failed'); process.exitCode = 1; }
  }
}
