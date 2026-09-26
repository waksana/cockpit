import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { DeploymentPlan, id, digest, type DeploymentConfig, type DeploymentReceipt } from './contracts.ts';
import { deploymentLease, hash, missing, privateBytes } from './files.ts';
import { DeploymentRunner } from './runner.ts';
import { DeploymentStore } from './store.ts';
import { SystemdHost } from './systemd.ts';

const request = z.object({ requestId: id, planId: id, planSha256: digest }).strict();
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

export async function createDeploymentService(config: DeploymentConfig, runner?: DeploymentRunner) {
  const release = await deploymentLease(config.stateRoot, config.host.home);
  const store = runner?.store ?? new DeploymentStore(config.stateRoot);
  const worker = runner ?? new DeploymentRunner(config, store, new SystemdHost(config));
  let active: { receipt: DeploymentReceipt; controller: AbortController; done: Promise<void> } | undefined;
  let admission = false;
  let fatal: unknown;
  let closing = false;
  let secret: Buffer;
  try {
    secret = Buffer.from((await privateBytes(config.tokenFile, 1024)).toString('utf8').trim());
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(secret.toString('utf8'))) throw new Error('Deployment token must contain 32-256 URL-safe characters');
    await store.initialize();
  } catch (error) { await release(); throw error; }
  const app = Fastify({ logger: false, bodyLimit: 8192, requestTimeout: config.limits.requestMs });
  app.addHook('onRequest', async (req, reply) => {
    const token = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    if (token.length !== secret.length || !timingSafeEqual(token, secret)) {
      return reply.code(401).send({ error: 'Deployment authentication required' });
    }
    if (req.headers.origin || req.headers.referer) {
      return reply.code(403).send({ error: 'Browser-origin deployment requests are not supported' });
    }
    reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : missing(error) ? 404
      : error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
  });
  app.get('/health', async () => ({ ok: !fatal && !closing, active: active?.receipt.id ?? null }));
  app.get('/runs/:id', async req => store.read(id.parse((req.params as { id: string }).id)));
  app.post('/runs', async (req, reply) => {
    if (closing || fatal) throw conflict('Deployment service is stopping or has an unresolved persistence failure');
    if (admission) throw conflict('Another deployment request is being admitted');
    admission = true;
    try {
      const input = request.parse(req.body);
      const receipts = await store.list();
      const existing = receipts.find(item => item.id === input.requestId);
      if (existing) {
        if (existing.planId !== input.planId || existing.planSha256 !== input.planSha256) throw conflict('Request ID is already bound to different input');
        return reply.code(200).send(existing);
      }
      if (active || receipts.some(item => item.attentionRequired || item.state === 'running')) {
        throw conflict('A deployment is active or has unresolved effects; inspect its receipt before another request');
      }
      const prior = receipts.find(item => item.planSha256 === input.planSha256 && item.state === 'succeeded');
      if (prior) throw conflict(`This exact target was already accepted by run ${prior.id}; it will not execute twice`);
      const bytes = await privateBytes(join(config.plansRoot, `${input.planId}.json`));
      if (hash(bytes) !== input.planSha256) throw conflict('Deployment plan changed after approval');
      const plan = DeploymentPlan.parse(JSON.parse(bytes.toString('utf8')));
      if (plan.id !== input.planId) throw conflict('Plan ID differs from its approved filename');
      const receipt = await store.create(input.requestId, plan, bytes);
      const controller = new AbortController();
      const done = worker.execute(receipt, plan, controller.signal).catch(error => {
        fatal = error;
        app.log.error(error, 'Deployment result could not be persisted');
      }).finally(() => { active = undefined; });
      active = { receipt, controller, done };
      return reply.code(202).send(receipt);
    } finally { admission = false; }
  });
  app.post('/runs/:id/cancel', async (req, reply) => {
    z.object({}).strict().parse(req.body);
    const run = id.parse((req.params as { id: string }).id);
    if (!active || active.receipt.id !== run) throw conflict('This deployment is not running');
    if (!['accepted', 'preparing', 'prepared'].includes(active.receipt.phase)) {
      throw conflict('Shutdown or later effects may have started; cancellation cannot undo them');
    }
    active.controller.abort(Object.assign(new Error('Deployment cancelled before shutdown'), { name: 'DeploymentCancelled' }));
    return reply.code(202).send({ requestId: run, cancellationRequested: true });
  });
  app.addHook('onClose', async () => {
    closing = true;
    active?.controller.abort(new Error('Independent deployment service is closing; effects must be inspected'));
    await active?.done;
    await release();
  });
  return { app, store, get active() { return active?.done; } };
}
