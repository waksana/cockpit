import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DeploymentPlan, DeploymentReceipt, id, type Phase } from './contracts.ts';
import { exclusiveJson, hash, newDirectory, privateBytes, privateDirectory, writeJson } from './files.ts';

export class DeploymentStore {
  constructor(readonly root: string) {}

  path(run: string): string { return join(this.root, 'runs', id.parse(run)); }

  async initialize(): Promise<void> {
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, 'runs'));
    for (const name of await readdir(join(this.root, 'runs'))) {
      const receipt = await this.read(name);
      if (receipt.state !== 'running') continue;
      await this.save({
        ...receipt, state: 'interrupted', attentionRequired: true,
        error: 'The deployment service stopped before a durable final result. Effects may have occurred.',
        recovery: 'Inspect this receipt, the managed service and current installation. Do not replay this run or restore a database automatically.',
      });
    }
  }

  async read(run: string): Promise<DeploymentReceipt> {
    const value = DeploymentReceipt.parse(JSON.parse((await privateBytes(join(this.path(run), 'receipt.json'), 4 * 1024 * 1024)).toString('utf8')));
    if (value.id !== run) throw new Error('Deployment receipt identity differs from its path');
    return value;
  }

  async list(): Promise<DeploymentReceipt[]> {
    const names = await readdir(join(this.root, 'runs'));
    if (names.length > 10000) throw new Error('Deployment receipt directory exceeds the supported bound');
    const result = [];
    for (const name of names) result.push(await this.read(name));
    return result;
  }

  async create(run: string, plan: DeploymentPlan, planBytes: Buffer): Promise<DeploymentReceipt> {
    const now = new Date().toISOString();
    await newDirectory(this.path(run));
    const receipt: DeploymentReceipt = {
      format: 1, id: run, planId: plan.id, planSha256: hash(planBytes), sequence: 0,
      state: 'running', phase: 'accepted', createdAt: now, updatedAt: now,
      events: [{ phase: 'accepted', at: now }], releases: {}, backups: [], checks: [],
      error: null, attentionRequired: false, recovery: 'No rollback or automatic replay is provided.',
    };
    // A claimed identity without a complete receipt is intentionally not reusable after a crash.
    await exclusiveJson(join(this.path(run), 'receipt.json'), receipt);
    await exclusiveJson(join(this.path(run), 'plan.json'), plan);
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
    return DeploymentPlan.parse(JSON.parse(await readFile(join(this.path(run), 'plan.json'), 'utf8')));
  }
}
