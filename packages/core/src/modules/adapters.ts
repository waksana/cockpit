import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { ModuleConfig as PublicConfig, type ModuleStatus } from '@cockpit/protocol';
import type { InstalledModule, JsonObject, ModuleConfig, ModuleId } from './catalog.ts';

export interface AdapterConfig {
  ownership: 'none' | 'external' | 'managed';
  serviceUrl?: string;
  managerCredentialFile?: string;
  viewerCredentialFile?: string;
  credentialDirectory?: string;
  gatewayUrl?: string;
  configFile?: string;
  dataDirectory?: string;
  activationEnabled: boolean;
}
const fields = ['ownership', 'serviceUrl', 'managerCredentialFile', 'viewerCredentialFile',
  'credentialDirectory', 'gatewayUrl', 'configFile', 'dataDirectory', 'activationEnabled'];
export function validateAdapterConfig(moduleId: ModuleId, values: JsonObject): AdapterConfig {
  for (const key of Object.keys(values)) if (!fields.includes(key)) throw new Error(`Unsupported module configuration field: ${key}`);
  const ownership = values.ownership ?? (moduleId === 'assistant' ? 'none' : 'external');
  if (!['none', 'external', 'managed'].includes(String(ownership))) throw new Error('Invalid module service ownership');
  const config: AdapterConfig = { ownership: ownership as AdapterConfig['ownership'], activationEnabled: false };
  for (const key of ['managerCredentialFile', 'viewerCredentialFile', 'credentialDirectory', 'configFile', 'dataDirectory'] as const) {
    const value = values[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`Module ${key} must be a canonical absolute path, not credential contents`);
    }
    config[key] = value;
  }
  if (values.serviceUrl !== undefined && values.serviceUrl !== null && values.serviceUrl !== '') {
    if (typeof values.serviceUrl !== 'string') throw new Error('Invalid module serviceUrl');
    const url = new URL(values.serviceUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Module control requires an explicit IPv4 loopback HTTP origin');
    }
    config.serviceUrl = url.origin;
  }
  if (values.gatewayUrl !== undefined && values.gatewayUrl !== null && values.gatewayUrl !== '') {
    if (typeof values.gatewayUrl !== 'string') throw new Error('Invalid module gatewayUrl');
    const url = new URL(values.gatewayUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Module gatewayUrl must be its configured HTTPS public origin');
    }
    config.gatewayUrl = url.origin;
  }
  if (values.activationEnabled !== undefined) {
    if (typeof values.activationEnabled !== 'boolean') throw new Error('Invalid module activationEnabled');
    config.activationEnabled = values.activationEnabled;
  }
  if (moduleId === 'assistant' && (config.ownership !== 'none' || Object.keys(values).some(key => key !== 'ownership'))) {
    throw new Error('Assistant is instructions and skills only; no service configuration or workspace initialization');
  }
  return config;
}

export function publicModuleConfig(config: ModuleConfig): PublicConfig {
  validateAdapterConfig(config.moduleId, config.values);
  return PublicConfig.parse(config);
}

export function readPrivateModuleJson(file: string, limit = 128 * 1024): Record<string, unknown> {
  if (!isAbsolute(file) || realpathSync(file) !== file) throw new Error('Module reference must be canonical');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || (stat.mode & 0o077)
      || stat.uid !== process.getuid?.()) throw new Error('Module reference must be a bounded owner-only regular file');
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new Error('Module reference exceeds limit');
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid module reference object');
    return raw as Record<string, unknown>;
  } finally { closeSync(fd); }
}

export function readProtectedToken(file: string): string {
  const raw = readPrivateModuleJson(file, 16 * 1024);
  if (!raw || typeof raw !== 'object' || !('token' in raw) || typeof raw.token !== 'string'
    || !raw.token || /[\s\x00-\x1f\x7f]/.test(raw.token)) throw new Error('Invalid module control credential file');
  return raw.token;
}

export function taskAuthority(config: AdapterConfig): { serviceUrl: string; credentialDirectory: string } {
  if (!config.serviceUrl || !config.credentialDirectory) throw new Error('Task service and credential directory references are required');
  const directory = config.credentialDirectory, stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Task credential directory must be private and canonical');
  return { serviceUrl: config.serviceUrl, credentialDirectory: directory };
}

