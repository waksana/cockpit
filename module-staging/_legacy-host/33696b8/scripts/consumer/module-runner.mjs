import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { identifier, loadAuthority, privateDirectory, processIdentity, processStillExists, readJson, writeJson } from './state.mjs';

const lifecycle = {
  shutdown: { request: 'drain-and-stop', response: 'module-runner-drain', complete: 'stopped', state: 'draining' },
  restore: { request: 'restore-enabled', response: 'module-runner-restore', complete: 'restored', state: 'restoring' },
};
export function moduleServicePins(value) {
  if (!Array.isArray(value) || value.length > 2) throw new Error('Owned service restoration requires an explicit bounded pin list');
  const ids = new Set();
  return value.map(pin => {
    if (!pin || typeof pin !== 'object' || Array.isArray(pin) || !['task', 'wechat'].includes(pin.id)
      || ids.has(pin.id) || Object.keys(pin).some(key => !['id', 'version', 'digest'].includes(key))
      || typeof pin.version !== 'string' || pin.version.length > 80
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(pin.version)
      || typeof pin.digest !== 'string' || !/^[a-f0-9]{64}$/.test(pin.digest)) {
      throw new Error('Invalid or duplicate owned service release pin');
    }
    ids.add(pin.id);
    return { id: pin.id, version: pin.version, digest: pin.digest };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function absent(path) {
  try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  return false;
}
function privateSocket(path) {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Module runner socket must be private and owner-only');
  return { dev: stat.dev, ino: stat.ino };
}
function lockIdentity(path, pid) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Module runner lock must be private and owner-only');
  const lock = readJson(path);
  if (lock.pid !== pid || !/^[a-f0-9-]{36}$/.test(lock.instanceId)) throw new Error('Module runner lock/process identity mismatch');
  return lock;
}

/** Read-only socket API. Lifecycle mutations use only the owned parent IPC. */
export function readModuleRunnerStatus(socketPath, id) {
  if (!['task', 'wechat'].includes(id)) throw new Error('Unsupported official service module');
  privateSocket(socketPath);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let bytes = Buffer.alloc(0), settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setTimeout(5000, () => finish(new Error('Module runner status is unavailable')));
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Module runner status ended without a complete response')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'status', id })}\n`));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 64 * 1024) return finish(new Error('Module runner status exceeds API1 limit'));
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(bytes.subarray(0, newline).toString());
        const status = response.result;
        if (response.ok !== true || !status || status.id !== id
          || !['stopped', 'starting', 'running', 'draining', 'failed', 'unknown'].includes(status.status)
          || typeof status.owned !== 'boolean' || typeof status.recoveryRequired !== 'boolean'
          || (status.job && (status.job.command?.id !== id
            || !['accepted', 'running', 'waiting', 'done', 'failed', 'unknown'].includes(status.job.phase)))) {
          throw new Error('Invalid module runner API1 status response');
        }
        finish(null, status);
      } catch (error) { finish(error); }
    });
  });
}

