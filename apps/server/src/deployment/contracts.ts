import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.string().regex(/^[a-f0-9]{40}$/);
const absolute = z.string().max(4000).refine(value => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value), 'Expected an absolute path');
export const relative = z.string().min(1).max(1024).refine(value =>
  !isAbsolute(value) && !/[\\:\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe relative path');
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const loopback = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
}, 'Expected a loopback HTTP origin');

export const DeploymentConfig = z.object({
  format: z.literal(1),
  stateRoot: absolute,
  plansRoot: absolute,
  tokenFile: absolute,
  port: z.number().int().min(0).max(65535),
  host: z.object({
    origin: loopback, home: absolute, installRoot: absolute, currentLink: absolute,
    node: absolute,
    service: z.object({
      scope: z.enum(['user', 'system']), unit: z.string().regex(/^[a-zA-Z0-9_-]+\.service$/),
      systemctl: absolute,
    }).strict(),
  }).strict(),
  limits: z.object({
    requestMs: z.number().int().min(100).max(120000).default(30000),
    startMs: z.number().int().min(100).max(600000).default(60000),
    hookMs: z.number().int().min(100).max(600000).default(120000),
    backupBytes: z.number().int().min(1024).max(100 * 1024 ** 3).default(10 * 1024 ** 3),
  }).strict().default({}),
}).strict();
export type DeploymentConfig = z.infer<typeof DeploymentConfig>;

export const ReleaseTarget = z.object({
  repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
  sourceSha: source, version,
  asset: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:tgz|tar\.gz)$/),
  sha256: digest,
}).strict().refine(value => value.tag === `v${value.version}`, 'Tag and version differ');
export type ReleaseTarget = z.infer<typeof ReleaseTarget>;

const hook = z.object({
  entry: relative,
  args: z.array(z.union([
    z.string().max(4000),
    z.object({ path: z.enum(['data', 'plan']) }).strict(),
  ])).max(32),
  expected: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).refine(value => Object.keys(value).length > 0),
}).strict();
const database = z.object({
  path: relative, schema: z.number().int().nonnegative(),
  preserve: z.array(z.object({
    table: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    columns: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)).min(1).max(64),
  }).strict()).max(128).default([]),
}).strict();
const migration = z.object({
  database: relative, from: z.number().int().nonnegative(), to: z.number().int().nonnegative(),
  nondestructive: z.literal(true),
  preflight: hook, apply: hook,
  plan: z.object({ file: relative, sha256: digest }).strict().optional(),
}).strict().refine(value => value.to > value.from, 'Only explicit forward migrations are supported');

export const DeploymentPlan = z.object({
  format: z.literal(1), id,
  host: ReleaseTarget,
  // An operator-reviewed exact pairing, not inferred from independent Latest releases.
  modules: z.record(id, z.object({
    release: ReleaseTarget,
    compatibleHost: version,
    requiredIntents: z.array(z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/)).max(128),
    databases: z.array(database).max(32),
    migrations: z.array(migration).max(16).default([]),
  }).strict()),
  reviewedBy: z.string().trim().min(1).max(200),
  writers: z.literal('only-the-managed-host'),
}).strict().superRefine((plan, context) => {
  for (const [name, module] of Object.entries(plan.modules)) {
    if (module.compatibleHost !== plan.host.version) context.addIssue({
      code: 'custom', path: ['modules', name, 'compatibleHost'], message: 'Module pairing does not declare this exact host version',
    });
    const paths = new Set(module.databases.map(db => db.path));
    if (paths.size !== module.databases.length) context.addIssue({ code: 'custom', message: 'Duplicate database path' });
    const migrated = new Set<string>();
    for (const migration of module.migrations) {
      if (!paths.has(migration.database) || migrated.has(migration.database)
        || module.databases.find(db => db.path === migration.database)?.schema !== migration.to) {
        context.addIssue({ code: 'custom', message: 'Each migration must target one declared database and its final schema' });
      }
      migrated.add(migration.database);
    }
  }
});
export type DeploymentPlan = z.infer<typeof DeploymentPlan>;
export type Migration = DeploymentPlan['modules'][string]['migrations'][number];

export const PinnedRelease = z.object({
  ...ReleaseTarget.innerType().shape,
  releaseId: z.number().int().positive(), assetId: z.number().int().positive(),
  assetSize: z.number().int().positive(), publishedAt: z.string(),
}).strict();
export type PinnedRelease = z.infer<typeof PinnedRelease>;
export type Check = { name: string; status: 'passed' | 'failed' | 'not-covered'; detail: string };
export type Instance = { instanceId: string; version: string; sourceSha: string | null; pid: number };
export type Phase = 'accepted' | 'preparing' | 'prepared' | 'stopping' | 'backing-up' | 'migrating' | 'switching' | 'starting' | 'verifying' | 'finished';
export type State = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
const phase = z.enum(['accepted', 'preparing', 'prepared', 'stopping', 'backing-up', 'migrating', 'switching', 'starting', 'verifying', 'finished']);
const instance = z.object({ instanceId: z.string(), version: z.string(), sourceSha: z.string().nullable(), pid: z.number().int().positive() }).strict();
export const DeploymentReceipt = z.object({
  format: z.literal(1), id, planId: id, planSha256: digest, sequence: z.number().int().nonnegative(),
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']), phase,
  createdAt: z.string(), updatedAt: z.string(),
  events: z.array(z.object({ phase, at: z.string() }).strict()).max(1000),
  releases: z.record(PinnedRelease), oldInstance: instance.optional(), newInstance: instance.optional(),
  changed: z.boolean().optional(), backups: z.array(z.string()).max(128),
  checks: z.array(z.object({
    name: z.string(), status: z.enum(['passed', 'failed', 'not-covered']), detail: z.string(),
  }).strict()).max(1000),
  error: z.string().nullable(), attentionRequired: z.boolean(), recovery: z.string(),
}).strict();
export type DeploymentReceipt = z.infer<typeof DeploymentReceipt>;
