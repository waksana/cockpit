#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { verifyArtifact } from '../.delivery/toolkit/lib/artifact.mjs';
import { ModuleId, ModuleReleaseTarget } from '../packages/protocol/src/modules.ts';

const repositories = { assistant: 'cockpit', task: 'cockpit-task', wechat: 'cockpit-wechat-connector' };
const extractor = fileURLToPath(new URL('../.delivery/toolkit/bin/extract.py', import.meta.url));
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { inspectModulePackage } = await tsImport('../packages/core/src/modules/catalog.ts', import.meta.url);

export async function packageModuleRelease({ archive, specification, output }) {
  for (const path of [archive, output]) if (!isAbsolute(path)) throw new Error('Publisher paths must be absolute');
  const moduleId = ModuleId.parse(specification.moduleId);
  if (!/^[a-f0-9]{40}$/.test(specification.sourceSha)
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(specification.version)
    || Object.keys(specification).some(key => !['moduleId', 'sourceSha', 'version'].includes(key))) {
    throw new Error('Publisher requires one explicit module version and fixed source SHA');
  }
  const sourceStat = await stat(archive);
  if (!sourceStat.isFile() || sourceStat.size > 400 * 1024 * 1024) throw new Error('Expected a bounded CI archive');
  await mkdir(output, { mode: 0o700 });
  const extracted = join(output, 'verified-ci');
  await mkdir(extracted, { mode: 0o700 });
  try {
    execFileSync('python3', [extractor, archive, extracted], { stdio: 'pipe' });
    const ci = await verifyArtifact(extracted, { format: 1, sourceSha: specification.sourceSha });
    const source = moduleId === 'assistant' ? join(extracted, 'modules/assistant') : extracted;
    const inspected = inspectModulePackage(source);
    if (inspected.manifest.id !== moduleId || inspected.manifest.version !== specification.version) {
      throw new Error('Fixed CI artifact has a different module identity or version');
    }
    const filename = `${moduleId}-linux-x64.zip`, destination = join(output, filename);
    if (moduleId === 'assistant') {
      const tar = join(output, 'runtime.tar.gz');
      execFileSync('tar', ['-czf', tar, '-C', source, '.'], { stdio: 'pipe' });
      execFileSync('python3', ['-c',
        'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[2],"x",compression=zipfile.ZIP_STORED) as z: z.write(sys.argv[1],"runtime.tar.gz")',
        tar, destination], { stdio: 'pipe' });
      await rm(tar);
    } else await copyFile(archive, destination, constants.COPYFILE_EXCL);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    const tag = moduleId === 'assistant' ? `assistant-v${specification.version}` : `v${specification.version}`;
    const target = ModuleReleaseTarget.parse({
      ...specification, platform: ci.platform, arch: ci.arch, nodeMajor: Number(ci.node.split('.')[0]),
      sha256: hash.digest('hex'), bytes: (await stat(destination)).size,
      url: `https://github.com/waksana/${repositories[moduleId]}/releases/download/${tag}/${filename}`,
    });
    const result = { archive: destination, repository: `waksana/${repositories[moduleId]}`, tag,
      target, inventoryDigest: inspected.digest, buildRunId: ci.buildRunId, configSha256: ci.configSha256,
      unchangedCiZip: moduleId !== 'assistant' };
    await writeFile(join(output, 'target.json'), JSON.stringify(target, null, 2), { flag: 'wx', mode: 0o644 });
    await writeFile(join(output, 'provenance.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o644 });
    return result;
  } finally {
    await rm(extracted, { recursive: true, force: true });
    await rm(join(output, 'runtime.tar.gz'), { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) {
    console.error('Usage: node scripts/package-module-release.mjs CI_ZIP SPECIFICATION_JSON NEW_OUTPUT_DIRECTORY');
    process.exitCode = 2;
  } else {
    const [archive, specFile, output] = process.argv.slice(2).map(path => resolve(path));
    try { console.log(JSON.stringify(await packageModuleRelease({ archive, specification: JSON.parse(await readFile(specFile, 'utf8')), output }))); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Module publisher packaging failed'); process.exitCode = 1; }
  }
}
