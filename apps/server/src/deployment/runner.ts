import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  inspectModuleArchive, installLocalModule, isDeclaredAsset, listInstalledModules, readModuleInstallation,
  readModuleSettings, regularBytes, selectModuleSet, syncModuleDirectory,
  type ModuleInstallation,
} from '../module-install.ts';
import { acquireModuleHostLease } from '../module-lifetime.ts';
import type { DeploymentConfig, DeploymentPlan, DeploymentReceipt, Instance, Migration, Phase } from './contracts.ts';
import { captureHostFiles, databaseFacts, migrationPlan, requiredMigrations, runMigration, snapshotData, validateSitePaths, type DatabaseFacts } from './data.ts';
import { hash, privateDirectory, writeJson } from './files.ts';
import { GithubReleases } from './releases.ts';
import { inInstallation, installRuntime, verifyRuntime } from './runtime-package.ts';
import { DeploymentStore } from './store.ts';
import { command, type HostManager } from './systemd.ts';

const version = z.object({ instanceId: z.string().min(1), version: z.string(), sourceSha: z.string().nullable() });
const bootstrap = z.object({
  active: z.array(z.object({ id: z.string(), version: z.string(), digest: z.string() })),
  errors: z.array(z.unknown()),
});
const facts = z.object({ node: z.string(), sdk: z.string(), intents: z.array(z.string()) });
type MigrationWork = { id: string; migration: Migration; plan?: string };