function taskCredential(config: AdapterConfig, file: string): string {
  const { credentialDirectory } = taskAuthority(config);
  if (!file.startsWith(`${credentialDirectory}/`)) throw new Error('Task credential is outside its pinned credential directory');
  return readProtectedToken(file);
}

export function taskCredentialDigest(config: AdapterConfig, file: string): string {
  return createHash('sha256').update(taskCredential(config, file)).digest('hex');
}

export async function verifyTaskCaller(config: AdapterConfig, file: string, digest: string): Promise<void> {
  const token = taskCredential(config, file);
  if (createHash('sha256').update(token).digest('hex') !== digest) throw new Error('Task caller credential identity changed; automatic replacement is forbidden');
  await assertTaskService(config, false);
  // This existing endpoint authenticates without issuing credentials or changing work.
  const result = await readLocalJson(config, '/api/read', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ view: 'summary', limit: 1, before: 1 }),
  });
  if (!Array.isArray(result.items) || result.items.length || result.nextBefore !== null) {
    throw new Error('Task caller authentication read is unconfirmed');
  }
  if (taskCredentialDigest(config, file) !== digest) throw new Error('Task caller credential changed during readiness verification');
}

export function wechatAuthority(config: AdapterConfig): { configFile: string; configDigest: string } {
  if (!config.configFile) throw new Error('WeChat configFile reference is not configured');
  return { configFile: config.configFile,
    configDigest: createHash('sha256').update(JSON.stringify(readPrivateModuleJson(config.configFile))).digest('hex') };
}

export function assertWechatReady(status: Record<string, unknown>, bound?: { sessionId: string; revision: number }): void {
  if (status.unknownOperation !== false || status.runnerUnknown !== false) {
    throw Object.assign(new Error('WeChat association outcome is unknown; automatic recovery is forbidden'), { moduleOutcomeUnknown: true });
  }
  if (status.managed !== true || status.configReady !== true || status.credentialsPresent !== true) {
    throw new Error('WeChat existing configuration or association is not ready');
  }
  if (bound) {
    const reason = typeof status.reason === 'string' ? status.reason : '';
    // Legacy business blocker reasons can mask a persisted binding mismatch.
    const bindingKnown = (status.bindingConfirmed === undefined || status.bindingConfirmed === true)
      && (['ALREADY_BOUND', 'RUNNING'].includes(reason)
      || (status.bindingConfirmed === true && ['PENDING_JOBS', 'UNKNOWN_OUTCOMES', 'NATIVE_FOLLOWUP_UNRESOLVED',
        'PENDING_INBOX_BATCH', 'TYPING_STATE_UNRESOLVED', 'STATE_SNAPSHOT_UNAVAILABLE'].includes(reason)));
    if (status.boundSessionId !== bound.sessionId || status.revision !== bound.revision
      || !bindingKnown) {
      throw new Error('WeChat existing association is missing or changed; automatic rebinding is forbidden');
    }
  } else {
    if (status.unknownJobs !== 0) {
      throw Object.assign(new Error('WeChat job outcomes are unknown; initial binding is forbidden'), { moduleOutcomeUnknown: true });
    }
    if (status.pendingJobs !== 0 || status.running !== false || status.detailsAvailable === false
      || status.available !== true || status.boundSessionId !== null || status.reason !== null) {
      throw new Error('WeChat is not available for initial binding');
    }
  }
}

