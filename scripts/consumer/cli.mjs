#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { downloadVerifiedArchive, readReleaseEnvelope } from './release-transport.mjs';
import { hashFile } from './artifact.mjs';
import { validateChannel, verifyConsumerFloor } from './channel.mjs';
import { checkFreshDirectory, freshDirectory, hostChecks, identifier, loadAuthority, nativeHome, operationPath, overlaps,
  processIdentity, processStillExists, readJson, rejectPrivateAuthority, saveOperation, writeJson } from './state.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const configPath = authority => join(authority.userRoot, 'consumer-config.json');

export function initialize({ root, userRoot = join(homedir(), '.cockpit'), channel, port = 8771 }) {
  hostChecks();
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Explicit unprivileged loopback port required');
  if (overlaps(root, userRoot) || overlaps(root, nativeHome()) || overlaps(userRoot, nativeHome())) {
    throw new Error('Installation, user and native roots must be separate');
  }
  validateChannel(channel);
  checkFreshDirectory(root);
  checkFreshDirectory(userRoot);
  if (Buffer.byteLength(join(root, 'control.sock')) > 100) {
    throw new Error('Installation root is too long for the private Unix control socket');
  }
  freshDirectory(root);
  freshDirectory(userRoot);
  const installationId = randomUUID();
  for (const directory of ['launcher', 'releases', 'downloads', 'checks', 'operations', 'staging', 'assets']) {
    mkdirSync(join(root, directory), { mode: 0o700 });
  }
  mkdirSync(join(userRoot, 'logs'), { mode: 0o700 });
  for (const name of readdirSync(source).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))) {
    copyFileSync(join(source, name), join(root, 'launcher', name));
  }
  const stable = existsSync(join(source, 'extract.py'));
  copyFileSync(stable ? join(source, 'release-transport.mjs') : join(source, '../../packages/core/src/consumer/release-transport.mjs'),
    join(root, 'launcher/release-transport.mjs'));
  copyFileSync(stable ? join(source, 'artifact.mjs') : join(source, '../../.delivery/toolkit/lib/artifact.mjs'),
    join(root, 'launcher/artifact.mjs'));
  copyFileSync(stable ? join(source, 'extract.py') : join(source, '../../.delivery/toolkit/bin/extract.py'),
    join(root, 'launcher/extract.py'));
  const authority = { schemaVersion: 2, authority: 'consumer', installationId, root, userRoot,
    nativeHome: nativeHome(), port, createdAt: new Date().toISOString() };
  writeJson(configPath(authority), { channel }, true);
  writeJson(join(userRoot, '.consumer-installation.json'), { installationId, root }, true);
  writeJson(join(root, 'authority.json'), authority, true);
  return authority;
}

export async function check(root, checkId, fetchImpl = fetch) {
  const authority = loadAuthority(root);
  const path = join(root, 'checks', `${identifier(checkId)}.json`);
  if (existsSync(path)) return readJson(path);
  // Reserve the identity before I/O. A failed/unknown check is inspected, not silently replayed.
  writeJson(path, { checkId, state: 'checking' }, true);
  const { channel } = readJson(configPath(authority));
  const floorPath = join(root, 'sequence.json');
  const lock = join(root, 'channel.lock');
  let locked = false;
  try {
    mkdirSync(lock, { mode: 0o700 });
    locked = true;
    writeJson(join(lock, 'owner.json'), processIdentity(process.pid), true);
    const floor = existsSync(floorPath) ? readJson(floorPath) : { sequence: 0 };
    const envelope = await readReleaseEnvelope(channel, fetchImpl);
    const { metadata, digest } = verifyConsumerFloor(envelope, channel, floor, true);
    const result = { checkId, state: 'checked', envelope, metadata };
    writeJson(floorPath, { sequence: metadata.sequence, digest });
    writeJson(path, result);
    return result;
  } catch (error) {
    writeJson(path, { checkId, state: 'failed', error: error.message });
    throw error;
  } finally {
    if (locked) { rmSync(join(lock, 'owner.json'), { force: true }); rmdirSync(lock); }
  }
}

export async function reconcileDownload(root, operationId) {
  const authority = loadAuthority(root);
  const operation = readJson(operationPath(root, operationId));
  if (operation.kind !== 'download') throw new Error('Original operation is not a download');
  if (operation.state === 'downloading' && (!operation.writer || processStillExists(operation.writer))) {
    throw new Error('Original downloader may still be alive; cannot reconcile concurrently');
  }
  const { channel } = readJson(configPath(authority));
  const { metadata } = verifyConsumerFloor(operation.envelope, channel, readJson(join(root, 'sequence.json')));
  if (!metadata.targets.some(target => JSON.stringify(target) === JSON.stringify(operation.target))) {
    throw new Error('Download receipt no longer matches signed target');
  }
  const archive = join(root, 'downloads', `${identifier(operationId)}.zip`);
  const { lstat } = await import('node:fs/promises');
  const stat = await lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== operation.target.bytes
    || await hashFile(archive) !== operation.target.sha256) throw new Error('No complete matching archive; no network replay performed');
  operation.state = 'downloaded';
  delete operation.error;
  return saveOperation(root, operation);
}