export class DeploymentRunner {
  constructor(
    readonly config: DeploymentConfig,
    readonly store: DeploymentStore,
    readonly manager: HostManager,
    readonly releases = new GithubReleases(config.limits.requestMs, fetch, process.env.GH_TOKEN),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async response(path: string, signal: AbortSignal): Promise<Response> {
    const response = await this.fetcher(new URL(path, this.config.host.origin), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.limits.requestMs)]), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Host ${path} returned HTTP ${response.status}`);
    return response;
  }

  private async instance(signal: AbortSignal): Promise<Instance> {
    const identity = version.parse(await (await this.response('/version', signal)).json());
    const service = await this.manager.inspect();
    if (service.active !== 'active' || !service.pid) throw new Error('Managed host is not active');
    return { ...identity, pid: service.pid };
  }

  private async phase(receipt: DeploymentReceipt, phase: Phase, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.store.save(receipt, phase);
  }

  async execute(receipt: DeploymentReceipt, plan: DeploymentPlan, signal: AbortSignal): Promise<void> {
    let releaseHost: (() => Promise<void>) | undefined;
    const root = this.store.path(receipt.id);
    try {
      await this.phase(receipt, 'preparing', signal);
      await validateSitePaths(this.config);
      const { home, installRoot, currentLink } = this.config.host;
      const oldRoot = await realpath(currentLink);
      if (!inInstallation(installRoot, oldRoot)) throw new Error('Current package is outside the configured installation root');
      const original = await verifyRuntime(oldRoot);
      receipt.oldInstance = await this.instance(signal);
      if (receipt.oldInstance.sourceSha !== original.sourceSha || receipt.oldInstance.version !== original.version) {
        throw new Error('Running host and current installation differ');
      }
      const selected = await readModuleSettings(home);
      const names = Object.keys(selected.selected).sort();
      const installed = [...new Set((await listInstalledModules(home)).map(item => item.id))].sort();
      if (JSON.stringify(names) !== JSON.stringify(installed) || JSON.stringify(names) !== JSON.stringify(Object.keys(plan.modules).sort())) {
        throw new Error('The reviewed plan must include exactly the installed, explicitly selected module set');
      }
      receipt.releases.host = await this.releases.pin(plan.host);
      for (const name of names) receipt.releases[name] = await this.releases.pin(plan.modules[name]!.release);
      await this.store.save(receipt);
      const archives = join(root, 'archives');
      await privateDirectory(archives);
      for (const [name, pin] of Object.entries(receipt.releases)) {
        signal.throwIfAborted();
        await this.releases.download(pin, join(archives, `${name}.tgz`));
      }
      const targetRoot = await installRuntime(join(archives, 'host.tgz'), receipt.releases.host!, installRoot);
      const target = await verifyRuntime(targetRoot, receipt.releases.host);
      if (original.version === target.version && JSON.stringify(original) !== JSON.stringify(target)) {
        throw new Error('The current host version cannot be reused for different package contents');
      }
      const probe = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './candidate.ts' : './candidate.js', import.meta.url));
      const candidate = facts.parse(JSON.parse(await command(this.config.host.node, [probe, targetRoot], this.config.limits.requestMs, signal)));
      if (candidate.node !== target.node) throw new Error('Configured host Node does not match the release');
      const oldSdk = JSON.parse(await readFile(join(oldRoot, 'packages/core/package.json'), 'utf8')).dependencies?.['@github/copilot-sdk'];
      if (oldSdk !== candidate.sdk) throw new Error('Native SDK changes require a separate explicit data-migration contract; this plan cannot infer one');
      const modules = new Map<string, ModuleInstallation>();
      const next = structuredClone(selected);
      for (const name of names) {
        const definition = plan.modules[name]!;
        if (definition.requiredIntents.some(intent => !candidate.intents.includes(intent))) throw new Error(`Required host capability is missing for ${name}`);
        const archive = join(archives, `${name}.tgz`);
        const inspected = inspectModuleArchive(await regularBytes(archive, 32 * 1024 ** 2));
        if (inspected.manifest.id !== name || inspected.manifest.version !== definition.release.version || inspected.digest !== definition.release.sha256) {
          throw new Error(`Module package identity differs from its reviewed release: ${name}`);
        }
        const module = await installLocalModule(archive, { hostRoot: home, trustLocalCode: true });
        modules.set(name, module);
        next.selected[name] = { ...selected.selected[name]!, version: module.manifest.version, digest: module.digest };
      }
      const pinnedPlans = new Map<string, string | undefined>();
      for (const name of names) {
        const definition = plan.modules[name]!;
        const preliminary = join(root, `${name}-preliminary-backup`);
        const observed = await snapshotData(join(home, 'modules', 'data', name), preliminary, definition, this.config.limits.backupBytes);
        for (const migration of requiredMigrations(definition, observed)) {
          const key = `${name}/${migration.database}`;
          const file = await migrationPlan(migration, this.config.plansRoot, join(root, `${name}-${pinnedPlans.size}-approved-plan.json`));
          pinnedPlans.set(key, file);
          await runMigration(this.config, modules.get(name)!.root, migration, 'preflight', preliminary, file, signal);
        }
      }
      const hostFiles = await captureHostFiles(home, this.config.limits.backupBytes);
      const sameHost = JSON.stringify(original) === JSON.stringify(target);
      receipt.changed = !sameHost || JSON.stringify(selected) !== JSON.stringify(next);
      receipt.checks.push({ name: 'release-and-package-preflight', status: 'passed', detail: 'All releases, source commits, inventories, platform and declared module pairing verified' });
      if (!receipt.changed) {
        await this.accept(receipt, plan, oldRoot, modules, selected, hostFiles, {}, signal);
        receipt.state = 'succeeded';
        receipt.recovery = 'The verified target is already loaded; no shutdown, migration or switch was performed.';
        await this.store.save(receipt, 'finished');
        return;
      }
      if (JSON.stringify(await readModuleSettings(home)) !== JSON.stringify(selected)
        || await realpath(currentLink) !== oldRoot
        || (await this.instance(signal)).instanceId !== receipt.oldInstance.instanceId) {
        throw new Error('Host or configuration changed during preparation');
      }
      await this.phase(receipt, 'prepared', signal);
      await this.phase(receipt, 'stopping', signal);
      receipt.attentionRequired = true;
      receipt.recovery = 'Shutdown may have been requested. Inspect the managed service before acting; no automatic restart or data rollback is attempted on failure.';
      await this.store.save(receipt);
      await this.manager.stop();
      // No timeout forces a busy host to exit. Only this run's independent service keeps waiting.
      while (true) {
        signal.throwIfAborted();
        const state = await this.manager.inspect();
        if (!state.pid && ['inactive', 'failed'].includes(state.active)) break;
        await sleep(250, undefined, { signal });
      }
      releaseHost = await acquireModuleHostLease(home);
      await this.phase(receipt, 'backing-up', signal);
      if (await realpath(currentLink) !== oldRoot || JSON.stringify(await readModuleSettings(home)) !== JSON.stringify(selected)) {
        throw new Error('Stopped host selection drifted; no migration or cutover was performed');
      }
      const backups = join(root, 'backup');
      await privateDirectory(backups);
      await writeJson(join(backups, 'module-settings.json'), selected);
      for (const path of Object.keys(hostFiles)) {
        const destination = join(backups, 'host', path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(join(home, path), destination, constants.COPYFILE_EXCL);
      }
      const before: Record<string, Record<string, DatabaseFacts>> = {};
      const migrations: MigrationWork[] = [];
      for (const name of names) {
        const definition = plan.modules[name]!;
        const dataRoot = join(home, 'modules', 'data', name);
        const backup = join(backups, name);
        before[name] = await snapshotData(dataRoot, backup, definition, this.config.limits.backupBytes);
        receipt.backups.push(backup);
        for (const migration of requiredMigrations(definition, before[name]!)) {
          const key = `${name}/${migration.database}`;
          if (!pinnedPlans.has(key)) throw new Error('Migration requirements changed after preflight');
          const file = pinnedPlans.get(key);
          const rehearsal = join(root, `${name}-${migrations.length}-preflight`);
          await snapshotData(backup, rehearsal, definition, this.config.limits.backupBytes);
          await runMigration(this.config, modules.get(name)!.root, migration, 'preflight', rehearsal, file, signal);
          migrations.push({ id: name, migration, plan: file });
        }
      }
      await writeJson(join(backups, 'manifest.json'), { hostFiles, databases: before });
      await this.store.save(receipt);
      await this.phase(receipt, 'migrating', signal);
      for (const work of migrations) {
        await runMigration(this.config, modules.get(work.id)!.root, work.migration, 'apply',
          join(home, 'modules', 'data', work.id), work.plan, signal);
        const spec = plan.modules[work.id]!.databases.find(db => db.path === work.migration.database)!;
        if (databaseFacts(join(home, 'modules', 'data', work.id, spec.path), spec).schema !== spec.schema) {
          throw new Error('Migration confirmation does not match the actual database schema');
        }
      }
      receipt.checks.push({ name: 'backup-and-migrations', status: 'passed', detail: `${names.length} module snapshots; ${migrations.length} explicit forward migrations` });
      await this.phase(receipt, 'switching', signal);
      await selectModuleSet(selected, next, home);
      if (await realpath(currentLink) !== oldRoot || !(await lstat(currentLink)).isSymbolicLink()) throw new Error('Current installation changed before cutover');
      const temporary = join(installRoot, `.current-${receipt.id}`);
      await symlink(targetRoot, temporary);
      await rename(temporary, currentLink);
      await syncModuleDirectory(installRoot);
      await releaseHost(); releaseHost = undefined;
      await this.phase(receipt, 'starting', signal);
      await this.manager.start();
      const deadline = Date.now() + this.config.limits.startMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        try { receipt.newInstance = await this.instance(signal); break; }
        catch (error) { lastError = error; await sleep(100, undefined, { signal }); }
      }
      if (!receipt.newInstance) throw new Error('New host did not become available within the bounded startup window', { cause: lastError });
      if (receipt.newInstance.instanceId === receipt.oldInstance.instanceId || receipt.newInstance.pid === receipt.oldInstance.pid) {
        throw new Error('The old host was not replaced by a new instance');
      }
      await this.phase(receipt, 'verifying', signal);
      await this.accept(receipt, plan, targetRoot, modules, next, hostFiles, before, signal);
      receipt.state = 'succeeded'; receipt.attentionRequired = false;
      receipt.recovery = 'Deployment accepted. Old installations and backups are retained; restoring a backup is a separate, potentially destructive decision.';
      await this.store.save(receipt, 'finished');
    } catch (error) {
      receipt.state = signal.aborted
        ? signal.reason instanceof Error && signal.reason.name === 'DeploymentCancelled' ? 'cancelled' : 'interrupted'
        : 'failed';
      receipt.error = error instanceof Error ? error.message : String(error);
      receipt.checks.push({ name: receipt.phase, status: 'failed', detail: receipt.error });
      if (!receipt.attentionRequired) receipt.recovery = 'Preparation failed before requesting shutdown; the existing host and selection were not switched.';
      await this.store.save(receipt);
    } finally { await releaseHost?.(); }
  }

  private async accept(
    receipt: DeploymentReceipt, plan: DeploymentPlan, targetRoot: string, modules: Map<string, ModuleInstallation>,
    selection: Awaited<ReturnType<typeof readModuleSettings>>, hostFiles: Record<string, string>,
    before: Record<string, Record<string, DatabaseFacts>>, signal: AbortSignal,
  ): Promise<void> {
    const identity = await this.instance(signal);
    if (identity.version !== plan.host.version || identity.sourceSha !== plan.host.sourceSha) throw new Error('Loaded host does not match the pinned release');
    const health = z.object({ ok: z.literal(true), instanceId: z.string() }).parse(await (await this.response('/health', signal)).json());
    if (health.instanceId !== identity.instanceId) throw new Error('Health and version describe different host instances');
    const runtime = await verifyRuntime(targetRoot, receipt.releases.host);
    if (await realpath(this.config.host.currentLink) !== targetRoot
      && JSON.stringify(await verifyRuntime(await realpath(this.config.host.currentLink))) !== JSON.stringify(runtime)) {
      throw new Error('Current package changed during acceptance');
    }
    const active = bootstrap.parse(await (await this.response('/_modules', signal)).json());
    const expected = Object.entries(selection.selected).filter(([, value]) => value.enabled)
      .map(([id, value]) => ({ id, version: value.version, digest: value.digest })).sort((a, b) => a.id.localeCompare(b.id));
    if (active.errors.length || JSON.stringify(active.active.sort((a, b) => a.id.localeCompare(b.id))) !== JSON.stringify(expected)) {
      throw new Error('Module activation has errors or differs from the preserved enabled selection');
    }
    for (const entry of runtime.files) {
      if (entry.type !== 'file' || !entry.path.startsWith('apps/web/dist/')) continue;
      const path = entry.path.slice('apps/web/dist/'.length);
      const bytes = Buffer.from(await (await this.response(path === 'index.html' ? '/' : `/${path}`, signal)).arrayBuffer());
      if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) throw new Error(`Served Web asset differs from the package: ${path}`);
    }
    for (const [name, module] of modules) {
      await readModuleInstallation(name, { version: module.manifest.version, digest: module.digest }, this.config.host.home);
      if (selection.selected[name]!.enabled) {
        for (const [path, expected] of Object.entries(module.files)) {
          if (!isDeclaredAsset(module.manifest, path)) continue;
          const bytes = Buffer.from(await (await this.response(`/_modules/assets/${name}/${module.digest}/${path}`, signal)).arrayBuffer());
          if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error(`Served module asset differs: ${name}/${path}`);
        }
      }
      for (const spec of plan.modules[name]!.databases) {
        const actual = databaseFacts(join(this.config.host.home, 'modules', 'data', name, spec.path), spec);
        if (actual.schema !== spec.schema
          || (before[name]?.[spec.path] && JSON.stringify(actual.preserved) !== JSON.stringify(before[name]![spec.path]!.preserved))) {
          throw new Error(`Database schema or preserved records differ: ${name}/${spec.path}`);
        }
      }
    }
    if (JSON.stringify(await readModuleSettings(this.config.host.home)) !== JSON.stringify(selection)
      || JSON.stringify(await captureHostFiles(this.config.host.home, this.config.limits.backupBytes)) !== JSON.stringify(hostFiles)) {
      throw new Error('Configuration or saved session-role content changed during deployment');
    }
    receipt.checks.push(
      { name: 'loaded-identities-and-assets', status: 'passed', detail: 'Host Release/source, process instance, HTTP/static bytes and enabled module identities match' },
      { name: 'configuration-and-data', status: 'passed', detail: 'Enablement/configuration and declared database integrity, schemas and preserved projections verified' },
      { name: 'interactive-devices', status: 'not-covered', detail: 'No real model prompt, ask_user answer, microphone or device notification was exercised' },
    );
  }
}
