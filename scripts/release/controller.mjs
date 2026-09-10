import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { hashFile, readState, selectCandidate, validateBuild, verifyRelease, writeState } from './model.mjs';

const self = fileURLToPath(import.meta.url);
const config = JSON.parse(await readFile(process.env.COCKPIT_DEPLOY_CONFIG ?? '/etc/cockpit-release.json', 'utf8'));
if (!/^[\w-]+\/[\w.-]+$/.test(config.repository) || !config.root?.startsWith('/')
  || !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.url)
  || !/^[a-zA-Z0-9_-]+\.service$/.test(config.service)) throw new Error('Invalid deployment configuration');
const statePath = join(config.root, 'state.json');
const releases = join(config.root, 'releases');
const api = path => JSON.parse(execFileSync('gh', ['api', `repos/${config.repository}/${path}`],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }));
const isAncestor = async (before, after) => {
  if (before === after) return true;
  const comparison = api(`compare/${before}...${after}`);
  return comparison.status === 'ahead' && comparison.merge_base_commit?.sha === before;
};
const locked = (operation, value = {}) => JSON.parse(execFileSync('flock',
  ['-x', join(config.root, 'state.lock'), process.execPath, self, 'locked', operation],
  { input: JSON.stringify(value), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: process.env, timeout: 120_000 }));

async function body(stream) {
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    if (text.length > 1024 * 1024) throw new Error('Input exceeds limit');
  }
  return JSON.parse(text);
}

async function request(path, data) {
  const response = await fetch(`${config.url}${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Backend ${path}: HTTP ${response.status}`);
  return response.json();
}

async function transaction(operation, value) {
  const state = await readState(statePath);
  let next = state;
  if (operation === 'submit') {
    next = await selectCandidate(state, value, isAncestor);
  } else if (operation === 'choose') {
    const candidate = state.desired ?? state.lastHealthy ?? state.active;
    if (!candidate) throw new Error('No accepted release is available');
    if (state.failed?.id === candidate.id) {
      const previous = state.lastHealthy ?? state.active;
      if (!candidate.rollbackSafe || !previous) return { blocked: true, candidate };
      await writeState(statePath, { ...state, active: undefined, activating: previous, phase: 'rolling-back' });
      return { candidate: previous, rollback: true, failed: state.failed };
    }
    next = { ...state, lastHealthy: state.active ?? state.lastHealthy, active: undefined,
      activating: candidate, phase: 'activating' };
  } else if (operation === 'healthy') {
    if (state.activating?.id !== value.id) throw new Error('Unexpected active release identity');
    next = { ...state, active: state.activating, lastHealthy: state.activating, activating: undefined, failed: undefined,
      phase: state.desired?.id === value.id ? 'healthy' : 'pending-idle' };
  } else if (operation === 'failed') {
    next = { ...state, failed: value, activating: undefined, phase: 'failed' };
  } else if (operation === 'rolled-back') {
    if (state.activating?.id !== value.id) throw new Error('Unexpected rollback identity');
    next = { ...state, active: value, lastHealthy: value, activating: undefined, phase: 'rolled-back' };
  } else if (operation === 'notify') {
    if ((state.notified ?? []).includes(value.key)) return { send: false };
    next = { ...state, notified: [...(state.notified ?? []), value.key] };
  } else if (operation === 'status') {
    return state;
  } else {
    throw new Error('Unknown deployment transaction');
  }
  await writeState(statePath, next);
  if (operation === 'choose') return { candidate: next.activating };
  if (operation === 'notify') return { send: true };
  return next;
}