export async function download(root, operationId, checkId, version, fetchImpl = fetch) {
  const authority = loadAuthority(root);
  const path = operationPath(root, operationId);
  if (existsSync(path)) {
    const prior = readJson(path);
    if (prior.kind !== 'download' || prior.checkId !== checkId || prior.version !== version) throw new Error('Operation identity conflict');
    return prior;
  }
  const checked = readJson(join(root, 'checks', `${identifier(checkId)}.json`));
  if (checked.state !== 'checked') throw new Error('Check is not verified');
  const { channel } = readJson(configPath(authority));
  const { metadata } = verifyConsumerFloor(checked.envelope, channel, readJson(join(root, 'sequence.json')));
  const target = metadata.targets.find(item => item.version === version);
  if (!target) throw new Error('Requested version was not in the verified check');
  const operation = saveOperation(root, { kind: 'download', operationId, checkId, version, target,
    envelope: checked.envelope, state: 'downloading', writer: processIdentity(process.pid) }, true);
  try {
    await downloadVerifiedArchive(target, channel, join(root, 'downloads', `${operationId}.zip`), fetchImpl);
    verifyConsumerFloor(operation.envelope, channel, readJson(join(root, 'sequence.json')));
    operation.state = 'downloaded';
  } catch (error) { operation.state = 'failed'; operation.error = error.message; }
  return saveOperation(root, operation);
}

