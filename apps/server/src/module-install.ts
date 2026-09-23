import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { cockpitHome } from '@cockpit/core';
import type { ModuleManifest } from '@cockpit/module-api';

export const MANIFEST_FILE = 'cockpit.module.json';
export const MODULE_LIMITS = { archive: 32 * 1024 * 1024, expanded: 128 * 1024 * 1024, file: 32 * 1024 * 1024, entries: 8192 };
export const MODULE_WORKER_LIMIT = 1024 * 1024;
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const versionSchema = z.string().max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export function safeModulePath(value: string): string {
  if (!value || value.length > 1024 || isAbsolute(value) || /[\\:\x00-\x1f\x7f?#%]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid module-relative path: ${value}`);
  }
  return value;
}

const pathSchema = z.string().refine(value => {
  try { safeModulePath(value); return true; } catch { return false; }
}, 'Invalid module-relative path');
export const manifestSchema = z.object({
  apiVersion: z.literal(1), id: idSchema, name: z.string().trim().min(1).max(200),
  version: versionSchema, backend: pathSchema,
  roles: z.array(z.object({
    id: idSchema, name: z.string().trim().min(1).max(200), description: z.string().max(4000).optional(),
    instructions: pathSchema.optional(), skillDirectories: z.array(pathSchema).max(64).optional(),
    mcpServers: z.record(idSchema, z.object({
      type: z.literal('http'),
      path: z.string().refine(value => value.startsWith('/') && (() => { try { safeModulePath(value.slice(1)); return true; } catch { return false; } })(), 'Invalid module API path'),
      tools: z.array(z.string().min(1).max(200)).max(256),
    }).strict()).optional(),
  }).strict()).max(64).refine(roles => new Set(roles.map(role => role.id)).size === roles.length, 'Duplicate role ID').optional(),
  frontend: z.object({
    entry: pathSchema, styles: z.array(pathSchema).max(64).optional(), assets: z.array(pathSchema).min(1).max(128),
    worker: pathSchema.optional(),
  }).strict().optional(),
}).strict();
const selectionSchema = z.object({
  version: versionSchema, digest: digestSchema, enabled: z.boolean(), config: z.record(z.unknown()).default({}),
}).strict();
export const settingsSchema = z.object({ apiVersion: z.literal(1), selected: z.record(idSchema, selectionSchema) }).strict();
const recordSchema = z.object({
  apiVersion: z.literal(1), manifest: manifestSchema, digest: digestSchema,
  files: z.record(pathSchema, z.object({ bytes: z.number().int().nonnegative().max(MODULE_LIMITS.file), sha256: digestSchema }).strict()),
}).strict();
export type ModuleSelection = z.infer<typeof selectionSchema>;
export type ModuleSettings = z.infer<typeof settingsSchema>;
export type ModuleInstallation = z.infer<typeof recordSchema> & { root: string };

export function modulePaths(hostRoot = cockpitHome()) {
  if (!hostRoot.trim() || !isAbsolute(hostRoot)) throw new Error('Module host root must be absolute and nonempty');
  const root = join(resolve(hostRoot), 'modules');
  return { hostRoot: resolve(hostRoot), root, installed: join(root, 'installed'), data: join(root, 'data'), config: join(root, 'config.json') };
}

const sha256 = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

export async function directory(path: string, create: boolean): Promise<void> {
  if (create) {
    try { await lstat(path); }
    catch (error) {
      if (!missing(error)) throw error;
      await directory(dirname(resolve(path)), true);
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error(`Module storage directory must not be a symlink: ${path}`);
  }
}

export async function moduleDataRoot(id: string, hostRoot = cockpitHome()): Promise<string> {
  idSchema.parse(id);
  const paths = modulePaths(hostRoot);
  for (const path of [paths.hostRoot, paths.root, paths.data, join(paths.data, id)]) await directory(path, true);
  return join(paths.data, id);
}

export async function regularBytes(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error('Expected a bounded, unlinked regular module file');
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const next = await file.read(buffer, size, buffer.length - size, null);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size !== info.size) throw new Error('Module file changed while reading');
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}

export async function readModuleSettings(hostRoot = cockpitHome()): Promise<ModuleSettings> {
  const paths = modulePaths(hostRoot);
  try {
    await directory(paths.root, false);
    return settingsSchema.parse(JSON.parse((await regularBytes(paths.config, 1024 * 1024)).toString('utf8')));
  } catch (error) {
    if (missing(error)) return { apiVersion: 1, selected: {} };
    throw error;
  }
}

function tarString(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? buffer : buffer.subarray(0, end));
}
function tarNumber(buffer: Buffer): number {
  const text = tarString(buffer).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Unsupported tar numeric field');
  const result = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(result)) throw new Error('Oversized tar numeric field');
  return result;
}