export interface LocalJsonRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export async function readLocalJson(config: AdapterConfig, path: string, init: LocalJsonRequest = {}): Promise<Record<string, unknown>> {
  if (!config.serviceUrl) throw new Error('Module serviceUrl is not configured');
  const origin = new URL(config.serviceUrl), url = new URL(path, origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || url.origin !== origin.origin || url.username || url.password || url.hash) {
    throw new Error('Module control requires an explicit same-origin IPv4 loopback HTTP target');
  }
  for (const name of Object.keys(init.headers ?? {})) {
    if (['origin', 'referer', 'host'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('sec-fetch-')) {
      throw new Error('Module control forbids browser provenance headers and Host overrides');
    }
  }
  if (init.body !== undefined && typeof init.body !== 'string') throw new Error('Module control body must be a JSON string');
  return new Promise((resolve, reject) => {
    let settled = false, response: IncomingMessage | undefined;
    const finish = (error?: Error, value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req.destroy();
        response?.destroy();
        reject(error);
      } else if (value) resolve(value);
    };
    // Native HTTP adds no browser provenance headers and never follows redirects or retries.
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers, agent: false }, incoming => {
      response = incoming;
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        finish(new Error(`Module control ${path} returned ${status}; do not retry an uncertain mutation`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > 128 * 1024) { finish(new Error('Module control response exceeds limit')); return; }
        chunks.push(chunk);
      });
      incoming.once('error', error => finish(error));
      incoming.once('aborted', () => finish(new Error('Module control response was interrupted; outcome is unconfirmed')));
      incoming.once('end', () => {
        if (settled) return;
        if (!size) { finish(new Error('Module control response is empty')); return; }
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid module control response');
          finish(undefined, value as Record<string, unknown>);
        } catch (error) { finish(error instanceof Error ? error : new Error('Invalid module control response')); }
      });
    });
    const timer = setTimeout(() => finish(Object.assign(new Error('Module control request timed out after 10000ms; outcome is unconfirmed'),
      { code: 'ETIMEDOUT' })), 10_000);
    req.once('error', error => finish(error));
    req.once('upgrade', (_incoming, socket) => {
      socket.destroy();
      finish(new Error('Module control HTTP upgrades are forbidden'));
    });
    req.end(init.body);
  });
}

export async function serviceStatus(config: AdapterConfig): Promise<ModuleStatus['service']> {
  if (config.ownership === 'none') return { ownership: 'none', status: 'stopped' };
  if (!config.serviceUrl) return { ownership: config.ownership, status: 'unknown', reason: '尚未配置服务控制地址' };
  try {
    const version = await readLocalJson(config, '/version');
    const health = await readLocalJson(config, '/health');
    if (typeof version.instanceId !== 'string' || !version.instanceId || health.instanceId !== version.instanceId
      || typeof version.version !== 'string' || typeof health.ok !== 'boolean') {
      throw new Error('Module runtime identity/health is not confirmed for the same instance');
    }
    return { ownership: config.ownership, status: health.ok ? 'running' : 'unknown',
      version: version.version, instanceId: version.instanceId,
      ...(!health.ok ? { reason: '服务尚未确认健康；不将已安装版本当作运行版本' } : {}) };
  } catch (error) {
    return { ownership: config.ownership, status: 'unknown', reason: error instanceof Error ? error.message : 'Module runtime read failed' };
  }
}

export async function assertTaskService(config: AdapterConfig, commander: boolean): Promise<void> {
  if (!config.credentialDirectory) throw new Error('Task credentialDirectory reference is not configured');
  if (commander && !config.managerCredentialFile) throw new Error('Task managerCredentialFile reference is not configured');
  const version = await readLocalJson(config, '/version');
  const health = await readLocalJson(config, '/health');
  if (version.moduleApi !== 1 || !version.instanceId || version.instanceId !== health.instanceId || health.ok !== true) {
    throw new Error('Task service module API 1 and same-instance health are not ready; existing external service is unchanged');
  }
  if (commander) readProtectedToken(config.managerCredentialFile!);
}

