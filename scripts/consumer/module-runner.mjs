import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, lstatSync, openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { loadAuthority, processIdentity, processStillExists, readJson, writeJson } from './state.mjs';

const idleRefusal = 'Runner still owns active children/jobs; request ordinary graceful drain first';
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

/** Read-only API1 subset; no module control/start/apply/stop commands are issued here. */
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
  save(record) { writeJson(this.recordPath, { ...record, updatedAt: new Date().toISOString() }); }
  assertIdentity() {
    const record = this.record();
    if (this.fatal) throw new Error(this.fatal);
    if (record?.shutdown && record.shutdown.state !== 'refused') {
      throw new Error('Module runner shutdown is pending/unknown; no reuse or mutation retry');
    }
    if (record?.state !== 'ready') throw new Error('Module runner readiness is unconfirmed');
    if (!this.child || !record?.process || record.process.pid !== this.child.handle.pid || !processStillExists(record.process)) {
      throw new Error('Owned module runner is absent or unconfirmed');
    }
    const socket = privateSocket(this.socketPath), lock = lockIdentity(this.lockPath, this.child.handle.pid);
    if (record.apiVersion !== 1 || record.installationId !== this.authority.installationId
      || JSON.stringify(record.selection) !== JSON.stringify(this.child.selection) || lock.instanceId !== record.instanceId
      || socket.dev !== record.socketIdentity.dev || socket.ino !== record.socketIdentity.ino) {
      throw new Error('Owned module runner identity/socket changed; no adoption or replacement');
    }
    return record;
  }
  async statuses() {
    this.assertIdentity();
    const values = await Promise.all(['task', 'wechat'].map(id => readModuleRunnerStatus(this.socketPath, id)));
    this.assertIdentity();
    return values;
  }
  async assertIdle() {
    if (!this.child && (!this.record() || this.record().state === 'stopped')) return;
    const statuses = await this.statuses();
    if (statuses.some(value => value.status !== 'stopped' || value.owned || value.recoveryRequired
      || (value.job && value.job.phase !== 'done'))) {
      throw Object.assign(new Error('Module runner still has services/jobs or recovery uncertainty; explicitly stop modules first'), { runnerIdleRefused: true });
    }
  }
  async ensure(selection, operationId) {
    if (selection.moduleRunnerApi !== 1) throw new Error('Main release is incompatible with resident module runner API1');
    if (this.child) { this.assertIdentity(); return; }
    const previous = this.record();
    if (previous && previous.state !== 'stopped') throw new Error('Module runner crash/unknown outcome blocks automatic replacement');
    if (!absent(this.socketPath) || !absent(this.lockPath)) throw new Error('Existing module runner/socket will not be adopted');
    const record = { state: 'starting', apiVersion: 1, installationId: this.authority.installationId, selection, operationId, process: null,
      userRoot: this.authority.userRoot, cockpitUrl: `http://127.0.0.1:${this.authority.port}`, socket: this.socketPath };
    this.save(record);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COCKPIT_CONSUMER_')));
    const log = openSync(join(this.authority.userRoot, 'logs/module-runner.log'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    let handle;
    try {
      handle = spawn(process.execPath, ['--import', 'tsx', join(selection.release, 'packages/core/src/modules/supervisor-entry.ts'),
        '--user-root', this.authority.userRoot, '--cockpit-url', record.cockpitUrl], {
        cwd: join(selection.release, 'apps/server'), detached: true, stdio: ['ignore', log, log, 'ipc'],
        env: { ...env, COCKPIT_HOME: this.authority.nativeHome, COCKPIT_USER_ROOT: this.authority.userRoot },
      });
    } finally { closeSync(log); }
    let resolveExit, resolveReady, rejectReady;
    const owned = { handle, selection, exited: new Promise(resolve => { resolveExit = resolve; }) };
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
          if (this.fatal || owned.ready || message.apiVersion !== 1 || message.pid !== handle.pid || message.socket !== this.socketPath
            || !record.process || !processStillExists(record.process)) throw new Error('Module runner readiness identity/API mismatch');
          const socketIdentity = privateSocket(this.socketPath), lock = lockIdentity(this.lockPath, handle.pid);
          owned.ready = true;
          this.save({ ...record, state: 'ready', instanceId: lock.instanceId, socketIdentity });
          resolveReady();
        } else if (message?.type === 'module-runner-shutdown') {
          const current = this.record();
          if (current?.shutdown?.state !== 'requested' || message.operationId !== current.shutdown.operationId || message.pid !== handle.pid
            || typeof message.ok !== 'boolean') throw new Error('Module runner shutdown acknowledgement identity mismatch');
          const refused = !message.ok && message.error === idleRefusal;
          if (!message.ok && !refused) this.fatal = 'Runner shutdown failed with unconfirmed effects';
          this.save({ ...current, state: message.ok ? 'stopping' : refused ? 'ready' : 'unknown',
            shutdown: { ...current.shutdown, state: message.ok ? 'acknowledged' : refused ? 'refused' : 'unknown', error: message.error } });
          this.pending?.resolve(message);
          this.pending = null;
        }
      } catch (error) { fail(error); }
    });
    let exited = false;
    const onExit = (code, signal, error) => {
      if (exited) return;
      exited = true;
      this.child = null;
      const current = this.record();
      const clean = current?.shutdown?.state === 'acknowledged' && code === 0 && signal === null && !error;
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
  async shutdownIfIdle(operationId) {
    if (!this.child && (!this.record() || this.record().state === 'stopped')) return;
    await this.assertIdle();
    const record = this.assertIdentity(), child = this.child;
    const id = `shutdown_${createHash('sha256').update(operationId).digest('hex').slice(0, 48)}`;
    if (record.shutdown && record.shutdown.state !== 'refused') throw new Error('Runner shutdown outcome already pending/unknown; no mutation retry');
    if (record.shutdown?.operationId === id) throw new Error('Runner shutdown request ID is readback-only');
    this.save({ ...record, shutdown: { operationId: id, state: 'requested' } });
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = null;
        reject(new Error('Runner idle-shutdown acknowledgement unknown; no retry or signal'));
      }, 10_000);
      this.pending = { resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); } };
      child.handle.send({ type: 'shutdown-if-idle', operationId: id }, error => {
        if (error && this.pending) { this.pending.reject(error); this.pending = null; }
      });
    });
    if (!response.ok) throw Object.assign(new Error(response.error ?? 'Runner idle shutdown unconfirmed'),
      { runnerIdleRefused: this.record().shutdown.state === 'refused' });
    const exit = await child.exited;
    if (!exit.clean) throw new Error('Runner idle-shutdown exit was not confirmed clean');
  }
  async status() {
    const record = this.record();
    if (!record || record.state === 'stopped') return { state: record?.state ?? 'not-started', record };
    if (record.state === 'stopping' || record.state === 'starting') return { state: record.state, record };
    try { return { state: 'ready', record: this.assertIdentity(), modules: await this.statuses() }; }
    catch (error) { return { state: 'unknown', record, error: error.message }; }
  }
}
