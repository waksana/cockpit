import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Intents, ModuleUpdateOperation, type IntentBody } from '@cockpit/protocol';
import { ModuleCatalog, ModuleInstallError, inspectModulePackage, validateModuleManifest } from './catalog.ts';
import { checkReleaseChannel, downloadRelease, verifyReleaseMetadata, validateReleaseChannel, type ReleaseChannel } from './release-channel.ts';
import { privateModuleDirectory, writeModuleRecord } from './private-files.ts';

function channel(catalog: ModuleCatalog): ReleaseChannel {
  const value = catalog.readHostConfig().values.releaseChannel;
  try { return validateReleaseChannel(value); }
  catch {
    throw new Error('Official signed release channel is not configured. The installer must pin its publisher key and permitted download origins');
  }
}

async function extract(archive: string, directory: string): Promise<void> {
  const extractor = fileURLToPath(new URL('../../../../.delivery/toolkit/bin/extract.py', import.meta.url));
  await new Promise<void>((done, reject) => {
    execFile('python3', [extractor, archive, directory], { maxBuffer: 64 * 1024 }, error => error ? reject(error) : done());
  });
}

export class ModuleUpdates {
  private readonly active = new Set<string>();
  private readonly root: string;
  constructor(private readonly catalog: ModuleCatalog, private readonly fetchImpl: typeof fetch = fetch) {
    this.root = join(catalog.userRoot, 'module-updates');
  }
  private floor() {
    const config = this.catalog.readHostConfig();
    const value = config.values.releaseSequence ?? 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid retained release sequence floor');
    return { config, sequence: value, digest: config.values.releaseMetadataDigest };
  }
  async check() {
    const trusted = channel(this.catalog);
    const before = this.floor();
    const { envelope, metadata } = await checkReleaseChannel(trusted, before.sequence, this.fetchImpl);
    const digest = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
    if (metadata.sequence === before.sequence && before.digest !== digest) throw new Error('Publisher reused a release sequence with different signed metadata');
    this.catalog.updateHostConfig({ releaseSequence: metadata.sequence, releaseMetadataDigest: digest }, before.config.revision);
    writeModuleRecord(join(this.root, 'channel.json'), { envelope });
    return metadata;
  }
  status(): ModuleUpdateOperation[] {
    return (['assistant', 'task', 'wechat'] as const).flatMap(id => {
      const file = join(this.root, `${id}.json`);
      if (!existsSync(file)) return [];
      const record = ModuleUpdateOperation.parse(JSON.parse(readFileSync(file, 'utf8')));
      if (record.moduleId !== id) throw new Error('Retained module update identity mismatch');
      if (!['succeeded', 'failed', 'unknown'].includes(record.state) && !this.active.has(record.operationId)) {
        return [{ ...record, state: 'unknown' as const, error: 'Update was interrupted; inspect its staged files and installed inventory before starting another operation' }];
      }
      return [record];
    });
  }
  get(operationId: string): ModuleUpdateOperation | null {
    operationId = Intents['modules/updates/get'].body.parse({ operationId }).operationId;
    const current = this.status().find(record => record.operationId === operationId);
    if (current) return current;
    const directory = join(this.root, operationId), file = join(directory, 'operation.json');
    if (!existsSync(directory)) return null;
    if (!existsSync(file)) throw new Error('Retained installation claim has no complete receipt; inspect it without replaying');
    const record = ModuleUpdateOperation.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (record.operationId !== operationId) throw new Error('Retained installation operation identity mismatch');
    return !['succeeded', 'failed', 'unknown'].includes(record.state) && !this.active.has(operationId)
      ? { ...record, state: 'unknown', error: 'Interrupted installation; no automatic replay' } : record;
  }
  private save(record: ModuleUpdateOperation): void {
    writeModuleRecord(join(this.root, record.operationId, 'operation.json'), record);
    writeModuleRecord(join(this.root, `${record.moduleId}.json`), record);
  }
  async reconcile(raw: IntentBody<'modules/updates/reconcile'>): Promise<ModuleUpdateOperation> {
    const request = Intents['modules/updates/reconcile'].body.parse(raw);
    const previous = this.status().find(value => value.moduleId === request.moduleId);
    if (!previous || previous.operationId !== request.operationId) throw new Error('Original installation operation is not the retained module operation');
    if (previous.state === 'succeeded' || previous.state === 'failed') return previous;
    if (previous.state !== 'unknown' || this.active.has(request.operationId)) throw new Error('Installation is still active; reconciliation cannot interrupt it');
    const lock = join(this.root, `${request.moduleId}.lock`);
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let verification: string | undefined;
    this.active.add(request.operationId);
    try {
      const installed = this.catalog.getInstalled(request.moduleId, previous.version);
      let resolved: ModuleUpdateOperation;
      if (!installed) {
        resolved = { ...previous, state: 'failed', updatedAt: Date.now(),
          error: 'Reconciled: target version is not installed. No download, installation or message was replayed.' };
      } else if (previous.source === 'local') {
        if (installed.digest !== previous.sha256) throw new Error('Installed local package differs from the originally authorized inventory');
        const selected = this.catalog.getInstalled(request.moduleId);
        const applied = selected?.manifest.version === installed.manifest.version && selected.digest === installed.digest;
        resolved = { ...previous, state: applied ? 'succeeded' : 'failed', installedDigest: installed.digest, updatedAt: Date.now(),
          error: applied ? undefined : 'Verified local package is retained but not selected; no selection or installation was replayed.' };
      } else {
        const archive = join(this.root, request.operationId, 'runtime.zip');
        const digest = createHash('sha256');
        let size = 0;
        const source = createReadStream(archive, { fd: openSync(archive, constants.O_RDONLY | constants.O_NOFOLLOW), autoClose: true });
        for await (const chunk of source) {
          size += chunk.length;
          if (size > 400 * 1024 * 1024) throw new Error('Retained archive exceeds the release limit');
          digest.update(chunk);
        }
        if (digest.digest('hex') !== previous.sha256) throw new Error('Retained archive no longer matches the originally verified release');
        verification = mkdtempSync(join(this.root, '.reconcile-'));
        const directory = join(verification, 'package');
        mkdirSync(directory, { mode: 0o700 });
        await extract(archive, directory);
        const expected = inspectModulePackage(directory);
        if (expected.manifest.id !== request.moduleId || expected.manifest.version !== previous.version
          || expected.digest !== installed.digest) throw new Error('Installed bytes do not match the original verified archive; outcome remains unknown');
        const selected = this.catalog.getInstalled(request.moduleId);
        const applied = selected?.manifest.version === installed.manifest.version && selected.digest === installed.digest;
        resolved = { ...previous, state: applied ? 'succeeded' : 'failed', installedDigest: installed.digest, updatedAt: Date.now(),
          ...(applied ? { error: undefined } : {
            error: 'Reconciled: verified package is retained but not selected. Existing selection and all data were preserved.',
          }) };
      }
      this.save(resolved);
      return resolved;
    } finally {
      this.active.delete(request.operationId);
      closeSync(fd); unlinkSync(lock);
      if (verification) rmSync(verification, { recursive: true });
    }
  }
  async installLocal(raw: IntentBody<'modules/install/local'>, source?: string): Promise<ModuleUpdateOperation> {
    const request = Intents['modules/install/local'].body.parse(raw);
    const existing = this.get(request.operationId);
    if (existing) {
      if (existing.source !== 'local' || existing.moduleId !== request.moduleId
        || existing.version !== request.version || existing.sha256 !== request.digest) throw new Error('Local install operation ID conflict');
      return existing;
    }
    privateModuleDirectory(this.root);
    const lock = join(this.root, `${request.moduleId}.lock`);
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let claimed = false, publishing = false;
    let record: ModuleUpdateOperation = { moduleId: request.moduleId, version: request.version, sha256: request.digest,
      source: 'local', operationId: request.operationId, state: 'installing', updatedAt: Date.now() };
    this.active.add(request.operationId);
    try {
      const previous = this.status().find(value => value.moduleId === request.moduleId);
      if (previous && !['failed', 'succeeded'].includes(previous.state)) throw new Error('Earlier update is unfinished or unknown; inspect it before installing');
      if (previous) writeModuleRecord(join(this.root, previous.operationId, 'operation.json'), previous);
      mkdirSync(join(this.root, request.operationId), { mode: 0o700 });
      claimed = true;
      this.save(record);
      if (!source) throw new Error('Trusted local module source is not configured');
      const candidate = inspectModulePackage(source);
      if (candidate.manifest.id !== request.moduleId || candidate.manifest.version !== request.version
        || candidate.digest !== request.digest) throw new Error('Local source no longer matches the requested module version and inventory');
      this.catalog.readConfig(request.moduleId, candidate.manifest.configVersion);
      publishing = true;
      const installed = this.catalog.installFromDirectory(source, request.digest);
      this.catalog.setSelected(request.moduleId, request.version);
      record = { ...record, state: 'succeeded', installedDigest: installed.digest, updatedAt: Date.now() };
      this.save(record);
      return record;
    } catch (error) {
      if (!claimed) throw error;
      const unknown = publishing && !(error instanceof ModuleInstallError && error.outcome === 'not-published');
      record = { ...record, state: unknown ? 'unknown' : 'failed', updatedAt: Date.now(),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1800) };
      this.save(record);
      throw error;
    } finally {
      this.active.delete(request.operationId);
      closeSync(fd); unlinkSync(lock);
    }
  }
  async install(request: IntentBody<'modules/updates/install'>): Promise<ModuleUpdateOperation> {
    request = Intents['modules/updates/install'].body.parse(request);
    const existing = this.get(request.operationId);
    if (existing) {
      if (existing.source === 'local' || existing.moduleId !== request.moduleId || existing.version !== request.version || existing.sha256 !== request.sha256) {
        throw new Error('Update operation ID conflict');
      }
      return existing;
    }
    if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24) {
      throw new Error('Official module archives currently support Linux x64 with Node 24 only');
    }
    const trusted = channel(this.catalog), floor = this.floor();
    const saved = JSON.parse(readFileSync(join(this.root, 'channel.json'), 'utf8')) as { envelope: unknown };
    if (createHash('sha256').update(JSON.stringify(saved.envelope)).digest('hex') !== floor.digest) {
      throw new Error('Retained release metadata is not the currently accepted signed channel');
    }
    const metadata = verifyReleaseMetadata(saved.envelope, trusted, floor.sequence);
    const target = metadata.targets.find(target => target.moduleId === request.moduleId
      && target.version === request.version && target.sha256 === request.sha256);
    if (!target) throw new Error('Requested archive is not an exact target in the checked signed release channel');
    const previous = this.status().find(record => record.moduleId === request.moduleId);
    if (previous?.operationId === request.operationId) {
      if (previous.version !== request.version || previous.sha256 !== request.sha256) throw new Error('Update operation ID conflict');
      return previous;
    }
    if (previous && !['failed', 'succeeded'].includes(previous.state)) throw new Error('Earlier update has an unfinished or unknown outcome; inspect it before starting another');
    privateModuleDirectory(this.root);
    const lock = join(this.root, `${request.moduleId}.lock`);
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const directory = join(this.root, request.operationId);
    const archive = join(directory, 'runtime.zip'), extracted = join(directory, 'package');
    let claimed = false;
    let record: ModuleUpdateOperation = { ...request, state: 'downloading', updatedAt: Date.now() };
    const save = (state: ModuleUpdateOperation['state']) => {
      record = { ...record, state, updatedAt: Date.now() };
      this.save(record);
    };
    this.active.add(request.operationId);
    try {
      const latest = this.status().find(value => value.moduleId === request.moduleId);
      if (latest && !['failed', 'succeeded'].includes(latest.state)) throw new Error('Earlier update became unfinished or unknown before lock acquisition');
      if (latest) writeModuleRecord(join(this.root, latest.operationId, 'operation.json'), latest);
      mkdirSync(directory, { mode: 0o700 });
      claimed = true;
      save('downloading');
      await downloadRelease(target, trusted, archive, this.fetchImpl);
      save('extracting');
      mkdirSync(extracted, { mode: 0o700 });
      await extract(archive, extracted);
      const manifest = validateModuleManifest(JSON.parse(readFileSync(join(extracted, 'module.json'), 'utf8')));
      if (manifest.id !== target.moduleId || manifest.version !== target.version) throw new Error('Extracted module identity differs from its signed target');
      this.catalog.readConfig(target.moduleId, manifest.configVersion);
      save('installing');
      const destination = new ModuleCatalog({ userRoot: this.catalog.userRoot, trustedSources: [extracted] });
      const installed = destination.installFromDirectory(extracted);
      destination.setSelected(target.moduleId, target.version);
      record.installedDigest = installed.digest;
      save('succeeded');
      return record;
    } catch (error) {
      if (!claimed) throw error;
      record.error = (error instanceof Error ? error.message : String(error)).slice(0, 1800);
      save(record.state === 'installing' && !(error instanceof ModuleInstallError && error.outcome === 'not-published') ? 'unknown' : 'failed');
      throw error;
    } finally {
      this.active.delete(request.operationId);
      closeSync(fd); unlinkSync(lock);
      if (record.state === 'succeeded') {
        rmSync(extracted, { recursive: true });
        unlinkSync(archive);
        unlinkSync(join(directory, 'runtime.tar.gz'));
      }
    }
  }
}