/** Decode and validate the entire archive before writing anything or importing executable code. */
export function inspectModuleArchive(archive: Buffer): { manifest: ModuleManifest; files: Map<string, Buffer>; digest: string } {
  if (archive.length > MODULE_LIMITS.archive) throw new Error('Module archive exceeds size limit');
  const tar = gunzipSync(archive, { maxOutputLength: MODULE_LIMITS.expanded });
  const entries = new Map<string, { directory: boolean; bytes: Buffer }>();
  let offset = 0;
  let count = 0;
  let terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every(byte => byte === 0)) throw new Error('Invalid tar terminator');
      terminated = true;
      break;
    }
    if (++count > MODULE_LIMITS.entries) throw new Error('Module archive contains too many entries');
    const expected = tarNumber(header.subarray(148, 156));
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== expected) throw new Error('Invalid tar checksum');
    const magic = tarString(header.subarray(257, 263));
    if (magic && magic !== 'ustar' && magic !== 'ustar ') throw new Error('Unsupported tar format');
    const kind = header[156];
    if (kind !== 0 && kind !== 48 && kind !== 53) throw new Error('Module archive permits only regular files and directories; links and extended headers are forbidden');
    if (tarString(header.subarray(157, 257))) throw new Error('Module archive link target is forbidden');
    const prefix = tarString(header.subarray(345, 500));
    let name = `${prefix ? `${prefix}/` : ''}${tarString(header.subarray(0, 100))}`;
    if (name.startsWith('./')) name = name.slice(2);
    const isDirectory = kind === 53;
    if (isDirectory && name.endsWith('/')) name = name.slice(0, -1);
    const size = tarNumber(header.subarray(124, 136));
    if (size > MODULE_LIMITS.file || (isDirectory && size)) throw new Error('Invalid module archive entry size');
    const end = offset + 512 + size;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new Error('Truncated module archive');
    if (name || !isDirectory) {
      safeModulePath(name);
      if (entries.has(name)) throw new Error('Duplicate module archive path');
      entries.set(name, { directory: isDirectory, bytes: tar.subarray(offset + 512, end) });
    }
    offset = next;
  }
  if (!terminated) throw new Error('Unterminated module archive');
  const npmPrefix = !entries.has(MANIFEST_FILE) && entries.has(`package/${MANIFEST_FILE}`);
  const files = new Map<string, Buffer>();
  for (const [rawPath, value] of entries) {
    if (npmPrefix && rawPath === 'package' && value.directory) continue;
    if (npmPrefix && !rawPath.startsWith('package/')) throw new Error('Mixed package roots');
    const path = npmPrefix ? rawPath.slice(8) : rawPath;
    for (let parent = dirname(rawPath); parent !== '.'; parent = dirname(parent)) {
      if (entries.get(parent)?.directory === false) throw new Error('Module file shadows a parent directory');
    }
    if (!value.directory) files.set(path, value.bytes);
  }
  const manifestFile = files.get(MANIFEST_FILE);
  if (!manifestFile || manifestFile.length > 64 * 1024) throw new Error(`Missing or oversized ${MANIFEST_FILE}`);
  const manifest = manifestSchema.parse(JSON.parse(manifestFile.toString('utf8')));
  validateManifestFiles(manifest, files.keys(), manifest.frontend?.worker ? files.get(manifest.frontend.worker)?.length : undefined);
  return { manifest, files, digest: sha256(archive) };
}

export function isDeclaredAsset(manifest: ModuleManifest, path: string): boolean {
  return !!manifest.frontend?.assets.some(root => path === root || path.startsWith(`${root}/`));
}

function validateManifestFiles(manifest: ModuleManifest, paths: Iterable<string>, workerBytes?: number): void {
  const files = new Set(paths);
  if (!files.has(manifest.backend) || !/\.(?:mjs|cjs|js)$/.test(manifest.backend)) throw new Error('Backend entry must be a packaged JavaScript file');
  if (!manifest.frontend) return;
  for (const path of [manifest.frontend.entry, ...manifest.frontend.styles ?? [], ...manifest.frontend.worker ? [manifest.frontend.worker] : []]) {
    if (!files.has(path) || !isDeclaredAsset(manifest, path)) throw new Error('Frontend entry/styles must exist under declared asset roots');
  }
  if (!/\.(?:mjs|js)$/.test(manifest.frontend.entry)
    || manifest.frontend.styles?.some(path => !path.endsWith('.css'))
    || (manifest.frontend.worker && !/\.js$/.test(manifest.frontend.worker))) throw new Error('Invalid frontend JavaScript/CSS entry');
  if (manifest.frontend.worker && (workerBytes === undefined || workerBytes > MODULE_WORKER_LIMIT)) {
    throw new Error('Module worker exceeds its 1 MiB limit');
  }
  for (const root of manifest.frontend.assets) {
    if (![...files].some(path => path === root || path.startsWith(`${root}/`))) throw new Error('Declared asset root does not exist');
  }
}

