import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DeploymentConfig, DeploymentPlan, Migration } from './contracts.ts';
import { fileHash, hash, missing, plainTree, privateBytes } from './files.ts';
import { command } from './systemd.ts';
import { directory, regularBytes, syncModuleDirectory } from '../module-install.ts';

type ModulePlan = DeploymentPlan['modules'][string];
type DatabasePlan = ModulePlan['databases'][number];
export interface DatabaseFacts { schema: number; preserved: Record<string, string> }
export interface DataSnapshot {
  databases: Record<string, DatabaseFacts>;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export async function syncBackupTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await syncBackupTree(join(root, entry.name));
  await syncModuleDirectory(root);
}

export async function databaseFacts(path: string, spec: DatabasePlan): Promise<DatabaseFacts> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const check = db.prepare('PRAGMA integrity_check').get();
    if (!check || Object.values(check)[0] !== 'ok') throw new Error(`Database integrity check failed: ${spec.path}`);
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error(`Database foreign key check failed: ${spec.path}`);
    const schema = db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof schema !== 'number') throw new Error('Invalid database schema observation');
    const preserved: Record<string, string> = {};
    for (const item of spec.preserve) {
      const columns = item.columns.map(name => `"${name}"`);
      const rows = db.prepare(`SELECT ${columns.join(',')} FROM "${item.table}" ORDER BY ${columns.map(name => `${name} COLLATE BINARY`).join(',')}`);
      rows.setReadBigInts(true);
      const sum = createHash('sha256');
      let count = 0;
      for (const row of rows.iterate()) {
        sum.update(JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? { integer: String(value) } : value));
        sum.update('\n');
        if (++count % 1000 === 0) await yieldToEvents();
      }
      preserved[item.table] = sum.digest('hex');
    }
    db.exec('COMMIT');
    return { schema, preserved };
  } finally { db.close(); }
}