export async function provisionTaskCaller(config: AdapterConfig, sessionId: string, operationId: string): Promise<string> {
  await assertTaskService(config, true);
  const result = await readLocalJson(config, '/admin/module/caller', {
    method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${readProtectedToken(config.managerCredentialFile!)}` },
    body: JSON.stringify({ requestId: operationId, sessionId }),
  }).catch(error => {
    throw Object.assign(new Error('Task caller provision outcome is unconfirmed; inspect the retained request ID', { cause: error }),
      { moduleOutcomeUnknown: true });
  });
  try {
    const expected = join(taskAuthority(config).credentialDirectory,
      `module-caller-${createHash('sha256').update(operationId).digest('hex')}.json`);
    if (result.credentialFile !== expected) throw new Error('Unexpected provisioned path');
    taskCredentialDigest(config, expected);
    return expected;
  } catch (cause) {
    throw Object.assign(new Error('Task caller provision returned an unconfirmed credential path; inspect the fixed request ID', { cause }),
      { moduleOutcomeUnknown: true });
  }
}

export async function wechatControl(installed: InstalledModule, config: AdapterConfig,
  body: { action: 'status' | 'bind' | 'unbind' | 'session-unbind'; sessionId?: string; cwd?: string; operationId?: string },
  lifecycle?: { started(): void; settled(): void }): Promise<Record<string, unknown>> {
  if (installed.manifest.id !== 'wechat') throw new Error('WeChat control cannot invoke another module');
  const hook = body.action === 'session-unbind' ? installed.manifest.sessionLifecycle?.unbind : undefined;
  if (body.action === 'session-unbind') {
    if (!hook) throw new Error('Selected WeChat version does not declare sessionLifecycle.unbind; native-independent manual unbind is unsupported');
    if (!body.sessionId || !/^[A-Za-z0-9_-]{1,200}$/.test(body.sessionId)
      || !body.operationId || !/^[A-Za-z0-9_-]{8,120}$/.test(body.operationId) || body.cwd !== undefined) {
      throw new Error('Session unbind requires only a valid sessionId and operationId, without native cwd');
    }
  }
  if (!config.configFile) throw new Error('WeChat configFile reference is not configured');
  const configFile = config.configFile;
  const entry = join(installed.release, hook?.entry ?? 'src/module-control.js');
  const unconfirmed = () => Object.assign(new Error('WeChat control outcome is unconfirmed; inspect the retained operation ID'),
    { moduleOutcomeUnknown: body.action !== 'status' });
  return new Promise((done, reject) => {
    const child = execFile(process.execPath, [entry, ...hook?.args ?? [], '--config', configFile], {
      cwd: installed.release, maxBuffer: 128 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME }, shell: false,
    }, (error, stdout) => {
      try {
        let value: unknown;
        try { value = JSON.parse(stdout); } catch { throw unconfirmed(); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || !('ok' in value)) throw unconfirmed();
        if ('operationId' in value && value.operationId !== body.operationId) throw unconfirmed();
        if (body.action === 'session-unbind' && 'sessionId' in value && value.sessionId !== body.sessionId) throw unconfirmed();
        if (value.ok === false && error?.code === 2 && !error.killed && !error.signal
          && 'error' in value && value.error && typeof value.error === 'object' && 'code' in value.error
          && typeof value.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.error.code)) {
          const failure = value.error.code;
          throw Object.assign(new Error(`WeChat module control failed: ${failure}`),
            { moduleOutcomeUnknown: body.action !== 'status' && /UNKNOWN|UNCONFIRMED/.test(failure) });
        }
        if (value.ok !== true || error) throw unconfirmed();
        if (body.action === 'status') {
          if (!('status' in value) || !value.status || typeof value.status !== 'object' || Array.isArray(value.status)) {
            throw new Error('Invalid WeChat status response');
          }
          done(value.status as Record<string, unknown>);
        } else if (body.action === 'session-unbind') {
          if (!('operationId' in value) || value.operationId !== body.operationId
            || !('sessionId' in value) || value.sessionId !== body.sessionId
            || !('unbound' in value) || value.unbound !== true
            || !('replayed' in value) || typeof value.replayed !== 'boolean') throw unconfirmed();
          done(value as Record<string, unknown>);
        } else {
          if (!('operationId' in value) || value.operationId !== body.operationId
            || !('boundSessionId' in value) || value.boundSessionId !== (body.action === 'bind' ? body.sessionId : null)
            || !('revision' in value) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
            || !('replayed' in value) || typeof value.replayed !== 'boolean') throw unconfirmed();
          done(value as Record<string, unknown>);
        }
      } catch (failure) { reject(failure); }
    });
    lifecycle?.started();
    child.once('close', () => lifecycle?.settled());
    const { action, ...parameters } = body;
    child.stdin!.on('error', () => reject(unconfirmed()));
    child.stdin!.end(JSON.stringify({ operation: action, ...parameters }));
  });
}