function installRoot(hostRoot: string, id: string, version: string, digest: string): string {
  idSchema.parse(id); versionSchema.parse(version); digestSchema.parse(digest);
  return join(modulePaths(hostRoot).installed, id, version, digest);
}

export async function readModuleInstallation(id: string, selection: Pick<ModuleSelection, 'version' | 'digest'>, hostRoot = cockpitHome()): Promise<ModuleInstallation> {
  const paths = modulePaths(hostRoot);
  const base = installRoot(hostRoot, id, selection.version, selection.digest);
  for (const path of [paths.root, paths.installed, join(paths.installed, id), join(paths.installed, id, selection.version), base]) await directory(path, false);
  const record = recordSchema.parse(JSON.parse((await regularBytes(join(base, 'install.json'), 4 * 1024 * 1024)).toString('utf8')));
  if (record.manifest.id !== id || record.manifest.version !== selection.version || record.digest !== selection.digest) throw new Error('Installed module identity mismatch');
  const root = join(base, 'package');
  const seen = new Set<string>();
  const walk = async (path: string, relative = ''): Promise<void> => {
    await directory(path, false);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      safeModulePath(name);
      if (entry.isDirectory()) await walk(join(path, entry.name), name);
      else {
        const expected = record.files[name];
        if (!expected || !entry.isFile() || seen.size >= MODULE_LIMITS.entries) throw new Error('Unexpected installed module file');
        const bytes = await regularBytes(join(path, entry.name), MODULE_LIMITS.file);
        if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error('Installed module integrity check failed');
        seen.add(name);
      }
    }
  };
  await walk(root);
  if (seen.size !== Object.keys(record.files).length) throw new Error('Installed module file is missing');
  const manifest = manifestSchema.parse(JSON.parse((await regularBytes(join(root, MANIFEST_FILE), 64 * 1024)).toString('utf8')));
  if (JSON.stringify(manifest) !== JSON.stringify(record.manifest)) throw new Error('Installed manifest identity mismatch');
  validateManifestFiles(manifest, seen, manifest.frontend?.worker ? record.files[manifest.frontend.worker]?.bytes : undefined);
  return { ...record, root };
}

export async function assertNoModuleMigration(hostRoot: string): Promise<void> {
  const root = modulePaths(hostRoot).root;
  try {
    await directory(root, false);
    await lstat(join(root, '.migration.json'));
  }
  catch (error) { if (missing(error)) return; throw error; }
  throw new Error('Module identity migration is pending; explicitly resume it before starting the host or changing modules');
}

export async function withStorageLock<T>(hostRoot: string, work: () => Promise<T>, options: { allowMigration?: boolean } = {}): Promise<T> {
  const paths = modulePaths(hostRoot);
  for (const path of [paths.hostRoot, paths.root, paths.installed]) await directory(path, true);
  const lock = join(paths.root, '.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    if (!options.allowMigration) await assertNoModuleMigration(hostRoot);
    return await work();
  }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function writeSettings(settings: ModuleSettings, hostRoot: string): Promise<void> {
  const paths = modulePaths(hostRoot);
  await writeModuleBytes(paths.config, `${JSON.stringify(settingsSchema.parse(settings), null, 2)}\n`);
}

export async function syncModuleDirectory(path: string): Promise<void> {
  const parent = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function writeModuleBytes(destination: string, bytes: string, stagingRoot = dirname(destination)): Promise<void> {
  const root = dirname(destination);
  const file = join(stagingRoot, `.metadata-${randomUUID()}.pending`);
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await rename(file, destination);
    await syncModuleDirectory(root);
  } finally { await handle.close(); await rm(file, { force: true }); }
}

async function removeUnpublishedStaging(staging: string): Promise<void> {
  const restoreOwnerAccess = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unpublished module staging directory was replaced');
    await chmod(path, info.mode | 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await restoreOwnerAccess(join(path, entry.name));
    }
  };
  await directory(staging, false);
  await restoreOwnerAccess(staging);
  await rm(staging, { recursive: true, force: true });
}

/** Rejects URI-like inputs; a Windows drive-letter path is local only on win32. */
export function isLocalPackagePath(packagePath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' && /^[A-Za-z]:[\\/]/.test(packagePath) && win32.isAbsolute(packagePath)) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(packagePath);
}