export async function snapshotData(source: string, destination: string, module: ModulePlan, maximum: number): Promise<DataSnapshot> {
  const files = await plainTree(source, maximum);
  await mkdir(destination, { mode: 0o700 });
  const databases = new Set(module.databases.map(value => value.path));
  const related = new Set([...databases].flatMap(path => [path, `${path}-wal`, `${path}-shm`]));
  const facts: Record<string, DatabaseFacts> = {};
  const preserved: DataSnapshot['files'] = [];
  for (const file of files) {
    if (related.has(file.path)) continue;
    const from = join(source, file.path);
    const header = await open(from, 'r');
    const bytes = Buffer.alloc(16);
    try { await header.read(bytes, 0, bytes.length, 0); } finally { await header.close(); }
    if (bytes.toString('ascii') === 'SQLite format 3\0' || /(?:-wal|-shm)$/.test(file.path)) {
      throw new Error(`Undeclared database or WAL path: ${file.path}`);
    }
    const to = join(destination, file.path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(from, to);
    const handle = await open(to, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (await fileHash(to) !== file.sha256 || await fileHash(from) !== file.sha256) throw new Error(`Module file changed during backup: ${file.path}`);
    preserved.push(file);
  }
  for (const spec of module.databases) {
    const from = join(source, spec.path);
    const stat = await lstat(from);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error(`Invalid declared database file: ${spec.path}`);
    facts[spec.path] = await databaseFacts(from, spec);
    const to = join(destination, spec.path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(from, { readOnly: true });
    try { await backup(db, to); } finally { db.close(); }
    const copied = await databaseFacts(to, spec);
    if (JSON.stringify(copied) !== JSON.stringify(facts[spec.path])) throw new Error('Database changed during consistent backup');
    const handle = await open(to, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncBackupTree(destination);
  await syncModuleDirectory(dirname(destination));
  return { databases: facts, files: preserved };
}

export function requiredMigrations(module: ModulePlan, snapshot: DataSnapshot): Migration[] {
  const result: Migration[] = [];
  for (const database of module.databases) {
    const current = snapshot.databases[database.path];
    if (!current) throw new Error(`Database was not backed up: ${database.path}`);
    if (current.schema === database.schema) continue;
    const migration = module.migrations.find(value => value.database === database.path && value.from === current.schema && value.to === database.schema);
    if (!migration) throw new Error(`No explicit forward migration for ${database.path} from schema ${current.schema}`);
    for (const file of migration.files) {
      if (snapshot.files.find(entry => entry.path === file.path)?.sha256 !== file.fromSha256) {
        throw new Error(`Ordinary-file migration input differs from the reviewed digest: ${file.path}`);
      }
    }
    result.push(migration);
  }
  return result;
}

export async function verifyModuleData(source: string, module: ModulePlan, snapshot?: DataSnapshot): Promise<void> {
  const changed = new Map(module.migrations.flatMap(migration => migration.files.map(file => [file.path, file] as const)));
  for (const file of snapshot?.files ?? []) {
    const path = join(source, file.path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || (!changed.has(file.path) && stat.size !== file.size)
      || await fileHash(path) !== (changed.get(file.path)?.toSha256 ?? file.sha256)) {
      throw new Error(`Module file was not preserved: ${file.path}`);
    }
    for (const file of changed.values()) {
      const path = join(source, file.path);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1 || await fileHash(path) !== file.toSha256) {
        throw new Error(`Ordinary-file migration result differs from the reviewed digest: ${file.path}`);
      }
    }
  }
  for (const spec of module.databases) {
    const actual = await databaseFacts(join(source, spec.path), spec);
    if (actual.schema !== spec.schema || (snapshot?.databases[spec.path]
      && JSON.stringify(actual.preserved) !== JSON.stringify(snapshot.databases[spec.path]!.preserved))) {
      throw new Error(`Database schema or preserved records differ: ${spec.path}`);
    }
  }
}

export async function migrationPlan(migration: Migration, plansRoot: string, output: string): Promise<string | undefined> {
  if (!migration.plan) return;
  const path = join(plansRoot, migration.plan.file);
  if (await realpath(path) !== path) throw new Error('Migration plan cannot be linked');
  const bytes = await privateBytes(path, 16 * 1024 ** 2);
  if (hash(bytes) !== migration.plan.sha256) throw new Error('Migration plan differs from its approved digest');
  const handle = await open(output, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return output;
}

export async function runMigration(
  config: DeploymentConfig, moduleRoot: string, migration: Migration, phase: 'preflight' | 'apply',
  dataRoot: string, plan: string | undefined, signal: AbortSignal,
): Promise<void> {
  const hook = migration[phase];
  const entry = join(moduleRoot, hook.entry);
  if (!/\.(?:mjs|cjs|js)$/.test(entry) || await realpath(entry) !== entry) throw new Error('Migration entry must be a packaged, unlinked Node script');
  await regularBytes(entry, 4 * 1024 ** 2);
  const args = hook.args.map(value => {
    if (typeof value === 'string') return value;
    if (value.path === 'data') return dataRoot;
    if (!plan) throw new Error('Migration requires a fixed reviewed plan');
    return plan;
  });
  const text = await command(config.host.node, [entry, ...args], config.limits.hookMs, signal);
  const result: unknown = JSON.parse(text);
  if (!result || typeof result !== 'object' || Object.entries(hook.expected).some(([key, expected]) =>
    !Object.hasOwn(result, key) || Reflect.get(result, key) !== expected)) {
    throw new Error(`Migration ${phase} did not return its declared confirmation`);
  }
}

export async function captureHostFiles(home: string, maximum: number): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of ['config.json', 'instructions.md']) {
    try { result[path] = hash(await regularBytes(join(home, path), maximum)); }
    catch (error) { if (!missing(error)) throw error; }
  }
  for (const entry of await plainTree(join(home, 'session-roles'), maximum)) result[`session-roles/${entry.path}`] = entry.sha256;
  return result;
}

export async function snapshotHostFiles(home: string, destination: string, maximum: number): Promise<Record<string, string>> {
  const files = await captureHostFiles(home, maximum);
  await mkdir(destination, { mode: 0o700 });
  for (const [path, expected] of Object.entries(files)) {
    const bytes = await regularBytes(join(home, path), maximum);
    if (hash(bytes) !== expected) throw new Error(`Host file changed during offline backup: ${path}`);
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const file = await open(target, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }
  await syncBackupTree(destination);
  await syncModuleDirectory(dirname(destination));
  return files;
}

export async function validateSitePaths(config: DeploymentConfig): Promise<void> {
  const { home, installRoot, currentLink, node } = config.host;
  for (const path of [home, installRoot, config.stateRoot, config.plansRoot]) await directory(path, false);
  const roots = [home, installRoot, config.stateRoot, config.plansRoot].map(value => resolve(value));
  if (roots.some((root, index) => roots.some((other, j) => j !== index && (root === other || root.startsWith(`${other}/`))))) {
    throw new Error('Host, installation, plans and deployment state roots must be separate');
  }
  if (dirname(currentLink) !== installRoot || !(await lstat(currentLink)).isSymbolicLink()) throw new Error('Current installation must be a direct symlink in the installation root');
  const executable = await lstat(node);
  if (!executable.isFile() || !executable.size) throw new Error('Configured Node executable is missing');
  await access(node, constants.X_OK);
}
