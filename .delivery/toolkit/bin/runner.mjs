#!/usr/bin/env node
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, chmod, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DeliveryStore, digest, fault, terminal } from '../lib/delivery-store.mjs';
import { validateRequest, validateShape } from '../lib/contracts.mjs';
import { hashFile, verifyArtifact } from '../lib/artifact.mjs';
import { observeRuntime } from '../lib/runtime.mjs';
import { readActors } from '../lib/actors.mjs';
import { validatePolicy } from '../lib/policy.mjs';
import { projectStatus, readRuntime } from '../lib/status.mjs';

const exec = promisify(execFile);
const config = validatePolicy(JSON.parse(await readFile(process.argv[2], 'utf8')));
await mkdir(config.root, { recursive: true, mode: 0o700 });
const store = new DeliveryStore(join(config.root, 'delivery.sqlite'));
let closing = false, serverClosed = false;
function finishClose() {
  if (closing && serverClosed && !working) { store.close(); process.exit(0); }
}
const command = async (name, args, options = {}) => (await exec(name, args, { encoding: 'utf8',
  timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout.trim();
const gh = async (project, path) => JSON.parse(await command('gh', ['api', `repos/${project.repository}/${path}`]));
const git = async (project, ...args) => command('git', ['-C', project.repo, ...args]);
const policy = id => {
  const p = config.projects[id];
  if (!p) throw fault('PROJECT_UNKNOWN', 'Repository is not allowlisted', 403);
  return p;
};
const key = row => `${row.request.repo.id}:${row.request.environment}`;
const matchesRun = (run, row, p) => run.path === p.workflowPath && run.event === 'workflow_dispatch'
  && run.head_branch === p.targetRef.slice(11)
  && run.display_title === `delivery:${row.request.requestId}:${row.request.repo.sha}`;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function payload(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 256_000) throw fault('INPUT_SIZE', 'Request too large', 413);
  }
  return text ? JSON.parse(text) : {};
}
async function backend(project, path, data) {
  const r = await fetch(`${project.url}${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw Error(`Backend ${path}: HTTP ${r.status}`);
  return r.json();
}
async function verifySource(request) {
  validateRequest(request);
  const p = policy(request.repo.id);
  if (request.repo.targetRef !== p.targetRef || request.environment !== p.environment
    || request.projectConfig.path !== p.configPath) throw fault('POLICY_MISMATCH', 'Target/config/environment is not allowlisted', 403);
  const remote = await gh(p, `git/ref/heads/${p.targetRef.slice('refs/heads/'.length)}`);
  // Advancing target is valid, replacing the observed integration history is not.
  await git(p, 'merge-base', '--is-ancestor', request.repo.sha, request.repo.observedTargetSha);
  await git(p, 'merge-base', '--is-ancestor', request.repo.observedTargetSha, remote.object.sha);
  const entry = await git(p, 'ls-tree', request.repo.sha, '--', p.configPath);
  if (!entry.startsWith('100644 blob ')) throw fault('CONFIG_TYPE', 'Config is not a committed regular file');
  const { stdout } = await exec('git', ['-C', p.repo, 'show', `${request.repo.sha}:${p.configPath}`],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  if (digest(stdout) !== request.projectConfig.sha256 || !p.configHashes.includes(request.projectConfig.sha256)) {
    throw fault('CONFIG_MISMATCH', 'Config bytes or administrator allowlist do not match', 403);
  }
  const project = validateShape('project', JSON.parse(stdout));
  if (project.projectId !== request.repo.id || project.targetRef !== request.repo.targetRef
    || project.delivery.environment !== request.environment || project.delivery.adapter !== 'github-actions-v1') throw fault('CONFIG_BINDING', 'Committed adapter binding mismatch');
  if (request.intent === 'deploy') {
    const previous = store.setting(`watermark:${key({ request })}`);
    if (previous && previous !== request.repo.sha) await git(p, 'merge-base', '--is-ancestor', previous, request.repo.sha);
  }
  return project;
}
async function observe(row, expected = { sha: row.request.repo.sha, artifactSha256: row.result.artifact?.sha256,
  requestId: row.request.requestId, instanceId: row.instanceId }) {
  return observeRuntime(policy(row.request.repo.id), expected);
}
async function notify(row, actors) {
  if (row.notificationAttempted || row.notificationDisposition) return;
  const actor = actors.find(actor => actor.id === row.actor);
  if (!actor?.sessionId) {
    row.notificationDisposition = 'no-callback';
    store.save(row);
    return;
  }
  row.notificationAttempted = true;
  store.save(row);
  try {
    const project = policy(row.request.repo.id);
    await backend({ ...project, url: config.notificationUrl ?? project.url }, '/intent/prompt', {
      sessionId: actor.sessionId, mode: 'enqueue',
      text: `Service delivery event for requestId=${row.request.requestId}: state=${row.result.state}. `
        + `Read the authenticated service-delivery lookup for the original request; source=${row.request.repo.sha}. `
        + 'This is infrastructure evidence, not business acceptance or Commander delivery. Continue the same owner; do not replay submit.',
    });
  } catch (error) { console.error(`Notification outcome unknown for ${row.request.requestId}: ${error.message}`); }
}
async function readonly(root) {
  for (const name of await readdir(root)) {
    const path = join(root, name), stat = await lstat(path);
    if (stat.isDirectory()) await readonly(path);
    else if (stat.isFile()) await chmod(path, 0o444 | (stat.mode & 0o111));
  }
  await chmod(root, 0o555);
}
async function discardIncoming(directory) {
  async function writable(path) {
    if (!(await lstat(path)).isDirectory()) return;
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await writable(join(path, name));
  }
  try { await writable(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(directory, { recursive: true, force: true });
}
async function importArtifact(input) {
  if (!/^[\w.-]{8,120}$/.test(input.requestId) || !/^[1-9]\d*$/.test(String(input.runId))
    || !/^[1-9]\d*$/.test(String(input.artifactId)) || !/^[a-f0-9]{32}$/.test(input.uploadId)) throw fault('BAD_RECEIPT', 'Invalid artifact receipt');
  const row = store.get(input.requestId);
  if (row?.result.artifact) {
    if (row.runId !== Number(input.runId) || row.artifactId !== Number(input.artifactId)) {
      throw fault('RECEIPT_CONFLICT', 'Different artifact identity is already recorded');
    }
    await discardIncoming(join(config.root, 'incoming', input.uploadId));
    return row.result;
  }
  if (!row || !['building', 'unknown'].includes(row.result.state)) throw fault('RECEIPT_STATE', 'Request does not accept a build receipt');
  if (row.result.state === 'unknown' && row.result.failure.stage !== 'dispatch') throw fault('RECOVERY_REQUIRED', 'Explicit reconciliation required');
  const p = policy(row.request.repo.id);
  if (row.buildReconcileDeadline !== undefined && row.buildReconcileDeadline <= Date.now()) {
    throw fault('RECOVERY_EXPIRED', 'Original-run reconciliation window expired');
  }
  const run = await gh(p, `actions/runs/${input.runId}`);
  const artifact = await gh(p, `actions/artifacts/${input.artifactId}`);
  if (run.repository.full_name !== p.repository || !matchesRun(run, row, p)
    || (row.runId && row.runId !== run.id)
    || run.status !== 'completed' || run.conclusion !== 'success'
    || artifact.workflow_run.id !== run.id || artifact.name !== `runtime-${input.requestId}`
    || artifact.expired || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) throw fault('UNTRUSTED_BUILD', 'Not the successful bound CI artifact', 403);
  const directory = join(config.root, 'incoming', input.uploadId), zip = join(directory, 'artifact.zip');
  if ((await lstat(zip)).size !== artifact.size_in_bytes || await hashFile(zip) !== artifact.digest.slice(7)) throw fault('ZIP_DIGEST', 'GitHub artifact digest mismatch');
  const work = await mkdtemp(join(directory, 'verification-')), stage = join(work, 'runtime');
  await mkdir(stage);
  await command('python3', [new URL('./extract.py', import.meta.url).pathname, zip, stage]);
  await verifyArtifact(stage, { sourceSha: row.request.repo.sha, configSha256: row.request.projectConfig.sha256,
    requestId: input.requestId, buildRunId: String(run.id) });
  const sha256 = await hashFile(join(work, 'runtime.tar.gz'));
  const root = join(config.root, 'releases', sha256);
  await mkdir(join(config.root, 'releases'), { recursive: true });
  await readonly(stage);
  await chmod(stage, 0o755);
  try { await rename(stage, root); }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    await verifyArtifact(root, { sourceSha: row.request.repo.sha, configSha256: row.request.projectConfig.sha256,
      requestId: input.requestId, buildRunId: String(run.id) });
  }
  await readonly(root);
  const fresh = store.get(input.requestId);
  if (fresh.result.state !== 'building'
    && !(fresh.result.state === 'unknown' && fresh.result.failure.stage === 'dispatch')) {
    throw fault('RECEIPT_RACE', 'Request changed during artifact verification; reconcile original identity');
  }
  if ((fresh.runId && fresh.runId !== run.id)
    || (fresh.buildReconcileDeadline !== undefined && fresh.buildReconcileDeadline <= Date.now())) {
    throw fault('RECEIPT_RACE', 'Original-run binding or reconciliation window changed during verification');
  }
  fresh.result.artifact = { id: sha256, sha256, sourceSha: fresh.request.repo.sha,
    configSha256: fresh.request.projectConfig.sha256, buildRunId: String(run.id) };
  fresh.result.state = 'built'; fresh.result.failure = null; fresh.result.recovery = null;
  fresh.runId = run.id; fresh.artifactId = Number(input.artifactId); fresh.releaseRoot = root;
  store.save(fresh);
  await discardIncoming(directory);
  return fresh.result;
}

const server = createServer(async (req, res) => {
  try {
    if (closing) throw fault('DRAINING', 'Delivery controller is draining; request was not admitted', 503);
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const actor = (await readActors(config)).find(actor => equal(actor.token, token));
    if (!actor) throw fault('UNAUTHORIZED', 'Authentication required', 401);
    const body = req.method === 'POST' ? await payload(req) : {};
    let value;
    if (req.method === 'GET' && req.url === '/status') {
      if (!['viewer', 'admin'].includes(actor.role)) throw fault('FORBIDDEN', 'Read-only status role required', 403);
      const projects = [];
      for (const [id, p] of Object.entries(config.projects)) projects.push(await projectStatus(store, id, p, readRuntime));
      value = { projects };
    } else if (req.method === 'GET' && req.url.startsWith('/requests/')) {
      const id = decodeURIComponent(req.url.slice('/requests/'.length)), row = store.get(id);
      if (!row) throw fault('NOT_FOUND', 'No authoritative request record; uncertain submit is not proved unapplied', 404);
      if (row.actor !== actor.id && actor.role !== 'admin') throw fault('FORBIDDEN', 'Request belongs to another actor', 403);
      value = { request: row.request, result: row.result };
    } else if (req.method === 'POST' && req.url === '/submit') {
      if (!['submit', 'admin'].includes(actor.role)) throw fault('FORBIDDEN', 'Submission not permitted', 403);
      const prior = store.existing(body, actor.id);
      const row = prior ?? store.accept(body, actor.id, await verifySource(body));
      value = { submitted: true, request: row.request, result: row.result };
    } else if (req.method === 'POST' && req.url === '/authorize' && actor.role === 'admin') {
      policy(body.repoId);
      const probe = { schemaVersion: 1, requestId: 'approval-probe', repo: { id: body.repoId, sha: body.sha,
        targetRef: 'refs/heads/main', observedTargetSha: body.sha }, projectConfig: { path: 'config.json', sha256: 'a'.repeat(64) },
      intent: 'deploy', environment: body.environment, authorization: body };
      validateRequest(probe); store.approve(body); value = body;
    } else if (req.method === 'POST' && req.url === '/revoke' && actor.role === 'admin') {
      store.revoke(body.reference); value = { revoked: true };
    } else if (req.method === 'POST' && req.url === '/artifact' && actor.role === 'receiver') {
      value = await importArtifact(body);
    } else if (req.method === 'POST' && req.url === '/boot' && actor.role === 'launcher') {
      const p = policy(body.projectId), row = store.head(body.projectId, p.environment);
      if (!/^[a-f0-9-]{36}$/.test(body.instanceId ?? '')) throw fault('BAD_INSTANCE', 'Launcher instance identity required');
      if (row) store.expireRollback(row);
      if (row?.result.state === 'verifying') {
        store.fail(row, 'activation', fault('PROCESS_EXITED', 'Candidate exited before verified health'), 'unknown');
        if (p.binaryRollbackSafe && row.previous) {
          row.rollbackRequested = true; row.rollbackDeadline = Date.now() + p.healthTimeoutMs;
          store.save(row);
        }
      }
      if (row?.rollbackRequested) {
        try {
          if (!row.previous || row.rollbackDeadline <= Date.now()) throw fault('ROLLBACK_EXPIRED', 'Recovery selection expired');
          await verifyArtifact(row.previous.root, { sourceSha: row.previous.sha });
          store.expireRollback(row);
          if (row.rollbackRequested) {
            row.rollbackRequested = false;
            row.recoveryInstance = body.instanceId; row.rollbackDeadline = Date.now() + p.healthTimeoutMs;
            row.result.recovery = { state: 'pending', reference: 'binary-only-rollback', runningSha: null };
            store.save(row);
            value = { ...row.previous, instanceId: body.instanceId, ...p.launch };
          }
        } catch (error) {
          if (row.rollbackDeadline <= Date.now()) store.expireRollback(row);
          else {
            row.result.recovery = { state: 'failed', reference: `rollback:${error.code ?? error.message}`, runningSha: null };
            store.save(row);
            throw error;
          }
        }
      }
      if (!value && row?.result.state === 'waiting-idle') {
        try {
          if (p.activationEnabled === false) throw fault('ACTIVATION_DISABLED', 'Runtime activation is explicitly paused');
          await verifySource(row.request);
          await verifyArtifact(row.releaseRoot, { sourceSha: row.request.repo.sha, configSha256: row.request.projectConfig.sha256,
            requestId: row.request.requestId, buildRunId: row.result.artifact.buildRunId });
          const active = store.activate(row.request.requestId, row.fence);
          active.instanceId = body.instanceId; active.result.state = 'verifying';
          active.previous = store.setting(`active:${body.projectId}:${p.environment}`);
          store.save(active);
          value = { root: active.releaseRoot, sha: active.request.repo.sha, artifactSha256: active.result.artifact.sha256,
            requestId: active.request.requestId, instanceId: body.instanceId, ...p.launch };
        } catch (error) {
          const current = store.get(row.request.requestId);
          if (current.result.state !== 'waiting-idle') throw error;
          store.fail(current, 'activation-gate', error);
        }
      }
      if (!value) {
        const active = store.setting(`active:${body.projectId}:${p.environment}`);
        if (!active) throw fault('NO_SAFE_RELEASE', 'No verified release is available; explicit recovery required');
        await verifyArtifact(active.root, { sourceSha: active.sha });
        value = { ...active, instanceId: body.instanceId, ...p.launch };
      }
    } else if (req.method === 'POST' && req.url === '/recover' && actor.role === 'admin') {
      const row = store.get(body.requestId);
      if (!row || !['unknown', 'failed'].includes(row.result.state)) throw fault('RECOVERY_STATE', 'No uncertain or failed request to reconcile');
      if (body.action === 'rollback') {
        const p = policy(row.request.repo.id);
        store.expireRollback(row);
        if (body.confirmBinaryOnly !== true || !p.binaryRollbackSafe || !row.previous) {
          throw fault('ROLLBACK_BLOCKED', 'Explicit binary-only confirmation, compatible data policy and previous release required');
        }
        if (row.rollbackRequested || row.result.recovery?.state === 'pending') {
          throw fault('RECOVERY_IN_PROGRESS', 'Recovery already requested; lookup without replay');
        }
        await verifyArtifact(row.previous.root, { sourceSha: row.previous.sha });
        const head = store.head(row.request.repo.id, row.request.environment);
        const selected = store.setting(`active:${key(row)}`);
        if ((head && head.request.requestId !== row.request.requestId)
          || (selected && ![row.request.requestId, row.previous.requestId].includes(selected.requestId))) {
          throw fault('RECOVERY_STALE', 'Another deployment owns the environment; old recovery cannot supersede it');
        }
        row.rollbackRequested = true; row.rollbackDeadline = Date.now() + p.busyTimeoutMs;
        delete row.recoveryInstance;
        row.result.recovery = { state: 'pending', reference: 'binary-only-rollback', runningSha: null };
        store.save(row);
        try { await backend(p, '/admin/restart', { pending: true }); }
        catch (error) { console.error(`Rollback restart acknowledgement unknown: ${error.message}`); }
        value = row.result;
      } else if (body.action && body.action !== 'reconcile') {
        throw fault('RECOVERY_ACTION', 'Unknown recovery action');
      } else if (['dispatch', 'build'].includes(row.result.failure.stage)) {
        const p = policy(row.request.repo.id);
        const runs = await gh(p, 'actions/runs?event=workflow_dispatch&per_page=100');
        const matching = runs.workflow_runs.filter(run => matchesRun(run, row, p));
        if (matching.length !== 1 || (row.runId && matching[0].id !== row.runId)) {
          throw fault('RECOVERY_UNKNOWN', 'Exactly one original authoritative run has not been established; nothing replayed');
        }
        const run = matching[0];
        if (run.status === 'completed' && run.conclusion !== 'success') {
          row.result.state = 'failed'; row.result.failure.effects = 'not-applied';
          if (row.result.recovery) row.result.recovery.state = 'not-needed';
          store.save(row);
        } else if (row.result.state === 'unknown') {
          row.result.state = 'building'; row.result.failure = null; row.result.recovery = null;
          row.runId = run.id;
          row.buildReconcileDeadline = Date.now() + p.buildTimeoutMs;
          store.save(row);
        }
        value = row.result;
      } else {
        const evidence = await observe(row);
        value = store.recordRuntime(row, evidence, { reconciled: true }).result;
      }
    } else throw fault('NOT_FOUND', 'Unknown operation or insufficient role', 404);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  } catch (error) {
    res.writeHead(error.status ?? 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ code: error.code ?? 'REQUEST_FAILED', error: error.message }));
  }
});

function* pages(read) {
  for (let after = 0; ;) {
    const page = read(after);
    if (!page.length) return;
    for (const row of page) { after = row.serial; yield row; }
  }
}
let working = false;
async function tick() {
  if (working || closing) return;
  working = true;
  try {
    let notificationActors;
    for (let row of pages(after => store.workPage(after))) {
      if (closing) break;
      try {
      const p = policy(row.request.repo.id);
      store.expireRollback(row);
      if (row.result.recovery?.state === 'pending') {
        try {
          if (!row.recoveryInstance) throw fault('ROLLBACK_WAITING', 'Waiting for safe process exit');
          const evidence = await observe(row, { ...row.previous, instanceId: row.recoveryInstance });
          store.expireRollback(row);
          if (row.result.recovery.state !== 'pending') continue;
          store.transaction(() => {
            row.result.running = evidence.running; row.result.health = evidence.health;
            row.result.state = 'failed'; row.result.failure.effects = 'applied';
            row.result.recovery = { state: 'restored', reference: 'binary-only-rollback', runningSha: evidence.running.sha };
            store.save(row);
            store.set(`active:${key(row)}`, row.previous);
          });
        } catch (error) {
          if (row.rollbackDeadline <= Date.now()) {
            store.expireRollback(row);
          }
        }
        continue;
      }
      if (terminal(row)) {
        await notify(row, await (notificationActors ??= readActors(config)));
        continue;
      }
      if (row.result.state === 'queued') {
        row.result.state = 'building'; row.dispatchAttempted = true; store.save(row);
        try {
          await command('gh', ['workflow', 'run', p.workflowPath, '--repo', p.repository, '--ref', p.targetRef.slice(11),
            '-f', `source_sha=${row.request.repo.sha}`, '-f', `request_id=${row.request.requestId}`,
            '-f', `config_path=${row.request.projectConfig.path}`, '-f', `config_sha256=${row.request.projectConfig.sha256}`]);
        } catch { store.fail(store.get(row.request.requestId), 'dispatch', fault('DISPATCH_UNKNOWN', 'Dispatch response unknown; inspect original identity, no automatic dispatch replay'), 'unknown'); }
      } else if (row.result.state === 'building') {
        if (Date.now() >= (row.buildReconcileDeadline ?? row.createdAt + p.buildTimeoutMs)) {
          store.fail(row, 'build', fault('BUILD_DEADLINE', 'No verified artifact within bounded build deadline'), 'unknown');
          continue;
        }
        const runs = await gh(p, 'actions/runs?event=workflow_dispatch&per_page=100');
        const matching = runs.workflow_runs.filter(run => matchesRun(run, row, p));
        if (matching.length > 1) {
          store.fail(row, 'build', fault('AMBIGUOUS_RUN', 'Multiple bound runs require explicit reconciliation'), 'unknown');
          continue;
        }
        const run = matching[0];
        if (run?.status === 'completed' && run.conclusion !== 'success') store.fail(row, 'build', fault('CI_FAILED', `CI concluded ${run.conclusion}`));
      } else if (row.result.state === 'built' && row.request.intent === 'deploy'
        && store.head(row.request.repo.id, row.request.environment)?.request.requestId === row.request.requestId) {
        if (p.activationEnabled === false) continue;
        try {
          await verifySource(row.request);
          row = store.claim(row.request.requestId, p.busyTimeoutMs);
          const response = await backend(p, '/admin/restart', { pending: true });
          if (!response.restartPending) throw fault('RESTART_UNCONFIRMED', 'Backend did not acknowledge safe restart');
        } catch (error) {
          const current = store.get(row.request.requestId);
          // A lost ACK does not undo the durable fence or mean the request was not armed.
          if (current.result.state !== 'waiting-idle') store.fail(current, 'idle-gate', error);
          else console.error(`Restart acknowledgement uncertain for ${row.request.requestId}: ${error.message}`);
        }
      } else if (row.result.state === 'waiting-idle' && row.deadline <= Date.now()) {
        // No switch is authorized after expiry; a racing launcher must recheck its fence.
        store.fail(row, 'idle-gate', fault('BUSY_DEADLINE', 'No safe activation before deadline'));
      } else if (row.result.state === 'verifying') {
        try {
          const evidence = await observe(row);
          store.recordRuntime(row, evidence);
        } catch (error) {
          if (Date.now() - Date.parse(row.result.updatedAt) > p.healthTimeoutMs) store.fail(row, 'health', error, 'unknown');
        }
      }
      } catch (error) { console.error(`Delivery ${row.request.requestId} deferred: ${error.message}`); }
    }
  } catch (error) { console.error(`Delivery tick deferred: ${error.message}`); }
  finally { working = false; finishClose(); }
}
// Never replay an interrupted dispatch or activation after controller death.
for (const row of pages(after => store.interruptedPage(after))) {
  store.fail(row, 'activation', fault('CONTROLLER_RESTART', 'Interrupted activation requires process reconciliation'), 'unknown');
}
server.listen(config.port, '127.0.0.1');
const timer = setInterval(() => { void tick(); }, 5000);
void tick();
process.on('SIGTERM', () => {
  closing = true;
  clearInterval(timer);
  server.close(() => { serverClosed = true; finishClose(); });
});
