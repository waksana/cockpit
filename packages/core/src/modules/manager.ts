import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import type { CopilotSession } from '@github/copilot-sdk';
import { ModuleSelections, SessionModules, ModuleServiceRequest, type IntentBody, type ModuleConfig as PublicConfig, type ModuleSelection, type ModuleStatus } from '@cockpit/protocol';
import type { SessionModuleHost } from '../module-session.ts';
import type { OfficialRuntime } from '../runtime.ts';
import { ModuleCatalog, inspectModulePackage, type InstalledModule, type ModuleId, type SessionModuleBinding } from './catalog.ts';
import { NativeRoleEnvironment, type ResolvedModuleRole } from './role-environment.ts';
import { assertTaskService, assertWechatReady, provisionTaskCaller, publicModuleConfig, readPrivateModuleJson, readProtectedToken,
  serviceStatus, taskAuthority, taskCredentialDigest, validateAdapterConfig, verifyTaskCaller, wechatAuthority, wechatControl, type AdapterConfig } from './adapters.ts';
import { privateModuleDirectory, writeModuleRecord as writeReference } from './private-files.ts';
import { ModuleUpdates } from './updates.ts';
import { ModuleInitialization } from './initialization.ts';
import type { ModuleInitializationOperation, ModuleInitializationRequest } from '@cockpit/protocol';
import type { ModuleRunnerClient, ModuleRunnerJob, ModuleRunnerStatus, ServiceModuleId } from './supervisor.ts';
import { ModuleServiceCommand } from '@cockpit/protocol';