async function retainAssets(root) {
  const source = join(root, 'apps/web/dist/assets');
  const target = join(config.root, 'assets');
  await mkdir(target, { recursive: true });
  // Only generated, content-addressed assets; entry HTML/SW stay with their release.
  for (const name of await readdir(source)) {
    if (!/^[\w.-]+-[\w-]{8,}\.[\w.]+$/.test(name)) throw new Error('Unexpected non-hashed asset');
    const path = join(source, name);
    if (!(await lstat(path)).isFile()) throw new Error('Unsupported asset entry');
    try { await copyFile(path, join(target, name), 1); }
    catch (error) {
      if (error.code !== 'EEXIST' || await hashFile(path) !== await hashFile(join(target, name))) throw error;
    }
  }
}

async function makeReadonly(root) {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) await makeReadonly(path);
    else if (stat.isFile()) await chmod(path, 0o444 | (stat.mode & 0o111));
  }
  await chmod(root, 0o555);
}

async function receive() {
  const match = /^receive ([1-9][0-9]*) ([1-9][0-9]*)$/.exec(process.env.SSH_ORIGINAL_COMMAND ?? process.argv.slice(3).join(' '));
  if (!match) throw new Error('Only receive RUN_ID ARTIFACT_ID is supported');
  const run = api(`actions/runs/${match[1]}`);
  const artifact = api(`actions/artifacts/${match[2]}`);
  const identity = validateBuild(run, artifact, config);
  if (!await isAncestor(identity.commit, api('branches/main').commit.sha)) throw new Error('Candidate is no longer on main');
  await mkdir(join(config.root, 'incoming'), { recursive: true, mode: 0o700 });
  await mkdir(releases, { recursive: true });
  const incoming = await mkdtemp(join(config.root, 'incoming', 'receive-'));
  try {
    const zip = join(incoming, 'artifact.zip');
    let size = 0;
    await pipeline(process.stdin, new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > 400 * 1024 * 1024 ? new Error('Artifact too large') : null, chunk);
      },
    }), createWriteStream(zip, { flags: 'wx', mode: 0o600 }));
    if (size !== artifact.size_in_bytes || await hashFile(zip) !== identity.digest) throw new Error('Artifact digest/size mismatch');
    const stage = join(incoming, 'release');
    await mkdir(stage);
    execFileSync('python3', [join(dirname(self), 'extract.py'), zip, stage], { timeout: 120_000, stdio: 'inherit' });
    const manifest = await verifyRelease(stage, identity.commit);
    const candidate = { ...identity, rollbackSafe: manifest.rollbackSafe, owners: manifest.owners };
    await retainAssets(stage);
    const destination = join(releases, identity.id);
    try { await rename(stage, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await verifyRelease(destination, identity.commit);
    }
    await makeReadonly(destination);
    const state = locked('submit', candidate);
    if (state.active?.id === candidate.id) {
      console.log(JSON.stringify({ phase: 'healthy', candidate: candidate.id }));
      return;
    }
    // Acceptance is persistent even if transport to the backend subsequently fails.
    let response;
    try { response = await request('/admin/restart', { pending: true }); }
    catch (error) {
      // "start" is idempotent on an active unit, never stops its existing work.
      // This also recovers a forward fix after RestartPreventExitStatus=78.
      execFileSync('sudo', ['-n', '/usr/bin/systemctl', '--no-block', 'start', config.service],
        { timeout: 15_000, stdio: 'inherit' });
      console.error(`Restart request unconfirmed; supervisor start requested: ${error.message}`);
      console.log(JSON.stringify({ phase: 'pending-start', candidate: candidate.id }));
      return;
    }
    if (!response.restartPending) throw new Error('Release accepted but restart was not armed');
    console.log(JSON.stringify({ phase: state.phase, candidate: candidate.id, busy: response.busy }));
  } finally {
    await rm(incoming, { recursive: true, force: true });
  }
}

