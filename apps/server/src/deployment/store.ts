import { lstat, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DeploymentPlan, DeploymentReceipt, id, type Phase } from './contracts.ts';
import { exclusiveJson, hash, missing, newDirectory, plainTree, privateBytes, privateDirectory, writeJson } from './files.ts';
import { syncModuleDirectory } from '../module-install.ts';
import { z } from 'zod';
import { serviceIdentity } from '../identity.ts';

interface RecoveryIssue {
  requestId: string; kind: 'incomplete-claim' | 'invalid-receipt'; error: string;
  fingerprint?: string; acknowledged?: boolean;
}
const claimAcknowledgement = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().min(10), instanceId: z.string().min(1), at: z.string(),
}).strict();

export class DeploymentStore {
  constructor(readonly root: string) {}

  path(run: string): string { return join(this.root, 'runs', id.parse(run)); }
  private claimPath(run: string): string { return join(this.root, `.claim-${id.parse(run)}`); }

  async initialize(): Promise<void> {
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, 'runs'));
    for (const receipt of (await this.inventory()).receipts) {
      if (receipt.state !== 'running') continue;
      await this.save({
        ...receipt, state: 'interrupted', attentionRequired: true,
        error: 'The deployment service stopped before a durable final result. Effects may have occurred.',
        recovery: 'Inspect this receipt, the managed service and current installation. Do not replay this run or restore a database automatically.',
      });
    }
  }

  async read(run: string): Promise<DeploymentReceipt> {
    id.parse(run);
    try {
      const value = DeploymentReceipt.parse(JSON.parse((await privateBytes(join(this.path(run), 'receipt.json'), 4 * 1024 * 1024)).toString('utf8')));
      if (value.id !== run) throw new Error('Deployment receipt identity differs from its path');
      return value;
    } catch (error) {
      let reserved = !missing(error);
      for (const path of [this.path(run), this.claimPath(run)]) {
        try { await lstat(path); reserved = true; }
        catch (statError) { if (!missing(statError)) throw statError; }
      }
      if (!reserved) throw error;
      throw Object.assign(new Error('Deployment claim/receipt is incomplete or invalid; inspect it without replaying the request', { cause: error }), {
        code: 'DEPLOYMENT_RECORD_UNCONFIRMED', statusCode: 409, requestId: run,
      });
    }
  }

  async inventory(): Promise<{ receipts: DeploymentReceipt[]; recovery: RecoveryIssue[] }> {
    const names = await readdir(join(this.root, 'runs'));
    if (names.length > 10000) throw new Error('Deployment receipt directory exceeds the supported bound');
    const receipts: DeploymentReceipt[] = [];
    const recovery: RecoveryIssue[] = [];
    for (const name of names) {
      try { receipts.push(await this.read(name)); }
      catch (error) {
        recovery.push({ requestId: name, kind: 'invalid-receipt', error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const name of await readdir(this.root)) {
      if (!name.startsWith('.claim-')) continue;
      const issue: RecoveryIssue = {
        requestId: name.slice('.claim-'.length), kind: 'incomplete-claim',
        error: 'An unpublished claim is retained. No new deployment may start until its effects and files are explicitly inspected.',
      };
      try {
        id.parse(issue.requestId);
        issue.fingerprint = hash(JSON.stringify(await plainTree(this.claimPath(issue.requestId), 8 * 1024 ** 2)));
        try {
          const acknowledgement = claimAcknowledgement.parse(JSON.parse(
            (await privateBytes(join(this.root, 'claim-acknowledgements', `${issue.requestId}.json`))).toString('utf8'),
          ));
          issue.acknowledged = acknowledgement.fingerprint === issue.fingerprint;
        } catch (error) { if (!missing(error)) throw error; }
      } catch (error) { issue.error = error instanceof Error ? error.message : String(error); }
      recovery.push(issue);
    }
    let acknowledged: string[] = [];
    try { acknowledged = await readdir(join(this.root, 'claim-acknowledgements')); }
    catch (error) { if (!missing(error)) throw error; }
    for (const name of acknowledged) {
      const requestId = name.endsWith('.json') ? name.slice(0, -5) : name;
      if (recovery.some(issue => issue.requestId === requestId)) continue;
      try {
        id.parse(requestId);
        const acknowledgement = claimAcknowledgement.parse(JSON.parse(
          (await privateBytes(join(this.root, 'claim-acknowledgements', name))).toString('utf8'),
        ));
        recovery.push({ requestId, kind: 'incomplete-claim', fingerprint: acknowledgement.fingerprint,
          acknowledged: true, error: 'The acknowledged unpublished request ID remains permanently reserved.' });
      } catch (error) {
        recovery.push({ requestId, kind: 'invalid-receipt', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { receipts, recovery };
  }

  async create(run: string, plan: DeploymentPlan, planBytes: Buffer): Promise<DeploymentReceipt> {
    const now = new Date().toISOString();
    const staging = this.claimPath(run);
    await newDirectory(staging);
    const receipt: DeploymentReceipt = {
      format: 1, id: run, planId: plan.id, planSha256: hash(planBytes), planSnapshotSha256: hash(JSON.stringify(plan)), sequence: 0,
      executor: { ...serviceIdentity, pid: process.pid, node: process.versions.node },
      state: 'running', phase: 'accepted', createdAt: now, updatedAt: now,
      events: [{ phase: 'accepted', at: now }], releases: {}, backups: [], checks: [],
      error: null, attentionRequired: false, recovery: 'No rollback or automatic replay is provided.',
    };
    // Only a complete, synced run directory becomes executable. Orphan claims stay visible and reserved.
    await exclusiveJson(join(staging, 'receipt.json'), receipt);
    await exclusiveJson(join(staging, 'plan.json'), plan);
    await syncModuleDirectory(staging);
    try { await lstat(this.path(run)); throw new Error('Deployment ID is already reserved'); }
    catch (error) { if (!missing(error)) throw error; }
    await rename(staging, this.path(run));
    await syncModuleDirectory(join(this.root, 'runs'));
    await syncModuleDirectory(this.root);
    return receipt;
  }

  async save(receipt: DeploymentReceipt, phase?: Phase): Promise<void> {
    const current = await this.read(receipt.id);
    if (current.sequence !== receipt.sequence) throw new Error('Stale deployment writer');
    if (current.state !== 'running' && receipt.state === 'running') throw new Error('A finished deployment cannot restart');
    receipt.sequence++;
    receipt.updatedAt = new Date().toISOString();
    if (phase && phase !== receipt.phase) {
      receipt.phase = phase;
      receipt.events.push({ phase, at: receipt.updatedAt });
    }
    await writeJson(join(this.path(receipt.id), 'receipt.json'), receipt);
  }

  async plan(run: string): Promise<DeploymentPlan> {
    const plan = DeploymentPlan.parse(JSON.parse(await readFile(join(this.path(run), 'plan.json'), 'utf8')));
    if (hash(JSON.stringify(plan)) !== (await this.read(run)).planSnapshotSha256) throw new Error('The saved deployment plan differs from its immutable snapshot');
    return plan;
  }

  async acknowledgeClaim(run: string, fingerprint: string, reason: string, instanceId: string): Promise<void> {
    id.parse(run);
    try { await lstat(this.path(run)); throw new Error('A published run is not an unpublished claim; its effects require separate investigation'); }
    catch (error) { if (!missing(error)) throw error; }
    const issue = (await this.inventory()).recovery.find(issue => issue.requestId === run && issue.kind === 'incomplete-claim');
    if (!issue || !issue.fingerprint || issue.fingerprint !== fingerprint) throw new Error('Unpublished claim changed after inspection');
    await privateDirectory(join(this.root, 'claim-acknowledgements'));
    await exclusiveJson(join(this.root, 'claim-acknowledgements', `${run}.json`), {
      fingerprint, reason, instanceId, at: new Date().toISOString(),
    });
  }
}