const officialIds: ModuleId[] = ['assistant', 'task', 'wechat'];
const activeUnbinds = new Set<string>();
const unbindChildren = new Set<string>();
const unbindEvents = new EventEmitter();
export interface ManualUnbindOperation {
  operationId: string;
  sessionId: string;
  state: 'working' | 'succeeded' | 'failed' | 'unknown';
  error?: string;
}
interface ManualUnbindReceipt {
  schemaVersion: 1;
  version: string;
  digest: string;
  operation: ManualUnbindOperation;
}
function detail(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1800); }
type InitializedModule = 'task' | 'wechat';
interface Initialization {
  schemaVersion: 1;
  moduleId: InitializedModule;
  sessionId: string;
  operationId: string;
  state: 'unprovisioned' | 'prepared' | 'attempted' | 'ready';
  authority: Record<string, string>;
  credentialFile?: string;
  credentialDigest?: string;
  bindingRevision?: number;
}
function present(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export type ModuleServiceController = Pick<ModuleRunnerClient, 'submit' | 'job' | 'status'>;
export interface ModuleManagerOptions {
  userRoot?: string;
  sources?: Partial<Record<ModuleId, string>>;
  runtime: Pick<OfficialRuntime, 'rpc' | 'getSessionMetadata'>;
  sessionDirectory?: (sessionId: string) => Promise<string | undefined>;
  services?: ModuleServiceController;
}

export class ModuleManager implements SessionModuleHost {
  readonly catalog: ModuleCatalog;
  readonly updates: ModuleUpdates;
  private readonly sources: Partial<Record<ModuleId, string>>;
  private readonly environment: NativeRoleEnvironment;
  private readonly configurationInitializer: ModuleInitialization;
  private admissionChildren = 0;
  private readonly admissionEvents = new EventEmitter();
  constructor(private readonly options: ModuleManagerOptions) {
    this.sources = { assistant: fileURLToPath(new URL('../../../../modules/assistant', import.meta.url)), ...options.sources };
    this.catalog = new ModuleCatalog({ userRoot: options.userRoot,
      trustedSources: Object.values(this.sources).map(path => resolve(path)) });
    this.updates = new ModuleUpdates(this.catalog);
    this.configurationInitializer = new ModuleInitialization(this.catalog);
    this.environment = new NativeRoleEnvironment(options.runtime);
  }
  private requireHost(): void {
    if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24) {
      throw new Error('Official module execution currently requires Linux x64 and Node 24');
    }
  }
  private installed(id: ModuleId, version?: string): InstalledModule {
    const installed = this.catalog.getInstalled(id, version);
    if (!installed) throw new Error(`Module ${id}${version ? `@${version}` : ''} is not installed and selected`);
    return installed;
  }
  private config(installed: InstalledModule): AdapterConfig {
    return validateAdapterConfig(installed.manifest.id,
      this.catalog.readConfig(installed.manifest.id, installed.manifest.configVersion).values);
  }
  private admission(installed: InstalledModule, config: AdapterConfig): Promise<Record<string, unknown>> {
    if (!installed.manifest.sessionLifecycle?.canBind) return wechatControl(installed, config, { action: 'status' });
    return wechatControl(installed, config, { action: 'can-bind' }, {
      started: () => { this.admissionChildren++; },
      settled: () => { this.admissionChildren--; this.admissionEvents.emit('settled'); },
    });
  }
  private initializationFile(id: InitializedModule, sessionId: string): string {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(sessionId)) throw new Error('Invalid module initialization session ID');
    return join(this.catalog.dataDirectory(id), 'session-initialization', `${sessionId}.json`);
  }
  private accessFile(sessionId: string): string {
    this.initializationFile('task', sessionId);
    return join(this.catalog.dataDirectory('task'), 'session-access', `${sessionId}.json`);
  }
  private initialization(record: SessionModuleBinding | undefined, id: InitializedModule, sessionId: string,
    config: AdapterConfig, cwd: string, required = false, operationId = record?.operationId): Initialization | undefined {
    const file = this.initializationFile(id, sessionId), reference = record?.configRefs?.[id]?.initializationFile;
    if (reference && reference !== file) throw new Error('Module initialization reference changed');
    if (!present(file)) {
      const previouslyApplied = record?.selections.some(selection => selection.moduleId === id);
      if (required || reference || previouslyApplied
        || (id === 'task' && (record?.configRefs?.task?.accessFile || present(this.accessFile(sessionId))))) {
        throw new Error('Module initialization receipt is missing or legacy; explicit identity adoption is required, never initialize a replacement');
      }
      return undefined;
    }
    const raw = readPrivateModuleJson(file);
    const authority = id === 'task' ? taskAuthority(config) : { ...wechatAuthority(config), cwd };
    if (raw.schemaVersion !== 1 || raw.moduleId !== id || raw.sessionId !== sessionId
      || typeof raw.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(raw.operationId)
      || !['unprovisioned', 'prepared', 'attempted', 'ready'].includes(String(raw.state))
      || (id !== 'task' && raw.state === 'unprovisioned')
      || !raw.authority || typeof raw.authority !== 'object' || Array.isArray(raw.authority)
      || Object.keys(raw.authority).length !== Object.keys(authority).length
      || Object.entries(authority).some(([key, value]) => !Object.hasOwn(raw.authority!, key)
        || Reflect.get(raw.authority as object, key) !== value)
      || Object.keys(raw).some(key => !['schemaVersion', 'moduleId', 'sessionId', 'operationId', 'state', 'authority',
        'credentialFile', 'credentialDigest', 'bindingRevision'].includes(key))) {
      throw new Error('Module initialization identity/configuration changed or receipt is invalid; explicit reconciliation is required');
    }
    const result: Initialization = { schemaVersion: 1, moduleId: id, sessionId, operationId: raw.operationId,
      state: raw.state as Initialization['state'], authority };
    if (raw.state === 'ready') {
      if (id === 'task') {
        if (typeof raw.credentialFile !== 'string' || typeof raw.credentialDigest !== 'string'
          || !/^[a-f0-9]{64}$/.test(raw.credentialDigest) || raw.bindingRevision !== undefined) throw new Error('Invalid Task initialization receipt');
        result.credentialFile = raw.credentialFile; result.credentialDigest = raw.credentialDigest;
        const accessFile = record?.configRefs?.task?.accessFile ?? this.accessFile(sessionId);
        if (accessFile !== this.accessFile(sessionId)) throw new Error('Task access reference changed');
        const access = readPrivateModuleJson(accessFile);
        if (access.schemaVersion !== 1 || access.sessionId !== sessionId || access.credentialFile !== result.credentialFile
          || Object.keys(access).some(key => !['schemaVersion', 'sessionId', 'credentialFile'].includes(key))
          || taskCredentialDigest(config, result.credentialFile) !== result.credentialDigest) {
          throw new Error('Task caller access identity is missing or changed; automatic reprovision is forbidden');
        }
      } else {
        if (!Number.isSafeInteger(raw.bindingRevision) || Number(raw.bindingRevision) < 1
          || raw.credentialFile !== undefined || raw.credentialDigest !== undefined) throw new Error('Invalid WeChat initialization receipt');
        result.bindingRevision = Number(raw.bindingRevision);
      }
    } else if (raw.credentialFile !== undefined || raw.credentialDigest !== undefined || raw.bindingRevision !== undefined) {
      throw new Error('Incomplete initialization cannot claim a confirmed identity');
    }
    if (result.state === 'attempted') {
      throw Object.assign(new Error(`Module initialization outcome is unconfirmed; inspect original operation ${result.operationId}; never retry or replace it`),
        { moduleOutcomeUnknown: true });
    }
    if (result.state === 'prepared' && operationId && result.operationId !== operationId) {
      throw new Error('Module initialization belongs to the original operation; replacement is forbidden');
    }
    return result;
  }
  private lockedInitialization<T>(file: string, action: () => T): T {
    privateModuleDirectory(dirname(file));
    const lock = `${file}.lock`;
    let fd: number;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('Module initialization is locked; never steal an uncertain operation');
      throw error;
    }
    try { return action(); } finally { closeSync(fd); unlinkSync(lock); }
  }
  private saveInitialization(next: Initialization, previous?: Initialization): void {
    const file = this.initializationFile(next.moduleId, next.sessionId);
    this.lockedInitialization(file, () => {
      const current = present(file) ? readPrivateModuleJson(file) : undefined;
      if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('Module initialization changed concurrently; no mutation was retried');
      writeReference(file, next);
    });
  }
  private async verifyInitialization(receipt: Initialization, installed: InstalledModule, config: AdapterConfig): Promise<void> {
    if (receipt.state !== 'ready') throw new Error('Module initialization has not completed; cold loading never initializes it');
    if (receipt.moduleId === 'task') await verifyTaskCaller(config, receipt.credentialFile!, receipt.credentialDigest!);
    else assertWechatReady(await wechatControl(installed, config, { action: 'status' }),
      { sessionId: receipt.sessionId, revision: receipt.bindingRevision! });
  }
  private resolveRoles(selections: SessionModuleBinding['selections'], record?: SessionModuleBinding): ResolvedModuleRole[] {
    return selections.map(selection => {
      const installed = this.installed(selection.moduleId, selection.version);
      const role = installed.manifest.roles?.find(role => role.id === selection.roleId);
      if (!role) throw new Error(`Unknown module role: ${selection.moduleId}/${selection.roleId}`);
      if (selection.moduleId === 'wechat' && (role.instructions || role.skills?.length || Object.keys(role.mcp ?? {}).length)) {
        throw new Error('WeChat is binding-only and cannot inject instructions, skills or MCP');
      }
      const config = this.config(installed);
      const accessFile = selection.roleId === 'commander' ? record?.configRefs?.task?.accessFile : undefined;
      return {
        selection, release: installed.release,
        ...(role.instructions ? { instructions: join(installed.release, role.instructions) } : {}),
        skillDirectories: (role.skills ?? []).map(path => join(installed.release, path)),
        mcpServers: Object.fromEntries(Object.entries(role.mcp ?? {}).map(([name, server]) => [name, {
          type: 'local' as const, command: process.execPath, args: [join(installed.release, server.entry), ...server.args ?? []], tools: ['*'],
          ...(selection.moduleId === 'task' ? { env: { WORK_URL: config.serviceUrl!,
            WORK_CREDENTIAL_DIR: config.credentialDirectory!, ...(accessFile ? { COCKPIT_TASK_ACCESS_FILE: accessFile } : {}) } } : {}),
        }])),
        ...(selection.moduleId === 'task' && selection.roleId === 'commander' && accessFile
          ? { configurationReferences: { taskAccessFile: accessFile } } : {}),
      };
    });
  }
  async prepare(sessionId: string, cwd: string, requested: ModuleSelection[], operationId: string): Promise<void> {
    this.requireHost();
    const current = this.catalog.getSession(sessionId);
    const chosen = ModuleSelections.parse(requested).map(selection => ({
      ...selection, version: this.installed(selection.moduleId, selection.version).manifest.version,
    }));
    if (current && current.phase !== 'applied' && current.operationId !== operationId) {
      throw new Error('A previous module operation is unfinished. Inspect its retained session and operation ID before continuing');
    }
    if (current?.operationId === operationId
      && JSON.stringify(current.pendingSelections ?? current.selections) !== JSON.stringify(chosen)) {
      throw new Error('Module operation ID is already bound to different selections');
    }
    if (current?.selections.some(selection => selection.moduleId === 'wechat')
      && !chosen.some(selection => selection.moduleId === 'wechat')) {
      const installed = this.installed('wechat', current.selections.find(selection => selection.moduleId === 'wechat')!.version);
      const status = await wechatControl(installed, this.config(installed), { action: 'status' });
      if (status.unknownOperation !== false || status.runnerUnknown !== false || status.unknownJobs !== 0) {
        throw new Error('WeChat association is unknown; role removal cannot bypass reconciliation');
      }
      if (status.boundSessionId === sessionId) throw new Error('Explicitly unbind WeChat before removing its session role');
    }
    const initializations: Initialization[] = [];
    const changes: Array<{ next: Initialization; previous?: Initialization }> = [];
    for (const selection of chosen) {
      const installed = this.installed(selection.moduleId, selection.version);
      const config = this.config(installed);
      if (selection.moduleId === 'assistant') continue;
      const receipt = this.initialization(current, selection.moduleId, sessionId, config, cwd, false, operationId);
      if (receipt?.state === 'ready') await this.verifyInitialization(receipt, installed, config);
      else {
        if (selection.moduleId === 'task') await assertTaskService(config, selection.roleId === 'commander');
        else assertWechatReady(await this.admission(installed, config));
      }
      if (!receipt) {
        const next: Initialization = { schemaVersion: 1, moduleId: selection.moduleId, sessionId, operationId,
          state: selection.moduleId === 'task' && selection.roleId !== 'commander' ? 'unprovisioned' : 'prepared',
          authority: selection.moduleId === 'task' ? taskAuthority(config) : { ...wechatAuthority(config), cwd } };
        initializations.push(next);
        changes.push({ next });
      } else if (receipt.state === 'unprovisioned' && selection.roleId === 'commander') {
        const next: Initialization = { ...receipt, operationId, state: 'prepared' };
        initializations.push(next);
        changes.push({ next, previous: receipt });
      } else {
        initializations.push(receipt);
      }
    }
    await this.environment.configuration(this.resolveRoles(chosen), cwd);
    for (const { next, previous } of changes) this.saveInitialization(next, previous);
    const prepared = this.catalog.prepareBinding(sessionId, chosen, operationId, current?.revision ?? 0);
    const refs = { ...prepared.configRefs };
    for (const selected of chosen) {
      refs[selected.moduleId] = { ...refs[selected.moduleId], config: this.catalog.moduleConfigPath(selected.moduleId) };
      if (selected.moduleId === 'task' && selected.roleId === 'commander') {
        refs.task = { ...refs.task, accessFile: this.accessFile(sessionId) };
      }
    }
    for (const receipt of initializations) {
      refs[receipt.moduleId] = { ...refs[receipt.moduleId], initializationFile: this.initializationFile(receipt.moduleId, sessionId) };
    }
    this.catalog.writeSession({ ...prepared, configRefs: refs });
  }
  async configuration(sessionId: string, cwd: string | undefined, applying: boolean) {
    const record = this.catalog.getSession(sessionId);
    if (!record) return {};
    if (!applying && record.phase !== 'applied') throw new Error('Module application is incomplete; cold loading never initializes it');
    this.requireHost();
    const directory = cwd ?? (await this.options.runtime.getSessionMetadata(sessionId))?.context?.workingDirectory;
    if (!directory) throw new Error('Native module session working directory is unavailable');
    const selected = applying ? record.pendingSelections ?? record.selections : record.selections;
    for (const selection of selected) {
      if (selection.moduleId === 'assistant') continue;
      const installed = this.installed(selection.moduleId, selection.version);
      const config = this.config(installed);
      const receipt = this.initialization(record, selection.moduleId, sessionId, config, directory,
        selection.moduleId === 'wechat' || selection.roleId === 'commander');
      if (!applying && receipt?.state === 'prepared') throw new Error('Module initialization is incomplete; cold loading never initializes it');
      if (receipt?.state === 'unprovisioned' && selection.roleId === 'commander') throw new Error('Task caller initialization must be explicitly prepared');
      if (receipt?.state === 'ready') await this.verifyInitialization(receipt, installed, config);
    }
    return this.environment.configuration(this.resolveRoles(selected, record), directory);
  }
  async connected(sessionId: string, session: CopilotSession, applying: boolean): Promise<void> {
    const record = this.catalog.getSession(sessionId);
    if (!record) return;
    if (!applying && record.phase !== 'applied') throw new Error('Module application is incomplete; cold loading never initializes it');
    const selected = applying ? record.pendingSelections ?? record.selections : record.selections;
    const needsInitialization = selected.some(selection => selection.moduleId !== 'assistant');
    const cwd = needsInitialization ? (await session.rpc.metadata.snapshot()).workingDirectory : '';
    if (typeof cwd !== 'string' || (needsInitialization && !cwd)) throw new Error('Native module session working directory is unavailable');
    await this.environment.assertConnected(session, this.resolveRoles(selected, record));
    for (const selection of selected) {
      if (selection.moduleId === 'assistant') continue;
      const installed = this.installed(selection.moduleId, selection.version);
      const config = this.config(installed);
      const receipt = this.initialization(record, selection.moduleId, sessionId, config, cwd,
        selection.moduleId === 'wechat' || selection.roleId === 'commander');
      if (!receipt || (receipt.state === 'unprovisioned' && selection.roleId !== 'commander')) {
        await assertTaskService(config, false);
        continue;
      }
      if (receipt.state === 'unprovisioned') throw new Error('Task caller initialization must be explicitly prepared');
      if (receipt.state === 'ready') {
        await this.verifyInitialization(receipt, installed, config);
        continue;
      }
      if (!applying) throw new Error('Module initialization is incomplete; cold loading never initializes it');
      if (selection.moduleId === 'wechat') assertWechatReady(await wechatControl(installed, config, { action: 'status' }));
      const attempted: Initialization = { ...receipt, state: 'attempted' };
      this.saveInitialization(attempted, receipt);
      // Claim before the remote effect. An interrupted attempt requires reconciliation, never a new identity or retry.
      try {
        let ready: Initialization;
        if (selection.moduleId === 'task') {
          const credentialFile = await provisionTaskCaller(config, sessionId, receipt.operationId);
          const credentialDigest = taskCredentialDigest(config, credentialFile);
          await verifyTaskCaller(config, credentialFile, credentialDigest);
          writeReference(this.accessFile(sessionId), { schemaVersion: 1, sessionId, credentialFile });
          ready = { ...attempted, state: 'ready', credentialFile, credentialDigest };
        } else {
          const result = await wechatControl(installed, config,
            { action: 'bind', sessionId, cwd, operationId: receipt.operationId });
          if (typeof result.revision !== 'number' || result.revision < 1) throw new Error('WeChat binding revision is unconfirmed');
          ready = { ...attempted, state: 'ready', bindingRevision: result.revision };
        }
        this.saveInitialization(ready, attempted);
        // A new WeChat bind acknowledges control identity before its runner creates a Store.
        if (selection.moduleId === 'task') await this.verifyInitialization(ready, installed, config);
      } catch (cause) {
        const unknown = !(cause && typeof cause === 'object' && 'moduleOutcomeUnknown' in cause && cause.moduleOutcomeUnknown === false);
        throw Object.assign(new Error(`Module initialization did not finish: ${detail(cause)}; inspect original operation ${receipt.operationId}; no automatic retry`, { cause }),
          { moduleOutcomeUnknown: unknown });
      }
    }
    if (applying) this.catalog.writeSession({ ...record, phase: 'applied' });
  }
  async failed(sessionId: string, error: unknown): Promise<void> {
    const record = this.catalog.getSession(sessionId);
    if (!record) return;
    const unknown = error && typeof error === 'object' && 'moduleOutcomeUnknown' in error && error.moduleOutcomeUnknown;
    this.catalog.writeSession({ ...record, phase: unknown ? 'unknown' : 'failed', error: detail(error) });
  }
  async assertReady(sessionId: string): Promise<void> {
    const record = this.catalog.getSession(sessionId);
    if (record && record.phase !== 'applied') throw new Error(`Module configuration is ${record.phase}; inspect the retained operation ${record.operationId}`);
  }
  activeCount(): number {
    const prefix = `${join(this.catalog.dataDirectory('wechat'), 'session-unbind')}/`;
    const unbinds = new Set([...activeUnbinds, ...unbindChildren].filter(file => file.startsWith(prefix)));
    return this.admissionChildren + this.configurationInitializer.activeCount() + unbinds.size;
  }
  onSettled(listener: () => void): () => void {
    const offInitialization = this.configurationInitializer.onSettled(listener);
    this.admissionEvents.on('settled', listener);
    unbindEvents.on(this.catalog.userRoot, listener);
    return () => { offInitialization(); this.admissionEvents.off('settled', listener); unbindEvents.off(this.catalog.userRoot, listener); };
  }
  initializeConfig(input: ModuleInitializationRequest): Promise<ModuleInitializationOperation> {
    return this.configurationInitializer.start(input);
  }
  configInitialization(operationId: string): ModuleInitializationOperation | null {
    return this.configurationInitializer.get(operationId);
  }
  async removed(sessionId: string): Promise<void> {
    const record = this.catalog.getSession(sessionId);
    if (record) this.catalog.archiveDeletedBinding(sessionId, record.revision);
  }
  async read(sessionId: string): Promise<SessionModules | null> {
    const record = this.catalog.getSession(sessionId);
    return record ? SessionModules.parse(record) : null;
  }
  private async runtimeStatus(id: ModuleId, config: AdapterConfig): Promise<ModuleStatus['service']> {
    if (config.ownership !== 'managed') return serviceStatus(config);
    if (id === 'assistant') throw new Error('Assistant has no managed service');
    const runner = await this.serviceStatus(id);
    return { ownership: 'managed', status: runner.status, runner,
      ...(runner.identity ? { version: runner.identity.moduleVersion, digest: runner.identity.moduleDigest,
        instanceId: runner.identity.instanceId } : {}),
      ...(runner.reason ? { reason: runner.reason } : {}) };
  }
  async list(cwd?: string, checkAvailability = false): Promise<ModuleStatus[]> {
    const inventory = this.catalog.list();
    return Promise.all(officialIds.map(async id => {
      const state = inventory.find(module => module.id === id);
      const installed = state?.enabled ? this.catalog.getInstalled(id) : undefined;
      const source = this.sources[id];
      let localRelease: ModuleStatus['localRelease'], localSourceError: string | undefined;
      let sourceManifest: InstalledModule['manifest'] | undefined;
      if (source) {
        try {
          const candidate = inspectModulePackage(source);
          if (candidate.manifest.id !== id) throw new Error('Trusted local source has a different module identity');
          sourceManifest = candidate.manifest;
          localRelease = { version: candidate.manifest.version, digest: candidate.digest };
        } catch (error) { localSourceError = detail(error); }
      }
      const manifest = installed?.manifest ?? sourceManifest;
      let service: ModuleStatus['service'] = { ownership: id === 'assistant' ? 'none' : 'external', status: 'unknown' };
      let unavailable: string | undefined;
      let channel: Record<string, unknown> | undefined;
      if (!installed) unavailable = '请先安装官方模块';
      else {
        try {
          const config = this.config(installed);
          service = { ownership: config.ownership, status: 'unknown' };
          service = await this.runtimeStatus(id, config);
          if (id === 'task') await assertTaskService(config, true);
          if (id === 'wechat') {
            channel = checkAvailability ? await this.admission(installed, config) : await wechatControl(installed, config, { action: 'status' });
            if (channel.available !== true) unavailable = String(channel.reason ?? '微信未就绪或已绑定');
          }
        } catch (error) {
          unavailable = detail(error);
          if (service.status === 'unknown') service = { ...service, reason: unavailable };
        }
      }
      const roles = await Promise.all((manifest?.roles ?? []).filter(role => role.id !== 'owner').map(async role => {
        let reason = unavailable;
        if (!reason && cwd && installed) {
          try {
            await this.environment.configuration(this.resolveRoles([{ moduleId: id, roleId: role.id, version: installed.manifest.version }]), cwd);
          } catch (error) { reason = detail(error); }
        }
        return { roleId: role.id, name: role.name, description: role.description, available: !reason,
          ...(reason ? { reason } : {}), ...(typeof channel?.boundSessionId === 'string' ? { boundSessionId: channel.boundSessionId } : {}) };
      }));
      return { id, name: manifest?.name ?? id, description: manifest?.description ?? '官方发行来源尚未配置',
        installed: state?.installed.map(item => ({ version: item.manifest.version, digest: item.digest })) ?? [],
        selectedVersion: state?.enabled ? state.selectedVersion : null, roles, service,
        supportsInitialization: id === 'task' && !!installed?.manifest.configLifecycle?.initialize,
        ...(localRelease ? { localRelease } : {}), ...(localSourceError ? { localSourceError } : {}),
        ...(installed?.manifest.service?.publicPath ? { page: installed.manifest.service.publicPath } : {}) };
    }));
  }
  async install(id: ModuleId): Promise<ModuleStatus> {
    this.requireHost();
    const source = this.sources[id];
    if (!source) throw new Error(`Trusted official module source is not configured: ${id}`);
    const candidate = inspectModulePackage(source);
    if (candidate.manifest.id !== id) {
      throw new Error('Trusted official source identity does not match requested module');
    }
    await this.installLocal({ moduleId: id, version: candidate.manifest.version, digest: candidate.digest,
      operationId: `local-${id}-${candidate.digest}` });
    return (await this.list()).find(module => module.id === id)!;
  }
  async installLocal(input: IntentBody<'modules/install/local'>) {
    this.requireHost();
    return this.updates.installLocal(input, this.sources[input.moduleId]);
  }
  async uninstall(id: ModuleId): Promise<void> {
    const installed = this.installed(id);
    if (installed.manifest.service && (await this.runtimeStatus(id, this.config(installed))).status !== 'stopped') {
      throw new Error('Module service is running or its stop is unconfirmed; uninstall is not safe');
    }
    this.catalog.uninstall(id);
  }
  getConfig(id: ModuleId): PublicConfig { return publicModuleConfig(this.catalog.readConfig(id, this.catalog.getInstalled(id)?.manifest.configVersion ?? 1)); }
  setConfig(config: PublicConfig): PublicConfig {
    validateAdapterConfig(config.moduleId, config.values);
    const previous = this.catalog.readConfig(config.moduleId, config.configVersion);
    if (previous.values.ownership && previous.values.ownership !== config.values.ownership && previous.values.serviceUrl) {
      throw new Error('Changing an existing service update authority requires an explicit migration handoff, not a configuration toggle');
    }
    if (previous.revision) writeReference(join(this.catalog.userRoot, 'config-backups', `${config.moduleId}-${previous.revision}.json`), previous);
    return publicModuleConfig(this.catalog.updateConfig(config.moduleId, config.values, config.revision, config.configVersion));
  }
  async control(input: IntentBody<'modules/service'>): Promise<ModuleRunnerJob> {
    this.requireHost();
    const { moduleId: id, ...command } = ModuleServiceRequest.parse(input);
    if (!this.options.services) throw new Error('Independent module launcher is not configured; no service was started or stopped');
    const running = command.action === 'stop' ? await this.options.services.status(id) : undefined;
    const pinned = running?.owned ? running.identity ?? running.expectedIdentity : undefined;
    if (running?.owned && (!pinned || pinned.moduleId !== id)) throw new Error('Owned service release identity is unconfirmed; no stop was submitted');
    const installed = this.installed(id, pinned?.moduleVersion ?? command.version);
    const config = this.config(installed);
    if (config.ownership !== 'managed') throw new Error('External services retain their existing update authority');
    if (command.action !== 'stop' && installed.digest !== command.digest) throw new Error('Installed module digest changed; no service operation was submitted');
    return this.options.services.submit({ id, ...command });
  }
  async serviceJob(operationId: string): Promise<ModuleRunnerJob | null> {
    if (!this.options.services) throw new Error('Independent module launcher is not configured; operation cannot be confirmed');
    return this.options.services.job(operationId);
  }
  async serviceStatus(id: ServiceModuleId): Promise<ModuleRunnerStatus> {
    if (!this.options.services) throw new Error('Independent module launcher is not configured; runtime ownership is unconfirmed');
    return this.options.services.status(id);
  }
  private unbindFile(operationId: string): string {
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(operationId)) throw new Error('Invalid manual unbind operation ID');
    return join(this.catalog.dataDirectory('wechat'), 'session-unbind', `${operationId}.json`);
  }
  private readUnbind(operationId: string): ManualUnbindReceipt | undefined {
    const file = this.unbindFile(operationId);
    if (!present(file)) return undefined;
    const raw = readPrivateModuleJson(file);
    if (raw.schemaVersion !== 1 || Object.keys(raw).some(key => !['schemaVersion', 'version', 'digest', 'operation'].includes(key))
      || !raw.operation || typeof raw.operation !== 'object' || Array.isArray(raw.operation)) {
      throw new Error('Invalid manual unbind receipt');
    }
    const operation = raw.operation as Record<string, unknown>;
    if (operation.operationId !== operationId || typeof operation.sessionId !== 'string'
      || !/^[A-Za-z0-9_-]{1,200}$/.test(operation.sessionId)
      || (operation.state !== 'working' && operation.state !== 'succeeded' && operation.state !== 'failed' && operation.state !== 'unknown')
      || (operation.error !== undefined && (typeof operation.error !== 'string' || !/^[A-Z][A-Z0-9_]{0,199}$/.test(operation.error)))
      || ((operation.state === 'failed' || operation.state === 'unknown') !== (operation.error !== undefined))
      || Object.keys(operation).some(key => !['operationId', 'sessionId', 'state', 'error'].includes(key))) {
      throw new Error('Invalid manual unbind receipt');
    }
    return { schemaVersion: 1, version: ModuleServiceCommand.shape.version.unwrap().parse(raw.version),
      digest: ModuleServiceCommand.shape.digest.unwrap().parse(raw.digest),
      operation: { operationId, sessionId: operation.sessionId, state: operation.state,
        ...(typeof operation.error === 'string' ? { error: operation.error } : {}) } };
  }
  unbindOperation(operationId: string): ManualUnbindOperation | null {
    const receipt = this.readUnbind(operationId);
    if (!receipt) return null;
    if (receipt.operation.state === 'working' && !activeUnbinds.has(this.unbindFile(operationId))) {
      return { ...receipt.operation, state: 'unknown', error: 'WECHAT_UNBIND_INTERRUPTED_NO_REPLAY' };
    }
    return { ...receipt.operation };
  }
  async unbind(sessionId: string, operationId: string): Promise<void> {
    const file = this.unbindFile(operationId);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error('Invalid manual unbind session ID');
    const readback = (operation: ManualUnbindOperation): void => {
      if (operation.sessionId !== sessionId) throw new Error('Manual unbind operation belongs to a different session');
      if (operation.state !== 'succeeded') throw Object.assign(new Error(operation.error ?? 'WECHAT_UNBIND_IN_PROGRESS_NO_REPLAY'),
        { moduleOutcomeUnknown: operation.state !== 'failed' });
    };
    const previous = this.unbindOperation(operationId);
    if (previous) { readback(previous); return; }
    const installed = this.installed('wechat'), config = this.config(installed);
    if (!installed.manifest.sessionLifecycle?.unbind) {
      throw new Error('Selected WeChat version does not declare sessionLifecycle.unbind; manual unbind is unsupported');
    }
    const claim: ManualUnbindReceipt = { schemaVersion: 1, version: installed.manifest.version, digest: installed.digest,
      operation: { operationId, sessionId, state: 'working' } };
    const owned = this.lockedInitialization(file, () => {
      const previous = this.unbindOperation(operationId);
      if (previous) { readback(previous); return false; }
      writeReference(file, claim);
      return true;
    });
    if (!owned) return;
    activeUnbinds.add(file);
    try {
      let operation: ManualUnbindOperation;
      try {
        const verified = this.installed('wechat', claim.version);
        if (verified.digest !== claim.digest) throw new Error('Manual unbind release changed');
        const result = await wechatControl(verified, config, { action: 'session-unbind', sessionId, operationId }, {
          started: () => { unbindChildren.add(file); },
          settled: () => { unbindChildren.delete(file); unbindEvents.emit(this.catalog.userRoot); },
        });
        if (result.unbound !== true || result.sessionId !== sessionId || result.operationId !== operationId) {
          throw new Error('WeChat session unbind was not confirmed');
        }
        const record = this.catalog.getSession(sessionId);
        if (record?.phase === 'applied' && record.selections.some(selection => selection.moduleId === 'wechat')) {
          this.catalog.writeSession({ ...record, operationId,
            pendingSelections: record.selections.filter(selection => selection.moduleId !== 'wechat') }, record.revision);
        }
        operation = { operationId, sessionId, state: 'succeeded' };
      } catch (error) {
        const known = error instanceof Error && 'moduleOutcomeUnknown' in error && error.moduleOutcomeUnknown === false;
        const code = error instanceof Error ? /^WeChat module control failed: ([A-Z][A-Z0-9_]{0,99})$/.exec(error.message)?.[1] : undefined;
        operation = { operationId, sessionId, state: known ? 'failed' : 'unknown',
          error: code ?? 'WECHAT_UNBIND_EFFECT_UNCONFIRMED' };
      }
      try {
        this.lockedInitialization(file, () => {
          if (!isDeepStrictEqual(this.readUnbind(operationId), claim)) throw new Error('Manual unbind receipt changed');
          writeReference(file, { ...claim, operation });
        });
      } catch (cause) {
        throw Object.assign(new Error('WECHAT_UNBIND_RECEIPT_WRITE_UNCONFIRMED', { cause }), { moduleOutcomeUnknown: true });
      }
      readback(operation);
    } finally {
      activeUnbinds.delete(file);
      unbindEvents.emit(this.catalog.userRoot);
    }
  }
  taskGateway(): { origin: string; publicOrigin: string; token: string } {
    const config = this.config(this.installed('task'));
    if (!config.serviceUrl || !config.gatewayUrl || !config.viewerCredentialFile) {
      throw new Error('Task module gateway requires explicit loopback URL, public origin and viewer credential reference');
    }
    return { origin: config.serviceUrl, publicOrigin: config.gatewayUrl, token: readProtectedToken(config.viewerCredentialFile) };
  }
}