export class ConsumerModuleRunner {
  constructor(root, options = {}) {
    this.root = root;
    this.authority = loadAuthority(root);
    this.socketPath = join(this.authority.userRoot, '.module-runner.sock');
    this.lockPath = join(this.authority.userRoot, '.module-runner.lock');
    this.recordPath = join(root, 'module-runner.json');
    this.startupTimeout = options.startupTimeout ?? 30_000;
    this.acknowledgementTimeout = options.acknowledgementTimeout ?? 10_000;
    this.child = null;
    this.pending = null;
    this.fatal = null;
    if (Buffer.byteLength(this.socketPath) > 103) throw new Error('User root is too long for the module runner Unix socket');
    if (!absent(this.socketPath) || !absent(this.lockPath)) throw new Error('Existing module runner/socket will not be adopted, removed or replaced');
    const previous = this.record();
    if (previous && previous.installationId !== this.authority.installationId) throw new Error('Module runner record belongs to another consumer installation');
    if (previous && previous.state !== 'stopped') throw new Error('Previous module runner outcome is unknown; no automatic crash restart or adoption');
  }
  record() { return existsSync(this.recordPath) ? readJson(this.recordPath) : null; }
  save(record) {
    const value = { ...record, updatedAt: new Date().toISOString() };
    if (value.generationId) {
      const previous = this.record();
      const uncertainties = previous?.generationId === value.generationId ? [...(previous.uncertainties ?? [])] : [];
      const reason = value.state === 'unknown' ? value.error ?? value.shutdown?.error ?? value.restore?.error : undefined;
      if (reason && uncertainties.at(-1)?.reason !== reason) uncertainties.push({ observedAt: value.updatedAt, reason });
      if (uncertainties.length) value.uncertainties = uncertainties;
      identifier(value.generationId);
      const directory = join(this.root, 'module-runner-history');
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      privateDirectory(directory);
      writeJson(join(directory, `${value.generationId}.json`), value);
    }
    writeJson(this.recordPath, value);
  }
  assertIdentity({ allowLifecycle = false } = {}) {
    const record = this.record();
    if (this.fatal) throw new Error(this.fatal);
    if (!allowLifecycle && (record?.state !== 'ready'
      || (record.shutdown && record.shutdown.state !== 'refused')
      || (record.restore && !['restored', 'refused'].includes(record.restore.state)))) {
      throw new Error('Module runner lifecycle is pending/unknown; no reuse or mutation retry');
    }
    if (!['ready', 'restoring', 'draining', 'stopping', 'unknown'].includes(record?.state)) throw new Error('Module runner readiness is unconfirmed');
    if (!this.child || !record?.process || record.process.pid !== this.child.handle.pid || !processStillExists(record.process)) {
      throw new Error('Owned module runner is absent or unconfirmed');
    }
    const socket = privateSocket(this.socketPath), lock = lockIdentity(this.lockPath, this.child.handle.pid);
    if (record.apiVersion !== 1 || record.lifecycleApi !== 1 || record.installationId !== this.authority.installationId
      || JSON.stringify(record.selection) !== JSON.stringify(this.child.selection)
      || JSON.stringify(record.resumeServices) !== JSON.stringify(this.child.resumeServices) || lock.instanceId !== record.instanceId
      || socket.dev !== record.socketIdentity.dev || socket.ino !== record.socketIdentity.ino) {
      throw new Error('Owned module runner identity/socket changed; no adoption or replacement');
    }
    return record;
  }
  async statuses() {
    const before = this.assertIdentity({ allowLifecycle: true }), child = this.child;
    const values = await Promise.all(['task', 'wechat'].map(id => readModuleRunnerStatus(this.socketPath, id)));
    const after = this.assertIdentity({ allowLifecycle: true });
    if (this.child !== child || after.generationId !== before.generationId) throw new Error('Module runner changed during status read; no mixed-generation status');
    return values;
  }
  assertStopped() {
    const record = this.record();
    if (this.child || (record && record.state !== 'stopped')
      || !absent(this.socketPath) || !absent(this.lockPath)) {
      throw new Error('Owned module runner exit is not confirmed; no replacement or abandonment');
    }
  }
  async ensure(selection, operationId, resumeServices = []) {
    identifier(operationId);
    const services = moduleServicePins(resumeServices);
    if (selection.moduleRunnerApi !== 1 || selection.moduleRunnerLifecycleApi !== 1) {
      throw new Error('Main release must support module runner API1 and owned lifecycle API1');
    }
    if (this.child) throw new Error('Previous module runner is still alive; never reuse it across main startup');
    const previous = this.record();
    if (previous && previous.state !== 'stopped') throw new Error('Module runner crash/unknown outcome blocks automatic replacement');
    if (!absent(this.socketPath) || !absent(this.lockPath)) throw new Error('Existing module runner/socket will not be adopted');
    const record = { state: 'starting', apiVersion: 1, lifecycleApi: 1, generationId: randomUUID(),
      installationId: this.authority.installationId, selection, operationId, process: null,
      resumeServices: services,
      userRoot: this.authority.userRoot, cockpitUrl: `http://127.0.0.1:${this.authority.port}`, socket: this.socketPath };
    this.save(record);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COCKPIT_CONSUMER_')));
    const log = openSync(join(this.authority.userRoot, 'logs/module-runner.log'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    let handle;
    try {
      handle = spawn(process.execPath, ['--import', 'tsx', join(selection.release, 'packages/core/src/modules/supervisor-entry.ts'),
        '--user-root', this.authority.userRoot, '--cockpit-url', record.cockpitUrl, '--host-owned', 'true'], {
        cwd: join(selection.release, 'apps/server'), detached: true, stdio: ['ignore', log, log, 'ipc'],
        env: { ...env, COCKPIT_HOME: this.authority.nativeHome, COCKPIT_USER_ROOT: this.authority.userRoot },
      });
    } finally { closeSync(log); }
    let resolveExit, resolveReady, rejectReady;
    const owned = { handle, selection, resumeServices: services, exited: new Promise(resolve => { resolveExit = resolve; }) };
    this.child = owned;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timeout = setTimeout(() => rejectReady(new Error('Module runner readiness is unknown; child was not killed or replaced')), this.startupTimeout);
    const fail = error => {
      this.fatal = error.message;
      this.save({ ...this.record(), state: 'unknown', error: this.fatal });
      rejectReady(error);
      this.pending?.reject(error);
      this.pending = null;
    };
    handle.on('message', message => {
      try {
        if (message?.type === 'module-runner-ready') {
          if (this.fatal || owned.ready || message.apiVersion !== 1 || message.lifecycleApi !== 1
            || message.pid !== handle.pid || message.socket !== this.socketPath
            || !record.process || !processStillExists(record.process)) throw new Error('Module runner readiness identity/API mismatch');
          const socketIdentity = privateSocket(this.socketPath), lock = lockIdentity(this.lockPath, handle.pid);
          owned.ready = true;
          this.save({ ...record, state: 'ready', instanceId: lock.instanceId, socketIdentity });
          resolveReady();
        } else if (Object.values(lifecycle).some(value => value.response === message?.type)) {
          const [key, contract] = Object.entries(lifecycle).find(([, value]) => value.response === message.type);
          const current = this.record();
          const request = current?.[key];
          if (!request || !['requested', 'accepted', 'unknown'].includes(request.state)
            || message.operationId !== request.operationId || message.pid !== handle.pid
            || !['accepted', contract.complete, 'refused', 'unknown'].includes(message.state)
            || (['refused', 'unknown'].includes(message.state) && (typeof message.error !== 'string' || !message.error))) {
            throw new Error('Module runner lifecycle acknowledgement identity/state mismatch');
          }
          const pins = message.state === contract.complete ? moduleServicePins(message.services) : undefined;
          if (key === 'restore' && pins && JSON.stringify(pins) !== JSON.stringify(current.resumeServices)) {
            throw new Error('Restored services do not match the captured owned release pins');
          }
          let state = message.state === 'accepted' ? contract.state
            : message.state === 'stopped' ? 'stopping' : message.state === 'unknown' ? 'unknown' : 'ready';
          if (key === 'restore' && current.shutdown && current.shutdown.state !== 'refused') {
            state = ['requested', 'accepted'].includes(current.shutdown.state) ? 'draining'
              : current.shutdown.state === 'stopped' ? 'stopping' : 'unknown';
          }
          this.save({ ...current, state, [key]: { operationId: request.operationId, state: message.state,
            ...(pins ? { services: pins } : {}), ...(message.error ? { error: message.error } : {}) } });
          const pending = this.pending?.key === key ? this.pending : null;
          if (message.state === 'accepted') pending?.acknowledge();
          else {
            pending?.resolve(message);
            if (pending) this.pending = null;
          }
        }
      } catch (error) { fail(error); }
    });
    let exited = false;
    const onExit = (code, signal, error) => {
      if (exited) return;
      exited = true;
      this.child = null;
      const current = this.record();
      const clean = current?.shutdown?.state === 'stopped' && code === 0 && signal === null && !error;
      this.save({ ...current, state: clean ? 'stopped' : 'unknown', exit: { code, signal },
        ...(clean ? {} : { error: error?.message ?? 'Runner exited unexpectedly; module children are not adopted or restarted' }) });
      if (!clean) this.fatal = 'Module runner exited with an unknown outcome';
      rejectReady(new Error('Module runner exited before readiness'));
      this.pending?.reject(new Error('Module runner exited before shutdown acknowledgement'));
      this.pending = null;
      resolveExit({ code, signal, clean });
    };
    handle.once('error', error => onExit(null, null, error));
    handle.once('exit', (code, signal) => onExit(code, signal));
    record.process = handle.pid ? processIdentity(handle.pid) : null;
    this.save(record);
    try { await ready; this.assertIdentity(); }
    catch (error) { this.fatal = error.message; this.save({ ...this.record(), state: 'unknown', error: error.message }); throw error; }
    finally { clearTimeout(timeout); }
  }
  async requestLifecycle(key, operationId, { recovery = false } = {}) {
    identifier(operationId);
    const record = this.assertIdentity({ allowLifecycle: key === 'shutdown' && recovery }),
      child = this.child, contract = lifecycle[key];
    const id = `${key}_${createHash('sha256').update(`${operationId}:${record.generationId}`).digest('hex').slice(0, 48)}`;
    if (record[key] && record[key].state !== 'refused') throw new Error('Runner lifecycle already requested; no mutation retry');
    if (record[key]?.operationId === id) throw new Error('Runner lifecycle request ID is readback-only');
    if (this.pending) throw new Error('Runner lifecycle request is still pending');
    this.save({ ...record, state: contract.state, [key]: { operationId: id, state: 'requested' } });
    const response = await new Promise((resolve, reject) => {
      const fail = error => {
        this.pending = null;
        this.save({ ...this.record(), state: 'unknown', [key]: { operationId: id, state: 'unknown', error: error.message } });
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(new Error('Runner lifecycle acknowledgement unknown; no retry or signal'));
      }, this.acknowledgementTimeout);
      this.pending = { key, acknowledge: () => clearTimeout(timeout),
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); fail(error); } };
      try {
        child.handle.send({ type: contract.request, operationId: id,
          ...(key === 'restore' ? { services: moduleServicePins(record.resumeServices) } : {}) }, error => {
          if (error && this.pending) { this.pending.reject(error); this.pending = null; }
        });
      } catch (error) { this.pending?.reject(error); this.pending = null; }
    });
    if (response.state !== contract.complete) {
      throw Object.assign(new Error(response.error ?? 'Runner lifecycle is unconfirmed'),
        { runnerLifecycleRefused: response.state === 'refused' });
    }
    return response;
  }
  async drainAndStop(operationId, options) {
    if (!this.child && (!this.record() || this.record().state === 'stopped')) { this.assertStopped(); return; }
    const child = this.child;
    await this.requestLifecycle('shutdown', operationId, options);
    const exit = await child.exited;
    if (!exit.clean) throw new Error('Runner graceful-drain exit was not confirmed clean');
    this.assertStopped();
  }
  async restoreEnabled(operationId) {
    await this.requestLifecycle('restore', operationId);
    this.assertIdentity();
  }
  async status() {
    const record = this.record();
    if (!record || record.state === 'stopped') return { state: record?.state ?? 'not-started', record };
    if (record.state === 'stopping' || record.state === 'starting') return { state: record.state, record };
    try {
      const modules = await this.statuses(), current = this.assertIdentity({ allowLifecycle: true });
      if (current.generationId !== record.generationId) throw new Error('Module runner changed during status read');
      return { state: current.state, record: current, modules };
    }
    catch (error) { return { state: 'unknown', record, error: error.message }; }
  }
}
