import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

export type ModuleId = 'assistant' | 'task' | 'wechat';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface ModuleRole {
  id: string;
  name: string;
  description: string;
  instructions?: string;
  skills?: string[];
  mcp?: Record<string, { entry: string; args?: string[] }>;
}
export interface ModuleManifest {
  schemaVersion: 1;
  id: ModuleId;
  version: string;
  name: string;
  description: string;
  compatibility: { cockpitApi: 1; nodeMajor: 24; platform: 'linux'; arch: 'x64' };
  configVersion: number;
  roles?: ModuleRole[];
  service?: { entry: string; args?: string[]; healthPath: string; versionPath: string; drainPath: string; publicPath?: string };
  binding?: 'wechat';
  sessionLifecycle?: { unbind?: { entry: string; args?: string[] } };
  configLifecycle?: { initialize?: { entry: string; args?: string[] } };
}
export interface InstalledModule {
  manifest: ModuleManifest;
  release: string;
  digest: string;
}
export interface ModuleInventory {
  id: ModuleId;
  enabled: boolean;
  selectedVersion: string | null;
  installed: InstalledModule[];
}
export interface ModuleConfig {
  schemaVersion: 1;
  moduleId: ModuleId;
  revision: number;
  configVersion: number;
  values: JsonObject;
}
export interface HostConfig {
  schemaVersion: 1;
  revision: number;
  values: JsonObject;
}
export interface ModuleSelection { moduleId: ModuleId; roleId: string; version: string }
export type ModuleConfigReferences = Partial<Record<ModuleId, Record<string, string>>>;
export interface SessionModuleBinding {
  schemaVersion: 1;
  revision: number;
  sessionId: string;
  selections: ModuleSelection[];
  pendingSelections?: ModuleSelection[];
  configRefs?: ModuleConfigReferences;
  phase: 'preparing' | 'applied' | 'failed' | 'unknown';
  operationId: string;
  error?: string;
}
export type SessionBindingInput = Omit<SessionModuleBinding, 'schemaVersion' | 'revision'>;
export interface ModuleCatalogOptions {
  userRoot?: string;
  /** Exact trusted local package directories, supplied by the host, never browser input. */
  trustedSources?: readonly string[];
}
interface InventoryEntry { path: string; type: 'file' | 'directory'; size: number; sha256: string }
interface Receipt { schemaVersion: 1; digest: string; entries: InventoryEntry[] }
interface ModuleState { schemaVersion: 1; enabled: boolean; selectedVersion: string | null }
export class ModuleInstallError extends Error {
  constructor(cause: unknown, readonly outcome: 'not-published' | 'unknown') {
    super(cause instanceof Error ? cause.message : 'Module installation failed', { cause });
  }
}

