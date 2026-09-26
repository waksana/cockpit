import { backup, DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DeploymentConfig, DeploymentPlan, Migration } from './contracts.ts';
import { hash, missing, plainTree, privateBytes } from './files.ts';
import { command } from './systemd.ts';
import { directory, regularBytes, syncModuleDirectory } from '../module-install.ts';

type ModulePlan = DeploymentPlan['modules'][string];
type DatabasePlan = ModulePlan['databases'][number];
export interface DatabaseFacts { schema: number; preserved: Record<string, string> }

export function databaseFacts(path: string, spec: DatabasePlan): DatabaseFacts {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || Object.values(check[0]!)[0] !== 'ok') throw new Error(`Database integrity check failed: ${spec.path}`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`Database foreign key check failed: ${spec.path}`);
    const schema = db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof schema !== 'number') throw new Error('Invalid database schema observation');
    const preserved: Record<string, string> = {};
    for (const item of spec.preserve) {
      const rows = db.prepare(`SELECT ${item.columns.map(name => `"${name}"`).join(',')} FROM "${item.table}"`).all();
      const serialized = rows.map(row => JSON.stringify(row, (_key, value) =>
        typeof value === 'bigint' ? { integer: String(value) } : value)).sort();
      preserved[item.table] = hash(JSON.stringify(serialized));
    }
    return { schema, preserved };
  } finally { db.close(); }
}

export async function snapshotData(source: string, destination: string, module: ModulePlan, maximum: number): Promise<Record<string, DatabaseFacts>> {
  const files = await plainTree(source, maximum);
  await mkdir(destination, { mode: 0o700 });
  const databases = new Set(module.databases.map(value => value.path));
  const related = new Set([...databases].flatMap(path => [path, `${path}-wal`, `${path}-shm`]));
  const facts: Record<string, DatabaseFacts> = {};
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
  }
  for (const spec of module.databases) {
    const from = join(source, spec.path);
    const stat = await lstat(from);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error(`Invalid declared database file: ${spec.path}`);
    facts[spec.path] = databaseFacts(from, spec);
    const to = join(destination, spec.path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(from, { readOnly: true });
    try { await backup(db, to); } finally { db.close(); }
    const copied = databaseFacts(to, spec);
    if (JSON.stringify(copied) !== JSON.stringify(facts[spec.path])) throw new Error('Database changed during consistent backup');
    const handle = await open(to, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  const seal = async (root: string) => {
    for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await seal(join(root, entry.name));
    await syncModuleDirectory(root);
  };
  await seal(destination);
  return facts;
}

export function requiredMigrations(module: ModulePlan, facts: Record<string, DatabaseFacts>): Migration[] {
  const result: Migration[] = [];
  for (const database of module.databases) {
    const current = facts[database.path];
    if (!current) throw new Error(`Database was not backed up: ${database.path}`);
    if (current.schema === database.schema) continue;
    const migration = module.migrations.find(value => value.database === database.path && value.from === current.schema && value.to === database.schema);
    if (!migration) throw new Error(`No explicit forward migration for ${database.path} from schema ${current.schema}`);
    result.push(migration);
  }
  return result;
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