export async function installLocalModule(packagePath: string, options: { trustLocalCode: boolean; enable?: boolean; hostRoot?: string }): Promise<ModuleInstallation> {
  if (options.trustLocalCode !== true) throw new Error('Installing executable local code requires --trust-local-code');
  if (!packagePath.endsWith('.tgz') || !isLocalPackagePath(packagePath)) throw new Error('Only an explicitly chosen local .tgz module package is supported');
  const archive = await regularBytes(resolve(packagePath), MODULE_LIMITS.archive);
  const inspected = inspectModuleArchive(archive);
  const hostRoot = options.hostRoot ?? cockpitHome();
  return withStorageLock(hostRoot, async () => {
    const { manifest, digest, files } = inspected;
    const base = installRoot(hostRoot, manifest.id, manifest.version, digest);
    const versionRoot = dirname(base);
    await directory(join(modulePaths(hostRoot).installed, manifest.id), true);
    await directory(versionRoot, true);
    const existing = await readdir(versionRoot);
    if (existing.some(name => name !== digest)) throw new Error('This module version is already installed with a different digest; publish a new version');
    if (!existing.includes(digest)) {
      const staging = join(modulePaths(hostRoot).root, `.install-${randomUUID()}`);
      const root = join(staging, 'package');
      await mkdir(staging, { mode: 0o700 });
      try {
        await mkdir(root, { mode: 0o700 });
        for (const [path, bytes] of files) {
          await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
          const handle = await open(join(root, path), 'wx', 0o444);
          try { await handle.writeFile(bytes); } finally { await handle.close(); }
        }
        const record = { apiVersion: 1 as const, manifest, digest, files: Object.fromEntries([...files].map(([path, bytes]) => [path, { bytes: bytes.length, sha256: sha256(bytes) }])) };
        const handle = await open(join(staging, 'install.json'), 'wx', 0o444);
        try { await handle.writeFile(JSON.stringify(record)); } finally { await handle.close(); }
        const seal = async (path: string): Promise<void> => {
          for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await seal(join(path, entry.name));
          await chmod(path, 0o555);
        };
        await seal(root);
        await rename(staging, base);
      } catch (error) {
        try { await removeUnpublishedStaging(staging); }
        catch (cleanup) {
          // The publication failure is the primary cause; errors[] retains the cleanup failure.
          // eslint-disable-next-line preserve-caught-error
          throw new AggregateError([error, cleanup], 'Module installation failed and unpublished staging cleanup failed', { cause: error });
        }
        throw error;
      }
    }
    const result = await readModuleInstallation(manifest.id, { version: manifest.version, digest }, hostRoot);
    if (options.enable) {
      const settings = await readModuleSettings(hostRoot);
      settings.selected[manifest.id] = { version: manifest.version, digest, enabled: true, config: settings.selected[manifest.id]?.config ?? {} };
      await writeSettings(settings, hostRoot);
    }
    return result;
  });
}

export async function selectModule(id: string, options: { enabled: boolean; version?: string; digest?: string; config?: Record<string, unknown>; hostRoot?: string }): Promise<ModuleSelection> {
  idSchema.parse(id);
  const hostRoot = options.hostRoot ?? cockpitHome();
  return withStorageLock(hostRoot, async () => {
    const settings = await readModuleSettings(hostRoot);
    const previous = settings.selected[id];
    let version = options.version;
    let digest = options.digest;
    if (!version && !digest && previous) { version = previous.version; digest = previous.digest; }
    if (!version || !digest) {
      const choices = (await listInstalledModules(hostRoot)).filter(value => value.id === id
        && (!version || value.version === version) && (!digest || value.digest === digest));
      if (choices.length !== 1) throw new Error('Select an installed --version and --digest explicitly; installation is missing or ambiguous');
      version = choices[0]!.version;
      digest = choices[0]!.digest;
    }
    await readModuleInstallation(id, { version, digest }, hostRoot);
    const selection = selectionSchema.parse({ version, digest, enabled: options.enabled, config: options.config ?? previous?.config ?? {} });
    settings.selected[id] = selection;
    await writeSettings(settings, hostRoot);
    return selection;
  });
}

export async function listInstalledModules(hostRoot = cockpitHome()): Promise<Array<{ id: string; version: string; digest: string }>> {
  const installed = modulePaths(hostRoot).installed;
  const result: Array<{ id: string; version: string; digest: string }> = [];
  try {
    await directory(installed, false);
    for (const id of await readdir(installed)) {
      idSchema.parse(id);
      await directory(join(installed, id), false);
      for (const version of await readdir(join(installed, id))) {
        versionSchema.parse(version);
        await directory(join(installed, id, version), false);
        for (const digest of await readdir(join(installed, id, version))) {
          digestSchema.parse(digest);
          await directory(join(installed, id, version, digest), false);
          result.push({ id, version, digest });
        }
      }
    }
  } catch (error) { if (!missing(error)) throw error; }
  return result.sort((a, b) => `${a.id}/${a.version}/${a.digest}`.localeCompare(`${b.id}/${b.version}/${b.digest}`));
}
