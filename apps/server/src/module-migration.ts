import { randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cockpitHome } from '@cockpit/core';
import { SessionRole } from '@cockpit/protocol';
import { z } from 'zod';
import {
  assertNoModuleMigration, directory, manifestSchema, modulePaths, readModuleInstallation,
  regularBytes, settingsSchema, syncModuleDirectory, withStorageLock, writeModuleBytes,
} from './module-install.ts';
import { acquireModuleLease } from './module-lifetime.ts';

const METADATA_LIMIT = 1024 * 1024;
const JOURNAL_LIMIT = 16 * 1024 * 1024;
const ROLE_FILES_LIMIT = 2048;
const rolesSchema = SessionRole.strict().array().max(64);
const identitySchema = z.object({
  from: manifestSchema.shape.id, to: manifestSchema.shape.id,
  version: manifestSchema.shape.version, digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.from !== value.to, 'Source and destination IDs must differ');
const roleFileSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}\.json$/);
const journalSchema = z.object({
  apiVersion: z.literal(1), id: z.string().uuid(), identity: identitySchema,
  data: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict().nullable(),
  settings: z.object({ before: z.string().max(METADATA_LIMIT), after: z.string().max(METADATA_LIMIT) }).strict(),
  roles: z.array(z.object({
    file: roleFileSchema, before: z.string().max(METADATA_LIMIT), after: z.string().max(METADATA_LIMIT),
  }).strict()).max(ROLE_FILES_LIMIT),
}).strict();
type Journal = z.infer<typeof journalSchema>;
type Identity = Journal['identity'];
export interface ModuleMigrationOptions {
  hostRoot?: string;
  from: string;
  to: string;
  version: string;
  digest: string;
  offline: boolean;
  mode?: 'plan' | 'apply' | 'resume';
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function dataIdentity(path: string): Promise<Journal['data']> {
  if (!await present(path)) return null;
  await directory(path, false);
  const stat = await lstat(path, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
const sameData = (left: Journal['data'], right: Journal['data']) => JSON.stringify(left) === JSON.stringify(right);
const text = async (path: string) => new TextDecoder('utf-8', { fatal: true }).decode(await regularBytes(path, METADATA_LIMIT));
function metadata<T>(schema: z.ZodType<T>, bytes: string): T {
  try { return schema.parse(JSON.parse(bytes)); }
  catch { throw new Error('Invalid host-owned migration metadata'); }
}

async function roleFiles(hostRoot: string): Promise<string[]> {
  const root = join(hostRoot, 'session-roles');
  if (!await present(root)) return [];
  await directory(root, false);
  if ((await lstat(root)).dev !== (await lstat(modulePaths(hostRoot).root)).dev) throw new Error('Host role metadata must share the module storage filesystem');
  const files = (await readdir(root)).sort();
  if (files.length > ROLE_FILES_LIMIT) throw new Error('Too many host role records for one bounded migration');
  for (const file of files) roleFileSchema.parse(file);
  return files;
}

async function transform(identity: Identity, before: string, roles: Array<{ file: string; before: string }>, hostRoot: string) {
  const target = await readModuleInstallation(identity.to, identity, hostRoot);
  const settings = metadata(settingsSchema, before);
  const source = settings.selected[identity.from];
  if (!source) throw new Error('Source module must have a selected installation');
  if (Object.hasOwn(settings.selected, identity.to)) throw new Error('Destination module is already selected');
  await readModuleInstallation(identity.from, source, hostRoot);
  settings.selected[identity.to] = { ...source, version: identity.version, digest: identity.digest };
  delete settings.selected[identity.from];
  const converted = roles.map(record => {
    const values = metadata(rolesSchema, record.before);
    const seen = new Set<string>();
    for (const value of values) {
      manifestSchema.shape.id.parse(value.moduleId);
      manifestSchema.shape.id.parse(value.roleId);
      const key = `${value.moduleId}/${value.roleId}`;
      if (seen.has(key)) throw new Error('Duplicate role selection in host role record');
      seen.add(key);
      if (value.moduleId === identity.to) throw new Error('Destination module already has host role references');
    }
    const changed = values.some(role => role.moduleId === identity.from);
    const next = values.map(role => {
      if (role.moduleId !== identity.from) return role;
      const definition = target.manifest.roles?.find(candidate => candidate.id === role.roleId);
      if (!definition) throw new Error('Destination module lacks a referenced source role ID');
      return { ...role, moduleId: identity.to, moduleName: target.manifest.name, name: definition.name };
    });
    return { ...record, after: changed ? JSON.stringify(next) : record.before };
  });
  const after = `${JSON.stringify(settings, null, 2)}\n`;
  if ([after, ...converted.map(role => role.after)].some(value => Buffer.byteLength(value) > METADATA_LIMIT)) {
    throw new Error('Converted host metadata exceeds size limit');
  }
  return { settings: { before, after }, roles: converted };
}

async function plan(identity: Identity, hostRoot: string): Promise<Journal> {
  const paths = modulePaths(hostRoot);
  const source = join(paths.data, identity.from), target = join(paths.data, identity.to);
  if (await present(paths.data)) await directory(paths.data, false);
  if (await present(target)) throw new Error('Destination data root already exists; stores cannot be merged');
  const data = await dataIdentity(source);
  if (data && data.dev !== (await lstat(paths.data, { bigint: true })).dev.toString()) {
    throw new Error('Module data root must share its parent filesystem for directory rename');
  }
  const records = [];
  let bytes = 0;
  for (const file of await roleFiles(hostRoot)) {
    const before = await text(join(hostRoot, 'session-roles', file));
    bytes += Buffer.byteLength(before);
    if (bytes > JOURNAL_LIMIT / 3) throw new Error('Host role metadata exceeds bounded migration journal');
    records.push({ file, before });
  }
  const transformed = await transform(identity, await text(paths.config), records, hostRoot);
  return journalSchema.parse({ apiVersion: 1, id: randomUUID(), identity, data, ...transformed });
}

async function validateRecovery(journal: Journal, hostRoot: string): Promise<void> {
  const paths = modulePaths(hostRoot);
  const files = await roleFiles(hostRoot);
  if (JSON.stringify(files) !== JSON.stringify(journal.roles.map(record => record.file))) throw new Error('Host role inventory drifted; recovery refused');
  const expected = await transform(journal.identity, journal.settings.before, journal.roles, hostRoot);
  if (expected.settings.after !== journal.settings.after
    || expected.roles.some((role, index) => role.after !== journal.roles[index]!.after)) throw new Error('Migration journal transformation does not match verified installations');
  for (const record of [{ file: paths.config, ...journal.settings },
    ...journal.roles.map(role => ({ ...role, file: join(hostRoot, 'session-roles', role.file) }))]) {
    const current = await text(record.file);
    if (current !== record.before && current !== record.after) throw new Error('Host metadata drifted; recovery refused');
  }

  if (await present(paths.data)) await directory(paths.data, false);
  const source = await dataIdentity(join(paths.data, journal.identity.from));
  const target = await dataIdentity(join(paths.data, journal.identity.to));
  if (journal.data
    ? !((sameData(source, journal.data) && target === null) || (source === null && sameData(target, journal.data)))
    : source !== null || target !== null) throw new Error('Module data location drifted; recovery refused');
}

async function prepareStaging(path: string): Promise<void> {
  await directory(path, true);
  if ((await lstat(path)).mode & 0o077) throw new Error('Migration staging directory must be private');
  const files = await readdir(path);
  if (files.length > ROLE_FILES_LIMIT + 1) throw new Error('Unexpected migration staging inventory');
  for (const file of files) {
    if (!/^\.metadata-[a-f0-9-]{36}\.pending$/.test(file)) throw new Error('Unexpected migration staging file');
    await regularBytes(join(path, file), METADATA_LIMIT);
  }
  for (const file of files) await rm(join(path, file));
  await syncModuleDirectory(path);
}

/**
 * Only host-owned metadata is read. Business data is moved as one directory,
 * never inspected; native session history/configuration is outside this API.
 */
export async function migrateModuleId(options: ModuleMigrationOptions) {
  if (process.platform !== 'linux') throw new Error('Module ID migration requires Linux abstract-socket fencing');
  if (options.offline !== true) throw new Error('--offline must acknowledge that every old/noncooperating host using this root is stopped');
  const identity = identitySchema.parse({ from: options.from, to: options.to, version: options.version, digest: options.digest });
  const mode = options.mode ?? 'plan';
  if (!['plan', 'apply', 'resume'].includes(mode)) throw new Error('Invalid migration mode');
  const hostRoot = modulePaths(options.hostRoot ?? cockpitHome()).hostRoot;
  const paths = modulePaths(hostRoot);
  for (const path of [hostRoot, paths.root, paths.installed]) await directory(path, false);
  const release = await acquireModuleLease(hostRoot);
  try {
    const execute = async () => {
      const pending = join(paths.root, '.migration.json');
      let journal: Journal;
      if (mode === 'resume') {
        journal = metadata(journalSchema, new TextDecoder('utf-8', { fatal: true }).decode(await regularBytes(pending, JOURNAL_LIMIT)));
        if (JSON.stringify(journal.identity) !== JSON.stringify(identity)) throw new Error('Resume parameters do not match the pending migration');
      } else {
        await assertNoModuleMigration(hostRoot);
        journal = await plan(identity, hostRoot);
      }
      const bytes = `${JSON.stringify(journal)}\n`;
      if (Buffer.byteLength(bytes) > JOURNAL_LIMIT) throw new Error('Migration journal exceeds size limit');
      const summary = {
        from: identity.from, to: identity.to, version: identity.version, digest: identity.digest,
        mode, sourceData: journal.data ? 'move-directory' : 'absent-no-directory-created',
        changedRoleRecords: journal.roles.filter(role => role.before !== role.after).length,
        nativeSessionsChanged: false, aliasesCreated: false,
      };
      if (mode === 'plan') return { ...summary, applied: false };
      await validateRecovery(journal, hostRoot);
      const backup = join(paths.root, `.migration-completed-${journal.id}.json`);
      if (await present(backup)) throw new Error('Migration backup already exists; refusing to overwrite');
      if (mode === 'apply') await writeModuleBytes(pending, bytes);
      const staging = join(paths.root, `.migration-staging-${journal.id}`);
      await prepareStaging(staging);
      await syncModuleDirectory(paths.root);
      // The durable journal blocks startup before the first cutover. Every step
      // is idempotent only for its exact recorded before/after state.
      if (journal.data && await present(join(paths.data, identity.from))) {
        await rename(join(paths.data, identity.from), join(paths.data, identity.to));
        await syncModuleDirectory(paths.data);
      }
      for (const role of journal.roles) {
        if (role.before !== role.after) await writeModuleBytes(join(hostRoot, 'session-roles', role.file), role.after, staging);
      }
      await writeModuleBytes(paths.config, journal.settings.after, staging);
      await validateRecovery(journal, hostRoot);
      await rmdir(staging);
      await rename(pending, backup);
      await syncModuleDirectory(paths.root);
      return { ...summary, applied: true, backup };
    };
    return mode === 'plan' ? await execute() : await withStorageLock(hostRoot, execute, { allowMigration: true });
  } finally { await release(); }
}
