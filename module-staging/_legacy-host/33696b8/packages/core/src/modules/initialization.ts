import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { closeSync, constants, lstatSync, openSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ModuleInitializationOperation, ModuleInitializationRequest } from '@cockpit/protocol';
import { ModuleCatalog, type InstalledModule, type JsonObject } from './catalog.ts';
import { publicModuleConfig, readPrivateModuleJson, readProtectedToken, validateAdapterConfig } from './adapters.ts';
import { privateModuleDirectory, writeModuleRecord } from './private-files.ts';

export type { ModuleInitializationOperation, ModuleInitializationRequest } from '@cockpit/protocol';
type Stage = 'claimed' | 'port-selected' | 'invoked' | 'config-written' | 'finished';
interface Receipt {
  schemaVersion: 1;
  requestHash: string;
  request: ModuleInitializationRequest;
  configVersion: number;
  dataDirectory: string;
  stage: Stage;
  serviceUrl?: string;
  operation: ModuleInitializationOperation;
}
interface References {
  credentialDirectory: string;
  managerCredentialFile: string;
  viewerCredentialFile: string;
}
const active = new Set<string>();
const children = new Map<string, ChildProcess>();
const events = new EventEmitter();
function present(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
function requestHash(input: ModuleInitializationRequest): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409, code: 'MODULE_INITIALIZATION_CONFLICT' });
}
function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700
    || realpathSync(path) !== path) throw new Error('Initialization data must be an owner-only canonical directory');
}
async function unusedServiceUrl(): Promise<string> {
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback port allocation was not confirmed');
    return `http://127.0.0.1:${address.port}`;
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

/** A once-only configuration admission receipt, not service/native state or a recovery scheduler. */
export class ModuleInitialization {
  constructor(private readonly catalog: ModuleCatalog) {}
  private file(): string { return join(this.catalog.userRoot, 'module-config-initializations', 'task.json'); }
  private dataDirectory(): string { return this.catalog.dataDirectory('task'); }
  activeCount(): number { return active.has(this.file()) || children.has(this.file()) ? 1 : 0; }
  onSettled(listener: () => void): () => void {
    events.on(this.file(), listener);
    return () => { events.off(this.file(), listener); };
  }
  private settled(): void { events.emit(this.file()); }
  private read(): Receipt | undefined {
    if (!present(this.file())) return undefined;
    const raw = readPrivateModuleJson(this.file());
    const request = ModuleInitializationRequest.parse(raw.request);
    const operation = ModuleInitializationOperation.parse(raw.operation);
    if (raw.schemaVersion !== 1 || raw.requestHash !== requestHash(request)
      || raw.dataDirectory !== this.dataDirectory() || !Number.isSafeInteger(raw.configVersion) || Number(raw.configVersion) < 1
      || !['claimed', 'port-selected', 'invoked', 'config-written', 'finished'].includes(String(raw.stage))
      || operation.operationId !== request.operationId || operation.moduleId !== request.moduleId
      || operation.version !== request.version || operation.digest !== request.digest || operation.gatewayUrl !== request.gatewayUrl
      || (operation.reason !== undefined && !/^[A-Z][A-Z0-9_]{0,199}$/.test(operation.reason))
      || Object.keys(raw).some(key => !['schemaVersion', 'requestHash', 'request', 'configVersion', 'dataDirectory',
        'stage', 'serviceUrl', 'operation'].includes(key))) throw new Error('Invalid module initialization receipt');
    if (raw.serviceUrl !== undefined) {
      if (typeof raw.serviceUrl !== 'string') throw new Error('Invalid initialization service URL');
      validateAdapterConfig('task', { serviceUrl: raw.serviceUrl });
    }
    if (operation.config) {
      const values = operation.config.values;
      validateAdapterConfig('task', values);
      if (operation.phase !== 'succeeded' || operation.config.moduleId !== 'task' || operation.config.revision !== 1
        || operation.config.configVersion !== raw.configVersion || raw.stage !== 'finished'
        || values.ownership !== 'managed' || values.activationEnabled !== true || values.serviceUrl !== raw.serviceUrl
        || values.gatewayUrl !== request.gatewayUrl || values.dataDirectory !== this.dataDirectory()
        || Object.keys(values).length !== 8
        || ['credentialDirectory', 'managerCredentialFile', 'viewerCredentialFile'].some(key => {
          const path = values[key];
          return typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || !path.startsWith(`${this.dataDirectory()}/`);
        })) throw new Error('Invalid initialization config receipt');
    } else if (operation.phase === 'succeeded') throw new Error('Successful initialization receipt is missing its config');
    return { schemaVersion: 1, requestHash: requestHash(request), request, configVersion: Number(raw.configVersion),
      dataDirectory: this.dataDirectory(), stage: raw.stage as Stage,
      ...(typeof raw.serviceUrl === 'string' ? { serviceUrl: raw.serviceUrl } : {}), operation };
  }
  private view(receipt: Receipt): ModuleInitializationOperation {
    if (receipt.operation.phase === 'preparing' && !active.has(this.file())) {
      return { ...receipt.operation, phase: 'unknown', reason: 'MODULE_INITIALIZATION_INTERRUPTED_NO_REPLAY' };
    }
    return structuredClone(receipt.operation);
  }
  get(operationId: string): ModuleInitializationOperation | null {
    ModuleInitializationRequest.shape.operationId.parse(operationId);
    const receipt = this.read();
    return receipt?.request.operationId === operationId ? this.view(receipt) : null;
  }
  private locked<T>(work: () => T): T {
    privateModuleDirectory(this.catalog.userRoot);
    privateModuleDirectory(dirname(this.file()));
    const lock = `${this.file()}.lock`;
    let fd: number;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw conflict('Initialization claim is locked; never steal it');
      throw error;
    }
    try { return work(); } finally { closeSync(fd); unlinkSync(lock); }
  }
  private previous(input: ModuleInitializationRequest): Receipt | undefined {
    const receipt = this.read();
    if (receipt && receipt.requestHash !== requestHash(input)) {
      throw conflict('Task configuration already has an initialization claim; inspect the original operation, never replace or replay it');
    }
    return receipt;
  }
  private empty(configVersion: number): void {
    const config = this.catalog.readConfig('task', configVersion);
    if (config.revision !== 0 || Object.keys(config.values).length) {
      throw conflict('Task configuration initialization requires revision zero and empty values; existing configuration cannot be adopted');
    }
    const data = this.dataDirectory();
    if (present(data)) {
      privateDirectory(data);
      if (readdirSync(data).length) throw conflict('Task data is not empty; existing credentials or business data cannot be adopted');
    }
  }
  private installed(input: ModuleInitializationRequest): InstalledModule {
    const installed = this.catalog.getInstalled('task', input.version);
    if (!installed || installed.digest !== input.digest) throw conflict('Pinned installed Task release digest does not match');
    if (!installed.manifest.configLifecycle?.initialize) throw new Error('Selected Task version does not declare configLifecycle.initialize');
    return installed;
  }
  private save(next: Receipt, previous: Receipt): void {
    this.locked(() => {
      if (!isDeepStrictEqual(this.read(), previous)) throw conflict('Initialization receipt changed concurrently');
      writeModuleRecord(this.file(), next);
    });
  }
  private references(value: Record<string, unknown>, operationId: string): References {
    const data = this.dataDirectory();
    if (Object.keys(value).some(key => !['ok', 'operationId', 'dataDirectory', 'credentialDirectory',
      'managerCredentialFile', 'viewerCredentialFile'].includes(key))
      || value.ok !== true || value.operationId !== operationId || value.dataDirectory !== data) {
      throw new Error('MODULE_INITIALIZATION_RESPONSE_UNCONFIRMED');
    }
    privateDirectory(data);
    const path = (key: string): string => {
      const valuePath = value[key];
      if (typeof valuePath !== 'string' || !isAbsolute(valuePath) || resolve(valuePath) !== valuePath
        || !valuePath.startsWith(`${data}/`) || realpathSync(valuePath) !== valuePath) {
        throw new Error('MODULE_INITIALIZATION_REFERENCE_UNCONFIRMED');
      }
      return valuePath;
    };
    const credentialDirectory = path('credentialDirectory'), managerCredentialFile = path('managerCredentialFile'),
      viewerCredentialFile = path('viewerCredentialFile');
    privateDirectory(credentialDirectory);
    const manager = readProtectedToken(managerCredentialFile), viewer = readProtectedToken(viewerCredentialFile);
    if (managerCredentialFile === viewerCredentialFile || manager === viewer || manager.length < 32 || manager.length > 200
      || viewer.length < 30 || viewer.length > 200) throw new Error('MODULE_INITIALIZATION_CREDENTIAL_UNCONFIRMED');
    return { credentialDirectory, managerCredentialFile, viewerCredentialFile };
  }
  private invoke(installed: InstalledModule, operationId: string): Promise<References> {
    const hook = installed.manifest.configLifecycle?.initialize;
    if (!hook) throw new Error('Task configuration initialization capability is absent');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(installed.release, hook.entry), ...hook.args ?? []],
        { cwd: installed.release, env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      children.set(this.file(), child);
      let done = false, output = Buffer.alloc(0);
      const finish = (error?: Error, value?: References) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (error) reject(error); else if (value) resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('MODULE_INITIALIZATION_TIMEOUT_UNCONFIRMED')), 30_000);
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        if (done) return;
        if (output.length + chunk.length > 64 * 1024) { finish(new Error('MODULE_INITIALIZATION_OUTPUT_UNCONFIRMED')); return; }
        output = Buffer.concat([output, chunk]);
      });
      child.stdin.on('error', () => finish(new Error('MODULE_INITIALIZATION_TRANSPORT_UNCONFIRMED')));
      child.once('error', () => finish(new Error('MODULE_INITIALIZATION_TRANSPORT_UNCONFIRMED')));
      child.once('close', (code, signal) => {
        if (children.get(this.file()) === child) children.delete(this.file());
        this.settled();
        if (done) return;
        if (code !== 0 || signal) { finish(new Error('MODULE_INITIALIZATION_EXIT_UNCONFIRMED')); return; }
        try {
          const value: unknown = JSON.parse(output.toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
          finish(undefined, this.references(value as Record<string, unknown>, operationId));
        } catch { finish(new Error('MODULE_INITIALIZATION_RESPONSE_UNCONFIRMED')); }
      });
      child.stdin.end(JSON.stringify({ operation: 'config-initialize', operationId, dataDirectory: this.dataDirectory() }));
    });
  }
  async start(raw: ModuleInitializationRequest): Promise<ModuleInitializationOperation> {
    const input = ModuleInitializationRequest.parse(raw);
    if (input.gatewayUrl.length > 2048) throw new Error('Initialization gateway origin exceeds limit');
    const previous = this.previous(input);
    if (previous) return this.view(previous);
    if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24) {
      throw new Error('Task configuration initialization requires Linux x64 and Node 24');
    }
    const installed = this.installed(input);
    this.empty(installed.manifest.configVersion);
    const claim = this.locked(() => {
      const previous = this.previous(input);
      if (previous) return { receipt: previous, owned: false };
      this.empty(installed.manifest.configVersion);
      const { confirm: _confirm, ...target } = input;
      const receipt: Receipt = { schemaVersion: 1, requestHash: requestHash(input), request: input,
        configVersion: installed.manifest.configVersion, dataDirectory: this.dataDirectory(), stage: 'claimed',
        operation: { ...target, phase: 'preparing', updatedAt: Date.now() } };
      writeModuleRecord(this.file(), receipt);
      return { receipt, owned: true };
    });
    if (!claim.owned) return this.view(claim.receipt);
    let receipt = claim.receipt;
    const update = (next: Receipt) => { this.save(next, receipt); receipt = next; };
    active.add(this.file());
    try {
      const serviceUrl = await unusedServiceUrl();
      update({ ...receipt, stage: 'port-selected', serviceUrl });
      const verified = this.installed(input);
      this.empty(receipt.configVersion);
      update({ ...receipt, stage: 'invoked' });
      const refs = await this.invoke(verified, input.operationId);
      const values: JsonObject = { ownership: 'managed', activationEnabled: true, serviceUrl, gatewayUrl: input.gatewayUrl,
        dataDirectory: this.dataDirectory(), ...refs };
      validateAdapterConfig('task', values);
      const config = publicModuleConfig(this.catalog.updateConfig('task', values, 0, receipt.configVersion));
      update({ ...receipt, stage: 'config-written' });
      update({ ...receipt, stage: 'finished', operation: { ...receipt.operation, phase: 'succeeded', config, updatedAt: Date.now() } });
      return structuredClone(receipt.operation);
    } catch (error) {
      const uncertain = receipt.stage === 'invoked' || receipt.stage === 'config-written';
      const reason = error instanceof Error && /^MODULE_INITIALIZATION_[A-Z_]{1,150}$/.test(error.message)
        ? error.message : uncertain ? 'MODULE_INITIALIZATION_EFFECT_UNCONFIRMED' : 'MODULE_INITIALIZATION_PRECONDITION_FAILED';
      const operation: ModuleInitializationOperation = { ...receipt.operation, phase: uncertain ? 'unknown' : 'failed', reason, updatedAt: Date.now() };
      try { update({ ...receipt, stage: 'finished', operation }); }
      catch { return { ...operation, phase: 'unknown', reason: 'MODULE_INITIALIZATION_RECEIPT_WRITE_UNCONFIRMED' }; }
      return structuredClone(operation);
    } finally {
      active.delete(this.file());
      this.settled();
    }
  }
}