const ids: readonly ModuleId[] = ['assistant', 'task', 'wechat'];
const receiptName = '.cockpit-inventory.json';
const maxEntries = 10_000;
const maxFileBytes = 64 * 1024 * 1024;
const maxTotalBytes = 400 * 1024 * 1024;
const maxRecordBytes = 4 * 1024 * 1024;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message: string): never { throw new Error(message); }
function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${context} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], context: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${context} field: ${key}`);
}
function text(value: unknown, context: string, max = 4096): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    fail(`Invalid ${context}`);
  }
  return value;
}
function identifier(value: unknown, context: string): string {
  const result = text(value, context, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) fail(`Invalid ${context}`);
  return result;
}
function roleId(value: unknown): string {
  const result = text(value, 'role ID', 80);
  if (!/^[a-z][a-z0-9-]*$/.test(result)) fail('Invalid role ID');
  return result;
}
function moduleId(value: unknown): ModuleId {
  if (value !== 'assistant' && value !== 'task' && value !== 'wechat') fail('Invalid module ID');
  return value;
}
function version(value: unknown): string {
  const result = text(value, 'module version', 80);
  if (!versionPattern.test(result)) fail('Invalid semver module version');
  return result;
}
function integer(value: unknown, context: string, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(`Invalid ${context}`);
  return value;
}
function schema(value: unknown): 1 {
  if (value !== 1) fail('Unsupported schemaVersion; explicit migration is required');
  return 1;
}
function relativePath(value: unknown): string {
  const path = text(value, 'release path', 1024);
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part =>
    !part || part === '.' || part === '..' || !/^[A-Za-z0-9_@.+-]+$/.test(part))) fail('Unsafe relative release path');
  if (path.split('/').includes(receiptName)) fail('Reserved inventory path');
  return path;
}
function inventoryPath(value: string): string {
  const path = text(value, 'inventory path', 1024);
  if (isAbsolute(path) || /[\x00-\x1f\x7f\\:]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) fail('Unsafe inventory path');
  if (path.split('/').includes(receiptName)) fail('Reserved inventory path');
  return path;
}
function entryPath(value: unknown): string {
  const path = relativePath(value);
  if (!/\.(?:mjs|cjs|js)$/.test(path)) fail('Node entry must be a JavaScript file');
  return path;
}
function args(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) fail('Invalid entry arguments');
  return value.map(value => {
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)
      || isAbsolute(value) || value.includes('\\') || /(?:^|[=/])\.\.(?:\/|$)/.test(value)
      || /(?:^|=)\/|[;&|`<>]|\$\(/.test(value)
      || /(?:password|passwd|secret|token|api[-_]?key|credential)(?:=|$)/i.test(value)) {
      fail('Unsafe entry argument; use configuration references for private values');
    }
    return value;
  });
}
function endpoint(value: unknown): string {
  const path = text(value, 'service endpoint', 256);
  if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(path)) fail('Service endpoint must be a local URL path');
  return path;
}
function parseRole(value: unknown): ModuleRole {
  const raw = object(value, 'role');
  keys(raw, ['id', 'name', 'description', 'instructions', 'skills', 'mcp'], 'role');
  const role: ModuleRole = { id: roleId(raw.id), name: text(raw.name, 'role name', 200), description: text(raw.description, 'role description') };
  if (raw.instructions !== undefined) role.instructions = relativePath(raw.instructions);
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills) || raw.skills.length > 64) fail('Invalid skill directories');
    role.skills = raw.skills.map(relativePath);
    if (new Set(role.skills).size !== role.skills.length) fail('Duplicate skill directories');
  }
  if (raw.mcp !== undefined) {
    const servers = object(raw.mcp, 'MCP');
    if (Object.keys(servers).length > 32) fail('Too many MCP entries');
    role.mcp = Object.fromEntries(Object.entries(servers).map(([name, value]) => {
      identifier(name, 'MCP name');
      const config = object(value, 'MCP entry');
      keys(config, ['entry', 'args'], 'MCP entry');
      return [name, { entry: entryPath(config.entry), ...(config.args === undefined ? {} : { args: args(config.args) }) }];
    }));
  }
  return role;
}
export function validateModuleManifest(value: unknown): ModuleManifest {
  const raw = object(value, 'manifest');
  keys(raw, ['schemaVersion', 'id', 'version', 'name', 'description', 'compatibility', 'configVersion', 'roles', 'service', 'binding', 'sessionLifecycle', 'configLifecycle'], 'manifest');
  const compatibility = object(raw.compatibility, 'compatibility');
  keys(compatibility, ['cockpitApi', 'nodeMajor', 'platform', 'arch'], 'compatibility');
  if (compatibility.cockpitApi !== 1 || compatibility.nodeMajor !== 24 || compatibility.platform !== 'linux' || compatibility.arch !== 'x64') {
    fail('Unsupported module compatibility');
  }
  const manifest: ModuleManifest = {
    schemaVersion: schema(raw.schemaVersion), id: moduleId(raw.id), version: version(raw.version),
    name: text(raw.name, 'module name', 200), description: text(raw.description, 'module description'),
    compatibility: { cockpitApi: 1, nodeMajor: 24, platform: 'linux', arch: 'x64' },
    configVersion: integer(raw.configVersion, 'configVersion'),
  };
  if (raw.roles !== undefined) {
    if (!Array.isArray(raw.roles) || raw.roles.length > 32) fail('Invalid module roles');
    manifest.roles = raw.roles.map(parseRole);
    if (new Set(manifest.roles.map(role => role.id)).size !== manifest.roles.length) fail('Duplicate module roles');
  }
  if (raw.service !== undefined) {
    const service = object(raw.service, 'service');
    keys(service, ['entry', 'args', 'healthPath', 'versionPath', 'drainPath', 'publicPath'], 'service');
    manifest.service = { entry: entryPath(service.entry),
      healthPath: endpoint(service.healthPath), versionPath: endpoint(service.versionPath), drainPath: endpoint(service.drainPath),
      ...(service.args === undefined ? {} : { args: args(service.args) }),
      ...(service.publicPath === undefined ? {} : { publicPath: endpoint(service.publicPath) }) };
  }
  if (raw.binding !== undefined) {
    if (raw.binding !== 'wechat' || manifest.id !== 'wechat') fail('Only the WeChat module may declare the wechat binding');
    manifest.binding = 'wechat';
  }
  if (raw.sessionLifecycle !== undefined) {
    const lifecycle = object(raw.sessionLifecycle, 'session lifecycle');
    keys(lifecycle, ['unbind'], 'session lifecycle');
    manifest.sessionLifecycle = {};
    if (lifecycle.unbind !== undefined) {
      const unbind = object(lifecycle.unbind, 'session unbind');
      keys(unbind, ['entry', 'args'], 'session unbind');
      manifest.sessionLifecycle.unbind = { entry: entryPath(unbind.entry),
        ...(unbind.args === undefined ? {} : { args: args(unbind.args) }) };
    }
  }
  if (raw.configLifecycle !== undefined) {
    const lifecycle = object(raw.configLifecycle, 'configuration lifecycle');
    keys(lifecycle, ['initialize'], 'configuration lifecycle');
    manifest.configLifecycle = {};
    if (lifecycle.initialize !== undefined) {
      const initialize = object(lifecycle.initialize, 'configuration initialize');
      keys(initialize, ['entry', 'args'], 'configuration initialize');
      manifest.configLifecycle.initialize = { entry: entryPath(initialize.entry),
        ...(initialize.args === undefined ? {} : { args: args(initialize.args) }) };
    }
  }
  return manifest;
}
function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 32) fail('JSON nesting limit exceeded');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1));
  return Object.fromEntries(Object.entries(object(value, 'JSON value')).map(([key, item]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Unsafe JSON object key');
    return [key, jsonValue(item, depth + 1)];
  }));
}
function jsonObject(value: unknown): JsonObject {
  object(value, 'configuration values');
  return jsonValue(value) as JsonObject;
}
function absoluteRoot(value: string): string {
  if (!isAbsolute(value)) fail('Cockpit user root and trusted sources must be absolute, not cwd-relative');
  return resolve(value);
}
export function resolveCockpitUserRoot(explicit?: string): string {
  return absoluteRoot(explicit ?? process.env.COCKPIT_USER_ROOT ?? join(homedir(), '.cockpit'));
}
function assertDirectory(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Directory path is not a real directory: ${current}`);
  }
}
function privateDirectory(path: string): void {
  if (!existsSync(path)) {
    privateDirectory(dirname(path));
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
  }
  assertDirectory(path);
}
function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function readRegular(path: string, limit: number): Buffer {
  assertDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) fail(`Invalid or oversized regular file: ${path}`);
    const value = readFileSync(fd);
    const after = fstatSync(fd);
    if (value.length > limit || value.length !== stat.size || after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail(`File changed while reading: ${path}`);
    return value;
  } finally { closeSync(fd); }
}
function readJson(path: string): unknown { return JSON.parse(readRegular(path, maxRecordBytes).toString('utf8')); }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function inventory(root: string, destination?: string, installed = false): InventoryEntry[] {
  assertDirectory(root);
  const result: InventoryEntry[] = [];
  let bytes = 0;
  const walk = (directory: string, prefix: string, depth: number): void => {
    if (depth > 32) fail('Release directory depth limit exceeded');
    for (const name of readdirSync(directory).sort()) {
      if (!prefix && name === receiptName && installed) continue;
      const path = inventoryPath(prefix ? `${prefix}/${name}` : name);
      if (result.length >= maxEntries) fail('Release inventory entry limit exceeded');
      const full = join(root, path), stat = lstatSync(full);
      if (stat.isSymbolicLink()) fail('Release symlinks are forbidden');
      if (stat.isDirectory()) {
        result.push({ path, type: 'directory', size: 0, sha256: '' });
        if (destination) mkdirSync(join(destination, path), { mode: 0o700 });
        walk(full, path, depth + 1);
        if (destination) {
          const fd = openSync(join(destination, path), constants.O_RDONLY | constants.O_DIRECTORY);
          try { fsyncSync(fd); } finally { closeSync(fd); }
        }
      } else {
        if (!stat.isFile() || stat.nlink !== 1) fail('Release special files and hard links are forbidden');
        bytes += stat.size;
        if (bytes > maxTotalBytes) fail('Release total byte limit exceeded');
        const content = readRegular(full, maxFileBytes);
        result.push({ path, type: 'file', size: content.length, sha256: hash(content) });
        if (destination) {
          const fd = openSync(join(destination, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
        }
      }
    }
  };
  walk(root, '', 0);
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function inventoryDigest(entries: InventoryEntry[]): string { return hash(JSON.stringify(entries)); }
export function inspectModulePackage(directory: string): InstalledModule {
  if (!isAbsolute(directory) || realpathSync(directory) !== directory) fail('Package inspection requires a canonical absolute directory');
  const entries = inventory(directory);
  const manifest = validateModuleManifest(readJson(join(directory, 'module.json')));
  validatePackageFiles(manifest, entries);
  return { manifest, release: directory, digest: inventoryDigest(entries) };
}
function validatePackageFiles(manifest: ModuleManifest, entries: InventoryEntry[]): void {
  const paths = new Map(entries.map(entry => [entry.path, entry.type]));
  const requireFile = (path: string): void => { if (paths.get(path) !== 'file') fail(`Declared release file is missing: ${path}`); };
  requireFile('module.json');
  for (const role of manifest.roles ?? []) {
    if (role.instructions) requireFile(role.instructions);
    for (const config of Object.values(role.mcp ?? {})) requireFile(config.entry);
    for (const directory of role.skills ?? []) {
      if (paths.get(directory) !== 'directory') fail(`Skill root is missing: ${directory}`);
      const children = entries.filter(entry => entry.path.startsWith(`${directory}/`) && !entry.path.slice(directory.length + 1).includes('/'));
      if (!children.length || children.some(child => child.type !== 'directory')) fail('Skill roots must contain named skill directories');
      for (const child of children) requireFile(`${child.path}/SKILL.md`);
    }
  }
  if (manifest.service) requireFile(manifest.service.entry);
  if (manifest.sessionLifecycle?.unbind) requireFile(manifest.sessionLifecycle.unbind.entry);
  if (manifest.configLifecycle?.initialize) requireFile(manifest.configLifecycle.initialize.entry);
}
function selection(value: unknown): ModuleSelection {
  const raw = object(value, 'selection');
  keys(raw, ['moduleId', 'roleId', 'version'], 'selection');
  return { moduleId: moduleId(raw.moduleId), roleId: roleId(raw.roleId), version: version(raw.version) };
}
function selections(value: unknown): ModuleSelection[] {
  if (!Array.isArray(value) || value.length > 3) fail('Invalid module selections');
  const result = value.map(selection);
  if (new Set(result.map(item => item.moduleId)).size !== result.length) fail('Choose only one role per module');
  return result;
}
function binding(value: unknown): SessionModuleBinding {
  const raw = object(value, 'session binding');
  keys(raw, ['schemaVersion', 'revision', 'sessionId', 'selections', 'pendingSelections', 'configRefs', 'phase', 'operationId', 'error'], 'session binding');
  if (!['preparing', 'applied', 'failed', 'unknown'].includes(String(raw.phase))) fail('Invalid session binding phase');
  return {
    schemaVersion: schema(raw.schemaVersion), revision: integer(raw.revision, 'revision'),
    sessionId: identifier(raw.sessionId, 'session ID'), selections: selections(raw.selections),
    ...(raw.pendingSelections === undefined ? {} : { pendingSelections: selections(raw.pendingSelections) }),
    ...(raw.configRefs === undefined ? {} : { configRefs: configReferences(raw.configRefs) }),
    phase: raw.phase as SessionModuleBinding['phase'], operationId: identifier(raw.operationId, 'operation ID'),
    ...(raw.error === undefined ? {} : { error: text(raw.error, 'binding error', 2000) }),
  };
}
function configReferences(value: unknown): ModuleConfigReferences {
  const raw = object(value, 'module configuration references');
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => {
    moduleId(id);
    const refs = object(value, 'module configuration references');
    if (Object.keys(refs).length > 32) fail('Too many module configuration references');
    return [id, Object.fromEntries(Object.entries(refs).map(([key, value]) => {
      identifier(key, 'configuration reference name');
      const path = text(value, 'configuration reference path', 2048);
      if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) {
        fail('Configuration references must be canonical absolute paths, never credential contents');
      }
      return [key, path];
    }))];
  }));
}

/** Owns product selection/configuration records, never native session state or publisher authentication. */
export class ModuleCatalog {
  readonly userRoot: string;
  readonly hostConfigPath: string;
  private readonly trustedSources: readonly string[];

  constructor(options: ModuleCatalogOptions = {}) {
    this.userRoot = resolveCockpitUserRoot(options.userRoot);
    this.hostConfigPath = join(this.userRoot, 'config.json');
    this.trustedSources = (options.trustedSources ?? []).map(absoluteRoot);
  }
  moduleConfigPath(id: ModuleId): string { return join(this.userRoot, 'module-config', `${moduleId(id)}.json`); }
  dataDirectory(id: ModuleId): string { return join(this.userRoot, 'data', moduleId(id)); }
  logsDirectory(id: ModuleId): string { return join(this.userRoot, 'logs', moduleId(id)); }
  private moduleDirectory(id: ModuleId): string { return join(this.userRoot, 'modules', moduleId(id)); }
  private bindingPath(sessionId: string): string { return join(this.userRoot, 'session-modules', `${identifier(sessionId, 'session ID')}.json`); }
  private initialize(): void {
    privateDirectory(this.userRoot);
    for (const path of ['', 'modules', 'module-config', 'data', 'logs', 'session-modules']) {
      const directory = join(this.userRoot, path);
      privateDirectory(directory);
      if ((lstatSync(directory).mode & 0o077) !== 0) {
        fail(`Cockpit storage directory must already be private (mode 700): ${directory}`);
      }
    }
  }
  private locked<T>(operation: () => T): T {
    this.initialize();
    const lock = join(this.userRoot, '.module-catalog.lock');
    let fd: number;
    try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (isCode(error, 'EEXIST')) fail('Module catalog is locked; inspect any unfinished writer before retrying (locks are never stolen)');
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, operationId: randomUUID() }));
      return operation();
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  private atomic(path: string, value: unknown): void {
    privateDirectory(dirname(path));
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > maxRecordBytes) fail('Record byte limit exceeded');
    const staging = join(dirname(path), `.write-${randomUUID()}`);
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        writeFileSync(fd, bytes); fchmodSync(fd, 0o600); fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(staging, path);
      const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { if (existsSync(staging)) unlinkSync(staging); }
  }
  private state(id: ModuleId): ModuleState {
    const path = join(this.moduleDirectory(id), 'state.json');
    if (!existsSync(path)) return { schemaVersion: 1, enabled: false, selectedVersion: null };
    const raw = object(readJson(path), 'module state');
    keys(raw, ['schemaVersion', 'enabled', 'selectedVersion'], 'module state');
    if (typeof raw.enabled !== 'boolean') fail('Invalid module enabled state');
    return { schemaVersion: schema(raw.schemaVersion), enabled: raw.enabled, selectedVersion: raw.selectedVersion === null ? null : version(raw.selectedVersion) };
  }
  private writeState(id: ModuleId, state: ModuleState): void { this.atomic(join(this.moduleDirectory(id), 'state.json'), state); }

  /** Rehashes the actual release on every resolve; callers must use this at execution boundaries. */
  getInstalled(id: ModuleId, requestedVersion?: string): InstalledModule | undefined {
    const state = this.state(id);
    const selected = requestedVersion === undefined ? state.selectedVersion : version(requestedVersion);
    if (!selected || (requestedVersion === undefined && !state.enabled)) return undefined;
    const release = join(this.moduleDirectory(id), 'releases', selected);
    if (!existsSync(release)) {
      if (selected === state.selectedVersion) fail('Selected module release is missing');
      return undefined;
    }
    const raw = object(readJson(join(release, receiptName)), 'inventory receipt');
    keys(raw, ['schemaVersion', 'digest', 'entries'], 'inventory receipt');
    schema(raw.schemaVersion);
    if (typeof raw.digest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.digest)) fail('Invalid release inventory digest');
    const actual = inventory(release, undefined, true);
    if (inventoryDigest(actual) !== raw.digest || JSON.stringify(actual) !== JSON.stringify(raw.entries)) fail('Module release integrity mismatch: installed bytes were modified');
    const manifest = validateModuleManifest(readJson(join(release, 'module.json')));
    if (manifest.id !== id || manifest.version !== selected) fail('Installed manifest identity mismatch');
    validatePackageFiles(manifest, actual);
    return { manifest, release, digest: raw.digest };
  }
  list(): ModuleInventory[] {
    return ids.flatMap(id => {
      const directory = this.moduleDirectory(id);
      if (!existsSync(directory)) return [];
      const state = this.state(id), releases = join(directory, 'releases');
      const installed = existsSync(releases) ? readdirSync(releases).sort().map(value => {
        const entry = this.getInstalled(id, version(value));
        if (!entry) fail('Installed release disappeared');
        return entry;
      }) : [];
      return [{ id, enabled: state.enabled, selectedVersion: state.selectedVersion, installed }];
    });
  }
  installFromDirectory(source: string, expectedDigest?: string): InstalledModule {
    const origin = absoluteRoot(source);
    if (!this.trustedSources.includes(origin)) fail('Source directory is not explicitly allowlisted by the host');
    assertDirectory(origin);
    if (realpathSync(origin) !== origin) fail('Trusted source must have a canonical, symlink-free path');
    if (this.userRoot === origin || this.userRoot.startsWith(`${origin}/`)) {
      fail('Trusted source must not contain the Cockpit user root');
    }
    if (expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedDigest)) fail('Invalid expected inventory digest');
    this.initialize();
    const staging = join(this.userRoot, 'modules', `.install-${randomUUID()}`);
    if (staging.startsWith(`${origin}/`)) fail('Trusted source must not contain the install staging directory');
    mkdirSync(staging, { mode: 0o700 });
    let publicationStarted = false;
    try {
      // Expensive source copy/hashing happens outside the short publication lock.
      const entries = inventory(origin, staging);
      const digest = inventoryDigest(entries);
      if (expectedDigest !== undefined && expectedDigest !== digest) fail('Source inventory digest mismatch');
      const manifest = validateModuleManifest(readJson(join(staging, 'module.json')));
      validatePackageFiles(manifest, entries);
      const receipt: Receipt = { schemaVersion: 1, digest, entries };
      this.atomic(join(staging, receiptName), receipt);
      return this.locked(() => {
        const previous = this.getInstalled(manifest.id, manifest.version);
        if (previous && previous.digest !== digest) fail('Immutable module version already exists with different bytes');
        const release = join(this.moduleDirectory(manifest.id), 'releases', manifest.version);
        if (!previous) {
          privateDirectory(dirname(release));
          publicationStarted = true;
          renameSync(staging, release);
          const fd = openSync(dirname(release), constants.O_RDONLY | constants.O_DIRECTORY);
          try { fsyncSync(fd); } finally { closeSync(fd); }
        }
        privateDirectory(this.dataDirectory(manifest.id));
        privateDirectory(this.logsDirectory(manifest.id));
        const state = this.state(manifest.id);
        publicationStarted = true;
        this.writeState(manifest.id, { schemaVersion: 1, enabled: true, selectedVersion: state.selectedVersion ?? manifest.version });
        return { manifest, release, digest };
      });
    } catch (error) {
      throw new ModuleInstallError(error, publicationStarted ? 'unknown' : 'not-published');
    } finally { if (existsSync(staging)) rmSync(staging, { recursive: true }); }
  }
  setSelected(id: ModuleId, selectedVersion: string): void {
    this.locked(() => {
      if (!this.getInstalled(id, selectedVersion)) fail('Cannot select an uninstalled version');
      this.writeState(id, { schemaVersion: 1, enabled: true, selectedVersion: version(selectedVersion) });
    });
  }
  /** Disable only. Code remains for explicit rollback; config/data/logs are never deleted. */
  uninstall(id: ModuleId): void {
    this.locked(() => {
      moduleId(id);
      for (const record of this.listBindings()) {
        if ([...record.selections, ...(record.pendingSelections ?? [])].some(selection => selection.moduleId === id)) {
          fail(`Module has a session reference: ${record.sessionId}`);
        }
      }
      this.writeState(id, { ...this.state(id), enabled: false });
    });
  }
  readHostConfig(): HostConfig {
    if (!existsSync(this.hostConfigPath)) return { schemaVersion: 1, revision: 0, values: {} };
    const raw = object(readJson(this.hostConfigPath), 'host config');
    keys(raw, ['schemaVersion', 'revision', 'values'], 'host config');
    return { schemaVersion: schema(raw.schemaVersion), revision: integer(raw.revision, 'revision'), values: jsonObject(raw.values) };
  }
  updateHostConfig(patch: JsonObject, expectedRevision: number): HostConfig {
    return this.locked(() => {
      const current = this.readHostConfig();
      this.checkRevision(current.revision, expectedRevision);
      const next: HostConfig = { schemaVersion: 1, revision: current.revision + 1, values: { ...current.values, ...jsonObject(patch) } };
      this.atomic(this.hostConfigPath, next);
      return next;
    });
  }
  readConfig(id: ModuleId, configVersion?: number): ModuleConfig {
    const expected = configVersion ?? this.getInstalled(id)?.manifest.configVersion;
    if (expected === undefined) fail('Specify the configVersion when no module version is selected');
    integer(expected, 'configVersion');
    const path = this.moduleConfigPath(id);
    if (!existsSync(path)) return { schemaVersion: 1, moduleId: id, revision: 0, configVersion: expected, values: {} };
    const raw = object(readJson(path), 'module config');
    keys(raw, ['schemaVersion', 'moduleId', 'revision', 'configVersion', 'values'], 'module config');
    if (moduleId(raw.moduleId) !== id || integer(raw.configVersion, 'configVersion') !== expected) fail('Incompatible module configVersion; explicit migration required');
    return { schemaVersion: schema(raw.schemaVersion), moduleId: id, revision: integer(raw.revision, 'revision'), configVersion: expected, values: jsonObject(raw.values) };
  }
  /** Shallow patch preserves unspecified user keys. This private API may return secrets; do not publish values. */
  updateConfig(id: ModuleId, patch: JsonObject, expectedRevision: number, configVersion?: number): ModuleConfig {
    return this.locked(() => {
      const current = this.readConfig(id, configVersion);
      this.checkRevision(current.revision, expectedRevision);
      const next: ModuleConfig = { ...current, revision: current.revision + 1, values: { ...current.values, ...jsonObject(patch) } };
      this.atomic(this.moduleConfigPath(id), next);
      return next;
    });
  }
  configSummary(id: ModuleId, configVersion?: number): Omit<ModuleConfig, 'values'> {
    const { values: _values, ...summary } = this.readConfig(id, configVersion);
    return summary;
  }
  private checkRevision(actual: number, expected: number): void {
    integer(expected, 'expected revision', 0);
    if (expected !== actual) fail(`Revision conflict: expected ${expected}, found ${actual}`);
    if (actual >= Number.MAX_SAFE_INTEGER) fail('Revision exhausted');
  }
  getBinding(sessionId: string): SessionModuleBinding | undefined {
    const path = this.bindingPath(sessionId);
    if (!existsSync(path)) return undefined;
    const record = binding(readJson(path));
    if (record.sessionId !== sessionId) fail('Session binding identity mismatch');
    return record;
  }
  getSession(sessionId: string): SessionModuleBinding | undefined { return this.getBinding(sessionId); }
  /** When omitted, expectedRevision comes from the read record; an unversioned input is create-only. */
  writeSession(record: SessionBindingInput | SessionModuleBinding, expectedRevision?: number): SessionModuleBinding {
    return this.setBinding(record, expectedRevision ?? ('revision' in record ? record.revision : 0));
  }
  listBindings(): SessionModuleBinding[] {
    const directory = join(this.userRoot, 'session-modules');
    if (!existsSync(directory)) return [];
    assertDirectory(directory);
    return readdirSync(directory).filter(name => !name.startsWith('.write-')).map(name => {
      if (!name.endsWith('.json')) fail('Unexpected session binding file');
      const record = this.getBinding(name.slice(0, -5));
      if (!record) fail('Session binding disappeared');
      return record;
    });
  }
  prepareBinding(sessionId: string, chosen: ModuleSelection[], operationId: string, expectedRevision = 0): SessionModuleBinding {
    const current = this.getBinding(sessionId);
    return this.setBinding({
      sessionId, selections: current?.selections ?? [], pendingSelections: chosen,
      ...(current?.configRefs === undefined ? {} : { configRefs: current.configRefs }),
      phase: 'preparing', operationId,
    }, expectedRevision);
  }
  setBinding(input: SessionBindingInput, expectedRevision: number): SessionModuleBinding {
    return this.locked(() => {
      if ('schemaVersion' in input) schema(input.schemaVersion);
      const record = binding({ ...input, schemaVersion: 1, revision: integer(expectedRevision, 'expected revision', 0) + 1 });
      const current = this.getBinding(record.sessionId);
      this.checkRevision(current?.revision ?? 0, expectedRevision);
      if (current && current.phase !== 'applied' && current.operationId !== record.operationId) {
        fail('An unfinished binding operation must be explicitly resolved before starting another');
      }
      if (record.phase === 'applied') {
        if (record.pendingSelections !== undefined) record.selections = record.pendingSelections;
        delete record.pendingSelections;
        delete record.error;
      } else if (JSON.stringify(record.selections) !== JSON.stringify(current?.selections ?? [])) {
        fail('An unfinished binding must retain the last successfully applied selections');
      }
      for (const chosen of [...record.selections, ...(record.pendingSelections ?? [])]) {
        const installed = this.getInstalled(chosen.moduleId, chosen.version);
        if (!installed || !this.state(chosen.moduleId).enabled) fail('Selected module is not installed and enabled');
        if (!installed.manifest.roles?.some(role => role.id === chosen.roleId)) fail('Selected module role does not exist');
      }
      this.atomic(this.bindingPath(record.sessionId), record);
      return record;
    });
  }
  removeBinding(sessionId: string, expectedRevision: number): void {
    this.locked(() => {
      const current = this.getBinding(sessionId);
      this.checkRevision(current?.revision ?? 0, expectedRevision);
      if (current && current.phase !== 'applied') fail('Cannot remove an unfinished binding; resolve its outcome first');
      if (current) unlinkSync(this.bindingPath(sessionId));
    });
  }
  archiveDeletedBinding(sessionId: string, expectedRevision: number): void {
    this.locked(() => {
      const current = this.getBinding(sessionId);
      this.checkRevision(current?.revision ?? 0, expectedRevision);
      if (!current) return;
      const archive = join(this.userRoot, 'session-module-history', `${sessionId}-${current.revision}.json`);
      if (existsSync(archive)) {
        if (JSON.stringify(readJson(archive)) !== JSON.stringify(current)) fail('Deleted module binding archive conflicts with the current record');
      } else this.atomic(archive, current);
      unlinkSync(this.bindingPath(sessionId));
    });
  }
}
