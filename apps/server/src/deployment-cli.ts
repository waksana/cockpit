import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeploymentConfig, id } from './deployment/contracts.ts';
import { privateBytes } from './deployment/files.ts';
import { createDeploymentService } from './deployment/service.ts';
import { DeploymentStore } from './deployment/store.ts';

async function cli(args: string[]): Promise<void> {
  const [action, file, ...rest] = args;
  if (!file) throw new Error('Usage: deployment-cli <serve|submit|get|cancel|read-receipt> <config-or-state-root> [arguments]');
  if (action === 'read-receipt' && rest.length === 1) {
    process.stdout.write(`${JSON.stringify(await new DeploymentStore(resolve(file)).read(id.parse(rest[0])), null, 2)}\n`);
    return;
  }
  const config = DeploymentConfig.parse(JSON.parse((await privateBytes(resolve(file))).toString('utf8')));
  if (action === 'serve' && !rest.length) {
    const service = await createDeploymentService(config);
    await service.app.listen({ host: '127.0.0.1', port: config.port });
    process.stdout.write(`${JSON.stringify({ listening: service.app.server.address(), mode: 'explicit-request-only' })}\n`);
    const stop = () => { void service.app.close().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return;
  }
  const token = (await privateBytes(config.tokenFile, 1024)).toString('utf8').trim();
  const base = `http://127.0.0.1:${config.port}`;
  let url: string;
  let payload: unknown;
  if (action === 'submit' && rest.length === 3) {
    url = `${base}/runs`;
    payload = { requestId: rest[0], planId: rest[1], planSha256: rest[2] };
  } else if ((action === 'get' || action === 'cancel') && rest.length === 1) {
    url = `${base}/runs/${id.parse(rest[0])}${action === 'cancel' ? '/cancel' : ''}`;
    if (action === 'cancel') payload = {};
  } else throw new Error('submit takes request-id plan-id sha256; get/cancel take request-id');
  const response = await fetch(url, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload), redirect: 'error',
    signal: AbortSignal.timeout(config.limits.requestMs),
  });
  const body: unknown = await response.json();
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  if (!response.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
