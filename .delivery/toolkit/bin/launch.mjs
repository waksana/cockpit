#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, lstat, mkdir, copyFile, rename, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { call } from '../lib/client.mjs';
import { hashFile, verifyArtifact } from '../lib/artifact.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
try {
  let release;
  try {
    release = await call(config.credential, '/boot', { projectId: config.projectId, instanceId: randomUUID() },
      { timeoutMs: 120_000 });
  } catch (error) {
    if (!config.bootstrapFallback || !config.environment) throw error;
    const db = new DatabaseSync(join(config.root, 'delivery.sqlite'), { readOnly: true });
    let active;
    try { active = db.prepare('SELECT body FROM settings WHERE id=?').get(`active:${config.projectId}:${config.environment}`); }
    finally { db.close(); }
    if (active) throw error;
    console.error(`Unaccepted first-migration bootstrap fallback: ${error.message}`);
    release = { ...config.bootstrapFallback, instanceId: randomUUID() };
  }
  await verifyArtifact(release.root, { sourceSha: release.sha });
  const selectionRoot = config.selectionRoot ?? config.root;
  await mkdir(selectionRoot, { recursive: true });
  const assets = join(selectionRoot, 'assets');
  await mkdir(assets, { recursive: true });
  for (const name of release.webPath ? await readdir(join(release.root, release.webPath, 'assets')) : []) {
    if (name === 'fonts') continue;
    if (!/^[\w.-]+-[\w-]{8,}\.[\w.]+$/.test(name)) throw Error('Expected content-addressed Web asset');
    const source = join(release.root, release.webPath, 'assets', name), target = join(assets, name);
    if (!(await lstat(source)).isFile()) throw Error('Invalid hashed asset');
    const staging = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, staging, 1);
      if (await hashFile(source) !== await hashFile(staging)) throw Error('Incomplete asset copy');
      await rename(staging, target);
    } finally { await rm(staging, { force: true }); }
  }
  const temporary = join(selectionRoot, `current.${process.pid}`);
  await symlink(release.root, temporary);
  await rename(temporary, join(selectionRoot, 'current'));
  const { NODE_PATH: _nodePath, NODE_OPTIONS: _nodeOptions, ...environment } = process.env;
  const child = spawn(process.execPath, release.argv, {
    cwd: join(release.root, release.cwd),
    env: { ...environment, ...release.environment,
      ...(release.webEnvironment ? { [release.webEnvironment]: join(release.root, release.webPath) } : {}),
      ...(release.assetEnvironment ? { [release.assetEnvironment]: assets } : {}),
      SERVICE_DELIVERY_SHA: release.sha, SERVICE_DELIVERY_ARTIFACT: release.artifactSha256,
      SERVICE_DELIVERY_REQUEST: release.requestId, SERVICE_DELIVERY_INSTANCE: release.instanceId,
      NODE_COMPILE_CACHE: join(selectionRoot, 'runtime-cache') }, stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error.message); process.exitCode = 78; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(`Safe launch blocked: ${error.message}`);
  process.exitCode = 78;
}