async function notify(candidate, phase, active = candidate) {
  const owners = new Map();
  for (const owner of candidate.owners ?? []) {
    if (!owners.has(owner.sessionId)) owners.set(owner.sessionId, owner);
  }
  for (const owner of owners.values()) {
    const key = `${phase}:${owner.sessionId}:${owner.commit}`;
    if (!locked('notify', { key }).send) continue;
    // Mark before sending: uncertain prompt delivery is never automatically replayed.
    try {
      await request('/intent/prompt', {
        sessionId: owner.sessionId, mode: 'enqueue',
        text: `Deployment event: ${phase}; requested candidate ${candidate.id}; active candidate ${active.id}. `
          + (phase === 'healthy' ? `Your integrated commit ${owner.commit} is included. `
            : `Your commit ${owner.commit} failed deployment and is not claimed to be active. `)
          + 'Read the authoritative release status and complete '
          + 'your original task acceptance; this event is not a claim that your task is complete. Do not start a new owner.',
      });
    } catch (error) {
      console.error(`Owner notification delivery unconfirmed (${owner.sessionId}): ${error.message}`);
    }
  }
}

async function launch() {
  const selected = locked('choose');
  if (selected.blocked) {
    console.error('Deployment failed with a non-reversible data policy; automatic rollback is blocked.');
    process.exitCode = 78;
    return;
  }
  const candidate = selected.candidate;
  const root = join(releases, candidate.id);
  try { await verifyRelease(root, candidate.commit); }
  catch (error) {
    locked('failed', candidate);
    console.error(`Release rejected before launch: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const next = join(config.root, `current.${process.pid}`);
  await symlink(root, next);
  await rename(next, join(config.root, 'current'));
  const env = { ...process.env, COCKPIT_SERVE_WEB: '1',
    COCKPIT_WEB_DIR: join(root, 'apps/web/dist'), COCKPIT_ASSET_DIR: join(config.root, 'assets'),
    COCKPIT_RELEASE_SHA: candidate.commit, COCKPIT_RELEASE_ID: candidate.id,
    NODE_COMPILE_CACHE: join(config.root, 'runtime-cache') };
  delete env.NODE_PATH;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'],
    { cwd: join(root, 'apps/server'), env, stdio: 'inherit' });
  let exited = false;
  let healthy = false;
  const done = new Promise(resolve => {
    child.once('error', error => { console.error(error); resolve({ code: 1 }); });
    child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  for (let attempt = 0; attempt < 60 && !exited; attempt++) {
    await sleep(1000);
    try {
      const health = await request('/health');
      if (health.ok && health.release?.id === candidate.id && health.release?.commit === candidate.commit) {
        healthy = true;
        if (!selected.rollback) locked('healthy', candidate);
        else locked('rolled-back', candidate);
        await notify(selected.rollback ? selected.failed : candidate,
          selected.rollback ? 'rolled-back' : 'healthy', candidate);
        break;
      }
    } catch (error) {
      if (attempt === 59) console.error(`Readiness not confirmed: ${error.message}`);
    }
  }
  if (!healthy && !exited) {
    console.error('Readiness timed out; leaving the process intact rather than killing potentially active sessions.');
  }
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling || exited || !healthy) return;
    reconciling = true;
    try {
      const state = locked('status');
      if (state.desired?.id !== candidate.id && state.desired?.id !== state.failed?.id) {
        const status = await request('/status');
        if (!status.restartPending) await request('/admin/restart', { pending: true });
      }
    } catch (error) {
      console.error(`Desired release reconciliation deferred: ${error.message}`);
    } finally { reconciling = false; }
  };
  await reconcile();
  const reconciliation = setInterval(() => { void reconcile(); }, 30_000);
  const result = await done;
  clearInterval(reconciliation);
  if (!healthy) locked('failed', candidate);
  process.exitCode = result.code ?? 1;
}

try {
  if (process.argv[2] === 'locked') console.log(JSON.stringify(await transaction(process.argv[3], await body(process.stdin))));
  else if (process.argv[2] === 'receive') await receive();
  else if (process.argv[2] === 'launch') await launch();
  else if (process.argv[2] === 'status') console.log(JSON.stringify(locked('status'), null, 2));
  else throw new Error('Expected receive, launch or status');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
