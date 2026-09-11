import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const configIndex = process.argv.indexOf('--config');
const data = process.env.WORK_DATA_DIR ?? JSON.parse(readFileSync(process.argv[configIndex + 1], 'utf8')).stateDir;
const settings = join(data, 'fixture-control.json');
const config = () => existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {};
const runtime = {
  moduleApi: 1,
  ...(process.env.COCKPIT_MODULE_ID === 'wechat' ? { moduleId: 'wechat' } : { projectId: 'task' }),
  moduleVersion: process.env.COCKPIT_MODULE_VERSION,
  moduleDigest: process.env.COCKPIT_MODULE_DIGEST,
  instanceId: process.env.COCKPIT_MODULE_INSTANCE,
  version: process.env.COCKPIT_MODULE_VERSION,
};
writeFileSync(join(data, `launch-${runtime.instanceId}.json`), JSON.stringify({
  pid: process.pid, runtime, argv: process.argv.slice(2), env: process.env,
}), { mode: 0o600 });
if (config().exitBeforeReady) process.exit(3);
let draining = false;
const server = createServer(async (request, response) => {
  const current = config();
  const identity = current.wrongIdentity ? { ...runtime, instanceId: 'wrong-instance-123' } : runtime;
  response.setHeader('content-type', 'application/json');
  if (request.url === '/version' || request.url === '/health') {
    const value = { ...identity, ok: !current.unhealthy };
    if (runtime.moduleId === 'wechat') {
      if (current.omitModuleVersion) delete value.moduleVersion;
      if (current.contradictoryVersion) value.moduleVersion = '9.9.9';
    }
    else if (request.url === '/health') { delete value.moduleApi; delete value.projectId; }
    response.end(JSON.stringify(value));
  } else if (['/drain', '/admin/restart'].includes(request.url) && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    writeFileSync(join(data, 'drain-request.json'), JSON.stringify({ body: JSON.parse(body), instanceId: runtime.instanceId,
      path: request.url, authorization: request.headers.authorization }), { mode: 0o600 });
    if (current.denyDrain) { response.writeHead(503); response.end('{}'); return; }
    draining = true;
    const value = { instanceId: runtime.instanceId, moduleDigest: runtime.moduleDigest,
      moduleVersion: runtime.moduleVersion,
      ...(runtime.moduleId === 'wechat' ? { moduleApi: 1, moduleId: 'wechat', version: runtime.version } : {}) };
    response.end(JSON.stringify(current.wrongDrainIdentity ? { ...value, instanceId: 'wrong-drain-123' } : value));
    setImmediate(waitForDrain);
  } else if (request.url === '/fixture/exit' && request.method === 'POST') {
    response.end('{}');
    setImmediate(() => server.close(() => process.exit(0)));
  } else {
    response.writeHead(404); response.end('{}');
  }
});
function waitForDrain() {
  if (!draining) return;
  if (config().busy) { setTimeout(waitForDrain, 10); return; }
  draining = false;
  server.close(() => process.exit(config().drainExitCode ?? 0));
}
setTimeout(() => server.listen(Number(process.env.COCKPIT_MODULE_PORT), '127.0.0.1'), config().startupDelayMs ?? 0);