export function callLauncher(root, body) {
  const authority = loadAuthority(root);
  if (body.installationId !== undefined && body.installationId !== authority.installationId) {
    throw new Error('Consumer control installation identity mismatch');
  }
  return new Promise((resolveResult, reject) => {
    const req = request({ socketPath: join(root, 'control.sock'), path: '/', method: 'POST',
      headers: { 'content-type': 'application/json' }, timeout: 10_000 }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1_000_000) response.destroy(new Error('Launcher response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (response.statusCode !== 200) reject(new Error(value.error ?? 'Launcher rejected operation'));
          else resolveResult(value);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Launcher acknowledgement unknown; inspect original operation ID, do not retry')));
    req.on('error', reject);
    req.end(JSON.stringify({ ...body, installationId: authority.installationId }));
  });
}

export function consumerRootFromEnvironment(env = process.env) {
  rejectPrivateAuthority(env);
  const root = env.COCKPIT_CONSUMER_ROOT, installationId = env.COCKPIT_CONSUMER_INSTALLATION;
  if (typeof root !== 'string' || !/^[a-f0-9-]{36}$/.test(installationId ?? '')) {
    throw new Error('Consumer runtime requires an explicit launcher root and installation identity');
  }
  const authority = loadAuthority(root);
  if (authority.installationId !== installationId || authority.userRoot !== env.COCKPIT_USER_ROOT) {
    throw new Error('Consumer runtime root does not match its installation/user-root identity');
  }
  return root;
}

/** Host APIs supply only a stable operation ID; never expose an arbitrary installation root to clients. */
export async function restartConsumer(operationId, env = process.env) {
  identifier(operationId);
  const root = consumerRootFromEnvironment(env);
  const receipt = await callLauncher(root, { action: 'restart', operationId });
  if (receipt?.kind !== 'restart' || receipt.operationId !== operationId) {
    throw new Error('Unexpected restart acknowledgement; inspect original operation without retry');
  }
  return receipt;
}

/** The callback only arms the existing native idle gate; it must not await shutdown. */
export async function connectConsumerLifecycle(requestNativeDrain, env = process.env) {
  consumerRootFromEnvironment(env);
  const instanceId = env.COCKPIT_CONSUMER_INSTANCE, installationId = env.COCKPIT_CONSUMER_INSTALLATION;
  if (typeof requestNativeDrain !== 'function' || !/^[a-f0-9-]{36}$/.test(instanceId ?? '')
    || !process.send || !process.connected) throw new Error('Consumer main requires its owned launcher IPC lifecycle channel');
  let operation, result;
  const send = value => new Promise((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error('Consumer launcher IPC disconnected; native drain outcome is unconfirmed'));
    process.send(value, error => error ? reject(error) : resolve());
  });
  const onMessage = message => {
    if (message?.type !== 'consumer-native-drain') return;
    void (async () => {
      identifier(message.operationId);
      if (message.installationId !== installationId || message.instanceId !== instanceId
        || Object.keys(message).some(key => !['type', 'operationId', 'installationId', 'instanceId'].includes(key))) {
        throw new Error('Consumer native drain identity/request mismatch');
      }
      const base = { type: 'consumer-native-drain-result', operationId: message.operationId, installationId, instanceId, pid: process.pid };
      if (operation) {
        if (operation === message.operationId && result) await send(result);
        else await send({ ...base, state: 'unknown', error: 'Native drain already requested; inspect the original operation without replay' });
        return;
      }
      operation = message.operationId;
      try {
        await requestNativeDrain(operation);
        result = { ...base, state: 'accepted' };
      } catch (error) { result = { ...base, state: 'unknown',
        error: error instanceof Error ? error.message : 'Native drain callback effect is unconfirmed' }; }
      await send(result);
    })().catch(error => console.error(`Consumer native lifecycle remains unconfirmed: ${error.message}`));
  };
  process.on('message', onMessage);
  try { await send({ type: 'consumer-main-ready', apiVersion: 1, installationId, instanceId, pid: process.pid }); }
  catch (error) { process.off('message', onMessage); throw error; }
  return () => process.off('message', onMessage);
}

export function unlock(root) {
  loadAuthority(root);
  const lock = join(root, 'launcher.lock');
  const owner = readJson(join(lock, 'owner.json'));
  if (processStillExists(owner)) throw new Error('Launcher is still alive; cannot replace its authority');
  const runtime = existsSync(join(root, 'runtime.json')) ? readJson(join(root, 'runtime.json')) : null;
  if (runtime && runtime.state !== 'exited') {
    if (!runtime.process) throw new Error('Child spawn outcome unknown; operator investigation required, not automatic unlock');
    if (processStillExists(runtime.process)) throw new Error('Prior backend is still alive; cannot adopt or replace it');
    writeJson(join(root, 'runtime.json'), { ...runtime, state: 'exited', observedAbsent: true });
  }

  rmSync(join(root, 'control.sock'), { force: true });
  rmSync(join(lock, 'owner.json'));
  rmdirSync(lock);
  return { unlocked: true, note: 'No child adopted or restarted; inspect/recover original operation explicitly' };
}

export function unlockChannel(root) {
  loadAuthority(root);
  const lock = join(root, 'channel.lock');
  if (processStillExists(readJson(join(lock, 'owner.json')))) throw new Error('Channel check is still alive');
  rmSync(join(lock, 'owner.json'));
  rmdirSync(lock);
  return { unlocked: true, note: 'Original checks remain retained; no transport request replayed' };
}

async function main() {
  const [command, ...values] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!/^--[a-z-]+$/.test(values[i]) || values[i + 1] === undefined) throw new Error('Expected --option value pairs');
    if (values[i] in options) throw new Error('Duplicate option');
    options[values[i]] = values[i + 1];
  }
  const root = resolve(options['--root'] ?? join(homedir(), '.local/share/cockpit-consumer'));
  const allowed = {
    init: ['--root', '--user-root', '--channel', '--port'], check: ['--root', '--id'],
    download: ['--root', '--id', '--check', '--version'], serve: ['--root'],
    install: ['--root', '--id', '--download'], start: ['--root', '--id'], stop: ['--root', '--id'],
    restart: ['--root', '--id'],
    recover: ['--root', '--id', '--action'], status: ['--root', '--id'], unlock: ['--root'],
    'reconcile-download': ['--root', '--id'], 'unlock-channel': ['--root'],
  };
  if (!allowed[command] || Object.keys(options).some(option => !allowed[command].includes(option))) throw new Error('Unknown command or option; see docs/consumer-installation.md');
  let result;
  switch (command) {
    case 'init': result = initialize({ root, userRoot: resolve(options['--user-root'] ?? join(homedir(), '.cockpit')),
      channel: readJson(resolve(options['--channel'] ?? '')), port: Number(options['--port'] ?? 8771) }); break;
    case 'check': result = await check(root, options['--id']); break;
    case 'download': result = await download(root, options['--id'], options['--check'], options['--version']); break;
    case 'reconcile-download': result = await reconcileDownload(root, options['--id']); break;
    case 'serve': {
      const { serve } = await import('./launcher.mjs');
      await serve(root);
      return;
    }
    case 'install': result = await callLauncher(root, { action: 'install', operationId: options['--id'], downloadId: options['--download'] }); break;
    case 'start': result = await callLauncher(root, { action: 'start', operationId: options['--id'] }); break;
    case 'stop': result = await callLauncher(root, { action: 'stop', operationId: options['--id'] }); break;
    case 'restart': result = await callLauncher(root, { action: 'restart', operationId: options['--id'] }); break;
    case 'recover': result = await callLauncher(root, { action: 'recover', operationId: options['--id'], recovery: options['--action'] }); break;
    case 'status': result = options['--id'] ? readJson(operationPath(root, options['--id'])) : await callLauncher(root, { action: 'status' }); break;
    case 'unlock': result = unlock(root); break;
    case 'unlock-channel': result = unlockChannel(root); break;
    default: throw new Error('Commands: init, check, download, serve, install, start, stop, restart, recover, status, unlock; see docs/consumer-installation.md');
  }
  console.log(JSON.stringify(result, null, 2));
  if (['check', 'download', 'install', 'start', 'restart'].includes(command)
    && ['failed', 'unknown'].includes(result?.state)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
