import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, rmdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { stageArchive, validateRelease } from './archive.mjs';
import { verifyConsumerFloor } from './channel.mjs';
import { ConsumerModuleRunner, moduleServicePins } from './module-runner.mjs';
import { hostChecks, identifier, loadAuthority, operationPath, processIdentity, processStillExists,
  readJson, saveOperation, syncDirectory, writeJson } from './state.mjs';

async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error(`Backend lifecycle HTTP ${response.status}`);
  let text = '';
  for await (const part of response.body) {
    text += Buffer.from(part).toString();
    if (text.length > 64_000) throw new Error('Backend lifecycle response too large');
  }
  return JSON.parse(text);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function matchesIdentity(actual, expected) {
  return actual?.authority === 'consumer' && ['installationId', 'sha', 'artifactSha256', 'requestId', 'instanceId', 'version']
    .every(key => typeof actual[key] === 'string' && actual[key] === expected[key]);
}

export class ConsumerLauncher {
  constructor(root, options = {}) {
    this.root = root;
    this.authority = loadAuthority(root);
    this.healthTimeout = options.healthTimeout ?? 30_000;
    this.nativeDrainAcknowledgementTimeout = options.nativeDrainAcknowledgementTimeout ?? 10_000;
    this.pollMs = options.pollMs ?? 250;
    this.child = null;
    this.active = existsSync(join(root, 'active.json')) ? readJson(join(root, 'active.json')).operationId : null;
    this.inFlight = false;
    this.server = null;
    const runtime = this.runtime();
    if (runtime && runtime.state !== 'exited') {
      if (!runtime.process || processStillExists(runtime.process)) {
        throw new Error('Previous backend may still be alive; refusing adoption or a competing launcher');
      }
      writeJson(join(root, 'runtime.json'), { ...runtime, state: 'exited', observedAbsent: true });
    }
    this.moduleRunner = new ConsumerModuleRunner(root, { startupTimeout: options.moduleRunnerStartupTimeout,
      acknowledgementTimeout: options.moduleRunnerAcknowledgementTimeout });
    if (this.active) {
      const operation = readJson(operationPath(root, this.active));
      operation.state = 'unknown';
      operation.error = 'Launcher resumed after interruption; explicit original-operation recovery required';
      saveOperation(root, operation);
    }
  }
  runtime() { return existsSync(join(this.root, 'runtime.json')) ? readJson(join(this.root, 'runtime.json')) : null; }
  selection() { return existsSync(join(this.root, 'current.json')) ? readJson(join(this.root, 'current.json')) : null; }
  resumeServices() {
    const path = join(this.root, 'module-resume.json');
    if (!existsSync(path)) return [];
    const record = readJson(path);
    if (record.schemaVersion !== 1 || record.installationId !== this.authority.installationId
      || !/^[a-f0-9-]{36}$/.test(record.runnerGenerationId ?? '')) {
      throw new Error('Owned service restoration provenance is unconfirmed');
    }
    identifier(record.operationId); identifier(record.shutdownOperationId);
    return moduleServicePins(record.services);
  }
  captureResumeServices(operation, runner) {
    if (runner?.state !== 'stopped' || runner.shutdown?.state !== 'stopped') throw new Error('Cannot capture services from an unconfirmed host drain');
    const services = moduleServicePins(runner.shutdown.services);
    writeJson(join(this.root, 'module-resume.json'), { schemaVersion: 1, installationId: this.authority.installationId,
      operationId: operation.operationId, runnerGenerationId: runner.generationId,
      shutdownOperationId: runner.shutdown.operationId, services, capturedAt: new Date().toISOString() });
    operation.resumeServices = services;
  }
  endpoint(path) { return `http://127.0.0.1:${this.authority.port}${path}`; }
  async version(expected, requireHealth = true) {
    const actual = await boundedJson(await fetch(this.endpoint('/version'), {
      redirect: 'error', signal: AbortSignal.timeout(2000), headers: { 'cache-control': 'no-store' },
    }));
    if (!matchesIdentity(actual, expected)) throw new Error('Backend immutable consumer identity mismatch');
    if (requireHealth) {
      const health = await boundedJson(await fetch(this.endpoint('/health'), {
        redirect: 'error', signal: AbortSignal.timeout(2000), headers: { 'cache-control': 'no-store' },
      }));
      if (health.ok !== true || health.instanceId !== actual.instanceId) throw new Error('Backend health is not the same healthy instance');
    }
    return actual;
  }
  async assertPortUnused() {
    // An unrelated listener must never be mistaken for our child or displaced.
    const { createServer: createNetServer } = await import('node:net');
    await new Promise((resolve, reject) => {
      const probe = createNetServer();
      probe.once('error', reject);
      probe.listen(this.authority.port, '127.0.0.1', () => probe.close(resolve));
    });
  }
  receipt(operation) { return saveOperation(this.root, operation); }
  complete(operation, state) {
    operation.state = state;
    if (['succeeded', 'recovered', 'stopped'].includes(state)) delete operation.error;
    this.receipt(operation);
    this.active = null;
    rmSync(join(this.root, 'active.json'), { force: true });
    syncDirectory(this.root);
  }
  claim(operation) {
    if (this.active || this.inFlight) throw new Error(`Another operation requires completion/recovery: ${this.active}`);
    saveOperation(this.root, operation, true);
    writeJson(join(this.root, 'active.json'), { operationId: operation.operationId }, true);
    this.active = operation.operationId;
  }
  checkCompatibility(selection) {
    if (selection.moduleRunnerApi !== 1 || selection.moduleRunnerLifecycleApi !== 1) {
      throw new Error('Main selection must support module runner API1 and owned lifecycle API1');
    }
    const runner = this.moduleRunner.record();
    if (runner && runner.state !== 'stopped') this.moduleRunner.assertIdentity();
    const path = join(this.root, 'data-compatibility.json');
    if (existsSync(path) && readJson(path).compatibility !== selection.compatibility) {
      throw new Error('Live data/config compatibility differs; explicit migration design required');
    }
  }
  run(operation, work) {
    this.inFlight = true;
    void work().catch(error => {
      operation.state = operation.backendEffect ? 'unknown' : 'failed';
      operation.error = error.message;
      if (operation.backendEffect) this.receipt(operation);
      else this.complete(operation, 'failed');
    }).finally(() => { this.inFlight = false; });
    return operation;
  }
  async startChild(selection, operation) {
    if (this.child) throw new Error('Owned backend is still alive; never start a competing replacement');
    if (selection.release !== join(this.root, 'releases', selection.target.sha256)
      || !/^[a-f0-9]{64}$/.test(selection.target.sha256)
      || !/^[a-f0-9]{64}$/.test(selection.manifestSha256)) throw new Error('Selection is outside this consumer installation or lacks verified manifest identity');
    await this.assertPortUnused();
    await validateRelease(selection.release, selection.target, selection.manifestSha256);
    this.checkCompatibility(selection);
    if (operation.kind === 'install' && operation.recovery !== 'fallback') this.verifyInstallAuthorization(operation);
    const compatibilityPath = join(this.root, 'data-compatibility.json');
    if (!existsSync(compatibilityPath)) writeJson(compatibilityPath,
      { compatibility: selection.compatibility, firstOperationId: operation.operationId }, true);
    operation.resumeServices = moduleServicePins(operation.resumeServices ?? this.resumeServices());
    operation.state = 'starting-module-runner';
    operation.backendEffect = true;
    this.receipt(operation);
    await this.moduleRunner.ensure(selection, operation.operationId, operation.resumeServices);
    operation.startedRunner = this.moduleRunner.record();
    if (operation.kind === 'install' && operation.recovery !== 'fallback') this.verifyInstallAuthorization(operation);
    const identity = { authority: 'consumer', installationId: this.authority.installationId,
      sha: selection.target.sourceSha, artifactSha256: selection.target.sha256,
      version: selection.target.version, requestId: operation.operationId, instanceId: randomUUID() };
    operation.identity = identity;
    operation.runningSelection = selection;
    operation.state = 'starting';
    operation.backendEffect = true;
    this.receipt(operation);
    writeJson(join(this.root, 'runtime.json'), { state: 'starting', identity, process: null });
    const log = openSync(join(this.authority.userRoot, 'logs/main.log'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    let processHandle;
    try {
      processHandle = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: join(selection.release, 'apps/server'), detached: true, stdio: ['ignore', log, log, 'ipc'],
        env: { ...process.env, COCKPIT_HOME: this.authority.nativeHome, COCKPIT_USER_ROOT: this.authority.userRoot,
          COCKPIT_PORT: String(this.authority.port), COCKPIT_SERVE_WEB: '1',
          COCKPIT_WEB_DIR: join(selection.release, 'apps/web/dist'), COCKPIT_ASSET_DIR: join(this.root, 'assets'),
          COCKPIT_CONSUMER_SHA: identity.sha, COCKPIT_CONSUMER_ARTIFACT: identity.artifactSha256,
          COCKPIT_CONSUMER_REQUEST: identity.requestId, COCKPIT_CONSUMER_INSTANCE: identity.instanceId,
          COCKPIT_CONSUMER_INSTALLATION: identity.installationId, COCKPIT_CONSUMER_ROOT: this.root },
      });
    } finally { closeSync(log); }
    let resolveExit;
    const child = { handle: processHandle, identity, preparations: new Set(), mainReady: false,
      exited: new Promise(resolve => { resolveExit = resolve; }) };
    this.child = child;
    processHandle.on('message', message => {
      if (!['consumer-main-ready', 'consumer-native-drain-result'].includes(message?.type)) return;
      try {
        if (message.instanceId !== identity.instanceId || message.installationId !== identity.installationId
          || message.pid !== processHandle.pid) throw new Error('Owned main lifecycle IPC identity mismatch');
        if (message.type === 'consumer-main-ready') {
          if (message.apiVersion !== 1 || child.mainReady
            || Object.keys(message).some(key => !['type', 'apiVersion', 'installationId', 'instanceId', 'pid'].includes(key))) {
            throw new Error('Owned main lifecycle IPC readiness/API mismatch');
          }
          child.mainReady = true;
          return;
        }
        const pending = child.nativeDrain;
        if (!pending || message.operationId !== pending.operation.operationId
          || !['accepted', 'unknown'].includes(message.state)
          || Object.keys(message).some(key => !['type', 'operationId', 'installationId', 'instanceId', 'pid', 'state', 'error'].includes(key))
          || (message.state === 'unknown' && (typeof message.error !== 'string' || !message.error))) {
          throw new Error('Owned main native drain acknowledgement identity/state mismatch');
        }
        pending.operation.nativeDrainReply = message;
        if (message.state === 'accepted') pending.operation.drainAcknowledged = true;
        this.receipt(pending.operation);
        pending.resolve?.(message);
        pending.resolve = pending.reject = null;
      } catch (error) {
        child.lifecycleError = error.message;
        child.nativeDrain?.reject?.(error);
      }
    });
    processHandle.once('disconnect', () => {
      child.nativeDrain?.reject?.(new Error('Main lifecycle IPC disconnected before native drain acknowledgement'));
    });
    let exited = false;
    const onExit = (code, signal, error) => {
      if (exited) return;
      exited = true;
      if (this.child === child) this.child = null;
      writeJson(join(this.root, 'runtime.json'), { state: 'exited', identity, process: child.process ?? null,
        code, signal, ...(error ? { error: error.message } : {}) });
      for (const id of child.preparations) {
        const preparationPath = operationPath(this.root, id);
        const preparation = readJson(preparationPath);
        if (preparation.kind === 'prepare-exit' && preparation.oldIdentity.instanceId === identity.instanceId) {
          this.receipt({ ...preparation, state: ['failed', 'unknown'].includes(preparation.state)
            ? preparation.state : code === 0 && signal === null && !error ? 'stopped' : 'unknown',
            exit: { code, signal }, ...(error ? { error: error.message } : {}) });
        }
      }
      child.nativeDrain?.reject?.(new Error('Backend exited before native drain acknowledgement'));
      resolveExit({ code, signal });
    };
    processHandle.once('error', error => onExit(null, null, error));
    processHandle.once('exit', (code, signal) => onExit(code, signal));
    child.process = processHandle.pid ? processIdentity(processHandle.pid) : null;
    writeJson(join(this.root, 'runtime.json'), { state: 'starting', identity, process: child.process });
    const deadline = Date.now() + this.healthTimeout;
    let lastError = 'Child did not become healthy';
    while (this.child === child && Date.now() < deadline) {
      try {
        await this.version(identity);
        if (this.child !== child) throw new Error('Backend exited during health readback');
        this.assertMainLifecycle(child);
        break;
      } catch (error) { lastError = error.message; }
      await delay(this.pollMs);
    }
    if (this.child !== child || Date.now() >= deadline) {
      throw new Error(`${lastError}; ${this.child === child ? 'child still alive, no kill/replacement' : 'child exited'}; explicit recovery required`);
    }
    await this.finishStartup(operation, child, selection);
  }
  async finishStartup(operation, child, selection, allowRestore = true) {
    this.assertMainLifecycle(child);
    const runner = this.moduleRunner.record();
    if (!allowRestore && runner?.restore?.state !== 'restored') {
      throw new Error('Enabled-module restoration is unconfirmed; verify never issues it. Inspect the original request or explicitly recover with restore');
    }
    operation.state = 'restoring-modules';
    this.receipt(operation);
    if (runner?.restore?.state !== 'restored') await this.moduleRunner.restoreEnabled(operation.operationId);
    this.moduleRunner.assertIdentity();
    if (this.child !== child) throw new Error('Backend exited while enabled modules were restoring; no automatic replacement');
    await this.version(child.identity);
    if (this.child !== child) throw new Error('Backend exited during final startup readback');
    operation.restoredRunner = this.moduleRunner.record();
    writeJson(join(this.root, 'runtime.json'), { state: 'healthy', identity: child.identity, process: child.process,
      startupVerifiedAt: new Date().toISOString() });
    writeJson(join(this.root, 'known-good.json'), { ...selection, identity: child.identity });
    operation.observed = child.identity;
    this.complete(operation, operation.recovery === 'fallback' ? 'recovered' : 'succeeded');
  }
  async drainModules(operation, { recovery = false, preservePendingResume = false } = {}) {
    const runner = this.moduleRunner.record();
    if (runner?.state === 'stopped' || !runner) {
      this.moduleRunner.assertStopped();
      operation.runnerStopped = true;
      return;
    }
    const priorEffect = operation.backendEffect;
    operation.state = 'draining-modules';
    operation.backendEffect = true;
    operation.drainingRunner = runner;
    this.receipt(operation);
    try { await this.moduleRunner.drainAndStop(operation.operationId, { recovery }); }
    catch (error) {
      // Only an authoritative no-effect refusal releases the operation for another explicit request.
      if (error.runnerLifecycleRefused) operation.backendEffect = priorEffect;
      operation.moduleDrain = this.moduleRunner.record();
      throw error;
    }
    operation.moduleDrain = this.moduleRunner.record();
    if (!preservePendingResume) this.captureResumeServices(operation, operation.moduleDrain);
    operation.runnerStopped = true;
    this.receipt(operation);
  }
  assertMainLifecycle(child) {
    if (this.child !== child || !child.mainReady || !child.handle.connected || child.lifecycleError) {
      throw new Error(child.lifecycleError ?? 'Owned main lifecycle IPC is not ready; no HTTP fallback or uncoordinated self-exit');
    }
  }
  async requestNativeDrain(operation, child) {
    this.assertMainLifecycle(child);
    if (child.nativeDrain) throw new Error('This native main drain was already requested; never resend its mutation');
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.nativeDrain.resolve = child.nativeDrain.reject = null;
        reject(new Error('Native main drain acknowledgement unknown; inspect the original operation without retry'));
      }, this.nativeDrainAcknowledgementTimeout);
      child.nativeDrain = { operation,
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); child.nativeDrain.resolve = child.nativeDrain.reject = null; reject(error); } };
      try {
        child.handle.send({ type: 'consumer-native-drain', operationId: operation.operationId,
          installationId: child.identity.installationId, instanceId: child.identity.instanceId }, error => {
          if (error) child.nativeDrain.reject?.(error);
        });
      } catch (error) { child.nativeDrain.reject?.(error); }
    });
    if (response.state !== 'accepted') throw new Error(response.error ?? 'Native main drain outcome is unconfirmed');
  }
  async drain(operation, requireHealthy = true, options) {
    const child = this.child;
    if (child) {
      this.assertMainLifecycle(child);
      await this.version(child.identity, requireHealthy);
    }
    if (child) operation.exitingIdentity = child.identity;
    await this.drainModules(operation, options);
    if (!child) return;
    if (this.child !== child) throw new Error('Backend exited before drain acknowledgement');
    if (operation.drainRequested) throw new Error('Drain already requested; never retry an uncertain mutation');
    operation.state = 'waiting-idle';
    operation.backendEffect = true;
    operation.drainRequested = child.identity.instanceId;
    this.receipt(operation);
    await this.requestNativeDrain(operation, child);
    this.receipt(operation);
    operation.oldExit = await child.exited;
    operation.oldExited = true;
    this.receipt(operation);
    if (operation.oldExit.code !== 0 || operation.oldExit.signal !== null) {
      throw new Error('Native-drained backend exit was not clean; no automatic crash respawn or replacement');
    }
  }
  verifyInstallAuthorization(operation) {
    const { channel } = readJson(join(this.authority.userRoot, 'consumer-config.json'));
    const floor = readJson(join(this.root, 'sequence.json'));
    const { metadata } = verifyConsumerFloor(operation.envelope, channel, floor);
    const target = metadata.targets.find(item => item.sha256 === operation.target.sha256 && item.version === operation.target.version);
    if (!target || JSON.stringify(target) !== JSON.stringify(operation.target)) throw new Error('Install target no longer matches signed authorization');
  }
  async activate(operation) {
    await this.drain(operation);
    this.verifyInstallAuthorization(operation);
    operation.state = 'switching';
    operation.backendEffect = true;
    this.receipt(operation);
    writeJson(join(this.root, 'current.json'), operation.selection);
    await this.startChild(operation.selection, operation);
  }
  async stop(operation) {
    await this.drain(operation);
    this.complete(operation, 'stopped');
    await this.close();
  }
  async restart(operation) {
    const selection = operation.selection, child = this.child;
    await this.drain(operation);
    if (!child || !operation.oldExited || !operation.drainAcknowledged || operation.drainRequested !== child.identity.instanceId
      || operation.oldExit.code !== 0 || operation.oldExit.signal !== null) {
      throw new Error('Restart did not confirm a clean native-drained child exit; no automatic crash respawn');
    }
    if (JSON.stringify(this.selection()) !== JSON.stringify(selection)) {
      throw new Error('Installed selection changed while draining; refusing replacement with a different release');
    }
    await this.startChild(selection, operation);
  }
  async waitPreparedExit(operation, child) {
    if (this.child !== child) throw new Error('Backend exited before its module drain was confirmed');
    operation.state = 'ready-to-exit';
    this.receipt(operation);
    // The backend's existing shutdown gate owns native drain; never call /admin/restart recursively.
    operation.oldExit = await child.exited;
    operation.oldExited = true;
    if (operation.oldExit.code !== 0 || operation.oldExit.signal !== null) throw new Error('Prepared backend exit was not clean');
    this.complete(operation, 'stopped');
  }
  acceptInstall(body) {
    identifier(body.operationId); identifier(body.downloadId);
    const existing = operationPath(this.root, body.operationId);
    if (existsSync(existing)) {
      const old = readJson(existing);
      if (old.kind !== 'install' || old.downloadId !== body.downloadId) throw new Error('Operation identity conflict');
      return old;
    }
    const downloaded = readJson(operationPath(this.root, body.downloadId));
    if (downloaded.kind !== 'download' || downloaded.state !== 'downloaded') throw new Error('Download is not verified/complete');
    const operation = { kind: 'install', operationId: body.operationId, downloadId: body.downloadId,
      target: downloaded.target, envelope: downloaded.envelope, state: 'preparing', backendEffect: false };
    this.verifyInstallAuthorization(operation);
    this.claim(operation);
    return this.run(operation, async () => {
      operation.selection = await stageArchive(this.root, operation);
      this.checkCompatibility(operation.selection);
      if (existsSync(join(this.root, 'known-good.json'))) operation.previous = readJson(join(this.root, 'known-good.json'));
      if (operation.previous && operation.previous.compatibility !== operation.selection.compatibility) {
        throw new Error('Data/config compatibility changed; explicit migration design required before activation');
      }
      this.receipt(operation);
      await this.activate(operation);
    });
  }
  acceptStart(body) {
    const path = operationPath(this.root, body.operationId);
    if (existsSync(path)) {
      const old = readJson(path);
      if (old.kind !== 'start') throw new Error('Operation identity conflict');
      return old;
    }
    if (this.child) throw new Error('Backend already running');
    const selection = this.selection();
    if (!selection) throw new Error('No installed selection; install a downloaded release first');
    const operation = { kind: 'start', operationId: body.operationId, selection, state: 'preparing' };
    this.claim(operation);
    return this.run(operation, () => this.startChild(selection, operation));
  }
  acceptStop(body) {
    const path = operationPath(this.root, body.operationId);
    if (existsSync(path)) {
      const old = readJson(path);
      if (old.kind !== 'stop') throw new Error('Operation identity conflict');
      return old;
    }
    const operation = { kind: 'stop', operationId: body.operationId, state: 'preparing' };
    this.claim(operation);
    return this.run(operation, () => this.stop(operation));
  }
  exitPreparationStatus(body) {
    const operation = readJson(operationPath(this.root, body.operationId));
    if (operation.kind !== 'prepare-exit' || operation.oldIdentity.instanceId !== body.instanceId) {
      throw new Error('Main exit preparation identity conflict');
    }
    if (!operation.joinedOperationId || ['stopped', 'unknown', 'failed'].includes(operation.state)) return operation;
    const joined = readJson(operationPath(this.root, operation.joinedOperationId));
    if (joined.exitingIdentity?.instanceId !== body.instanceId) throw new Error('Main exit preparation lost its original lifecycle identity');
    let state = 'waiting-modules';
    if (['unknown', 'failed'].includes(joined.state)) state = 'unknown';
    else if (joined.oldExited) state = joined.oldExit?.code === 0 && joined.oldExit?.signal === null ? 'stopped' : 'unknown';
    else if (joined.runnerStopped) state = 'ready-to-exit';
    return { ...operation, state, ...(joined.error ? { error: joined.error } : {}) };
  }
  acceptPrepareExit(body) {
    const path = operationPath(this.root, body.operationId);
    if (existsSync(path)) return this.exitPreparationStatus(body);
    const child = this.child;
    if (!child || body.instanceId !== child.identity.instanceId) throw new Error('Main exit preparation requires the exact owned backend instance');
    const operation = { kind: 'prepare-exit', operationId: body.operationId,
      oldIdentity: child.identity, state: 'waiting-modules', backendEffect: false };
    if (this.active) {
      const active = readJson(operationPath(this.root, this.active));
      if (active.exitingIdentity?.instanceId !== body.instanceId) {
        throw new Error(`Another operation requires completion/recovery: ${this.active}`);
      }
      operation.joinedOperationId = this.active;
      saveOperation(this.root, operation, true);
      child.preparations.add(operation.operationId);
      return this.exitPreparationStatus(body);
    }
    this.claim(operation);
    child.preparations.add(operation.operationId);
    return this.run(operation, async () => {
      await this.version(child.identity, false);
      operation.exitingIdentity = child.identity;
      await this.drainModules(operation);
      await this.waitPreparedExit(operation, child);
    });
  }
  acceptRestart(body) {
    const path = operationPath(this.root, body.operationId);
    if (existsSync(path)) {
      const old = readJson(path);
      if (old.kind !== 'restart') throw new Error('Operation identity conflict');
      return old;
    }
    const child = this.child, selection = this.selection();
    if (!child || !selection) throw new Error('Restart requires an already owned running backend and installed selection');
    if (selection.release !== join(this.root, 'releases', child.identity.artifactSha256)
      || !/^[a-f0-9]{64}$/.test(selection.manifestSha256)
      || selection.target.sha256 !== child.identity.artifactSha256
      || selection.target.sourceSha !== child.identity.sha || selection.target.version !== child.identity.version) {
      throw new Error('Installed selection does not match the owned backend; restart cannot select another release');
    }
    const operation = { kind: 'restart', operationId: body.operationId, selection,
      oldIdentity: child.identity, state: 'preparing', backendEffect: false };
    this.claim(operation);
    return this.run(operation, async () => {
      await validateRelease(selection.release, selection.target, selection.manifestSha256);
      this.checkCompatibility(selection);
      if (this.child !== child) throw new Error('Owned backend exited before restart drain; no automatic crash respawn');
      await this.version(child.identity);
      operation.previous = { ...selection, identity: child.identity };
      this.receipt(operation);
      await this.restart(operation);
    });
  }
  recover(body) {
    if (this.inFlight) throw new Error('Operation still executing/waiting; read its status without replay');
    if (this.active !== body.operationId) throw new Error('Recovery requires the original active operation ID');
    const operation = readJson(operationPath(this.root, body.operationId));
    if (!['verify', 'restore', 'continue', 'drain', 'fallback', 'abandon'].includes(body.recovery)) {
      throw new Error('Recovery is verify, restore, continue, drain, fallback or abandon');
    }
    return this.run(operation, async () => {
      if (body.recovery === 'continue') {
        const child = this.child, runner = this.moduleRunner.record();
        if (!child || operation.exitingIdentity?.instanceId !== child.identity.instanceId || operation.drainRequested
          || !['install', 'restart', 'stop', 'prepare-exit'].includes(operation.kind)) {
          throw new Error('Continuation requires the original owned main before any native drain request; unknown native mutations are never replayed');
        }
        this.moduleRunner.assertStopped();
        if (!runner || runner.generationId !== operation.drainingRunner?.generationId
          || runner.shutdown?.state !== 'stopped' || runner.shutdown.operationId !== operation.moduleDrain?.shutdown?.operationId) {
          throw new Error('Original runner drain has no matching confirmed completion; no continuation or resend');
        }
        if (operation.kind === 'install' || operation.kind === 'restart') {
          await validateRelease(operation.selection.release, operation.selection.target, operation.selection.manifestSha256);
          this.checkCompatibility(operation.selection);
          if (operation.kind === 'install') this.verifyInstallAuthorization(operation);
          else if (JSON.stringify(this.selection()) !== JSON.stringify(operation.selection)) throw new Error('Installed selection changed before recovery');
        }
        await this.version(child.identity);
        operation.moduleDrain = runner;
        this.captureResumeServices(operation, runner);
        operation.runnerStopped = true;
        operation.continuedAfterRunnerReadback = true;
        this.receipt(operation);
        if (operation.kind === 'install') await this.activate(operation);
        else if (operation.kind === 'restart') await this.restart(operation);
        else if (operation.kind === 'stop') await this.stop(operation);
        else await this.waitPreparedExit(operation, child);
      } else if (body.recovery === 'verify' || body.recovery === 'restore') {
        if (!this.child || !operation.identity || this.child.identity.instanceId !== operation.identity.instanceId) {
          throw new Error('No owned candidate to verify; never adopt an external process');
        }
        const child = this.child;
        await this.version(operation.identity);
        if (this.child !== child) throw new Error('Candidate exited during recovery health readback');
        await this.finishStartup(operation, child, operation.runningSelection, body.recovery === 'restore');
      } else if (body.recovery === 'drain') {
        // Recovery only asks the verified candidate to use its authoritative native drain.
        if (!this.child) throw new Error('No owned process to drain');
        if (operation.identity?.instanceId !== this.child.identity.instanceId
          || operation.drainRequested === this.child.identity.instanceId) {
          throw new Error('Original drain outcome is unknown; cannot replay its mutation');
        }
        if (operation.recoveryDrainRequested === this.child.identity.instanceId) throw new Error('Recovery drain already requested; inspect, do not replay');
        operation.recoveryDrainRequested = this.child.identity.instanceId;
        this.receipt(operation);
        const recovery = { ...operation, drainRequested: undefined, drainAcknowledged: undefined,
          oldExit: undefined, oldExited: undefined, runnerStopped: undefined };
        const preservePendingResume = this.moduleRunner.record()?.restore === undefined;
        await this.drain(recovery, false, { recovery: true, preservePendingResume });
        operation.candidateModuleDrain = recovery.moduleDrain;
        operation.resumeServices = recovery.resumeServices;
        operation.state = 'unknown';
        operation.candidateExited = true;
        this.receipt(operation);
      } else if (body.recovery === 'fallback') {
        if (this.child || this.runtime()?.state !== 'exited') throw new Error('Candidate still alive/unknown; never force rollback');
        this.moduleRunner.assertStopped();
        if (!operation.previous?.identity || !operation.selection
          || operation.previous.compatibility !== operation.selection.compatibility) {
          throw new Error('No actually known-good data-compatible fallback');
        }
        operation.recovery = 'fallback';
        operation.state = 'switching-fallback';
        this.receipt(operation);
        writeJson(join(this.root, 'current.json'), operation.previous);
        await this.startChild(operation.previous, operation);
      } else {
        const runtime = this.runtime();
        if (this.child || (runtime ? runtime.state !== 'exited' : Boolean(operation.identity))) {
          throw new Error('Cannot abandon while candidate is alive/unknown');
        }
        this.moduleRunner.assertStopped();
        if (operation.previous) {
          if (operation.previous.compatibility !== operation.selection?.compatibility) throw new Error('Fallback compatibility unknown');
          writeJson(join(this.root, 'current.json'), operation.previous);
        } else {
          rmSync(join(this.root, 'current.json'), { force: true });
        }
        this.complete(operation, 'abandoned');
      }
    });
  }
  handle(body) {
    const authority = loadAuthority(this.root);
    if (authority.installationId !== this.authority.installationId
      || body.installationId !== this.authority.installationId) {
      throw new Error('Consumer control installation identity mismatch');
    }
    switch (body.action) {
      case 'status': return this.status();
      case 'install': return this.acceptInstall(body);
      case 'start': return this.acceptStart(body);
      case 'stop': return this.acceptStop(body);
      case 'restart': return this.acceptRestart(body);
      case 'prepare-exit': return this.acceptPrepareExit(body);
      case 'exit-status': return this.exitPreparationStatus(body);
      case 'recover': return this.recover(body);
      default: throw new Error('Unsupported consumer control action');
    }
  }
  async status() {
    let health = { state: 'stopped' };
    if (this.child) {
      const child = this.child;
      try {
        const identity = await this.version(child.identity);
        health = this.child === child ? { state: 'healthy', identity } : { state: 'stopped' };
      } catch (error) { health = { state: 'unavailable', error: error.message }; }
    }
    return { authority: 'consumer', installationId: this.authority.installationId,
      active: this.active, runtime: this.runtime(), selected: this.selection(), health,
      mainLifecycle: this.child ? { ready: this.child.mainReady && this.child.handle.connected && !this.child.lifecycleError,
        ...(this.child.lifecycleError ? { error: this.child.lifecycleError } : {}) } : null,
      moduleRunner: await this.moduleRunner.status() };
  }
  async close() {
    if (this.child || this.active) throw new Error('Cannot close launcher with live child or unresolved lifecycle operation');
    if (this.moduleRunner.child || (this.moduleRunner.record() && this.moduleRunner.record().state !== 'stopped')) {
      throw new Error('Cannot close launcher while its module runner is live or unknown');
    }
    this.moduleRunner.assertStopped();
    if (this.server) await new Promise((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    rmSync(join(this.root, 'control.sock'), { force: true });
    rmSync(join(this.root, 'launcher.lock/owner.json'));
    rmdirSync(join(this.root, 'launcher.lock'));
    syncDirectory(this.root);
  }
}

export async function serve(root, options = {}) {
  hostChecks();
  loadAuthority(root);
  const socket = join(root, 'control.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error('Install root too long for private Unix control socket');
  if (existsSync(socket)) throw new Error('Existing control socket; do not create a competing authority');
  mkdirSync(join(root, 'launcher.lock'), { mode: 0o700 });
  writeJson(join(root, 'launcher.lock/owner.json'), processIdentity(process.pid), true);
  const launcher = new ConsumerLauncher(root, options);
  launcher.server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/') throw new Error('Private control supports POST / only');
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16_384) throw new Error('Control request too large');
        chunks.push(chunk);
      }
      const result = await launcher.handle(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => {
    launcher.server.once('error', reject);
    launcher.server.listen(socket, () => { chmodSync(socket, 0o600); resolve(); });
  });
  const onSignal = () => {
    if (launcher.active || launcher.inFlight) return; // Never turn a second signal into a force-kill.
    launcher.acceptStop({ operationId: `signal-stop-${randomUUID()}` });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  launcher.server.once('close', () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  });
  return launcher;
}
