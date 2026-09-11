// Synthetic parent IPC fixture; separate tests exercise the actual core supervisor.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const flags = process.argv.slice(2);
const root = flags[flags.indexOf('--user-root') + 1], cockpitUrl = flags[flags.indexOf('--cockpit-url') + 1];
if (flags[flags.indexOf('--host-owned') + 1] !== 'true') throw new Error('Consumer fixture requires explicit host ownership');
const socketPath = join(root, '.module-runner.sock'), lockPath = join(root, '.module-runner.lock');
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID() }), { flag: 'wx', mode: 0o600 });
writeFileSync(join(root, 'data/fixture-runner-launch.json'), JSON.stringify({ pid: process.pid, root, cockpitUrl, entry: import.meta.url }));
const children = new Map(), jobs = new Map(), operations = new Set();
let closing = false, restoring = false, initialized = false;
const childProgram = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [root,id,cockpitUrl]=process.argv.slice(1);
let pending=false;
process.on('message', async value=>{
  if(value!=='stop'||pending)return;
  pending=true;
  const response=await fetch(cockpitUrl+'/version');
  writeFileSync(join(root,'data','fixture-module-main-'+id+'.json'),JSON.stringify({status:response.status,identity:await response.json()}));
  const wait=()=>{if(existsSync(join(root,'data/fixture-module-busy')))setTimeout(wait,20);else process.exit(0);};
  wait();
});
process.send('ready');
`;
async function start(id, requestedPin) {
  if (children.has(id)) return;
  const statePath = join(root, 'modules', id, 'state.json');
  const version = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).selectedVersion : '1.0.0';
  const pin = requestedPin ?? { id, version, digest: createHash('sha256').update(`${id}@${version}`).digest('hex') };
  const handle = spawn(process.execPath, ['--input-type=module', '--eval', childProgram, root, id, cockpitUrl],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const child = { handle, pin, instanceId: randomUUID(), state: 'starting' };
  child.exited = new Promise(resolve => handle.once('exit', (code, signal) => resolve({ code, signal })));
  children.set(id, child);
  await new Promise((resolve, reject) => {
    handle.once('error', reject);
    handle.once('message', value => value === 'ready' ? resolve() : reject(new Error('Invalid fixture child readiness')));
  });
  child.state = 'running';
  appendFileSync(join(root, 'data/fixture-module-launches'), `${JSON.stringify({ ...pin, pid: handle.pid, runner: process.pid })}\n`);
}
async function stop(id, operationId) {
  const child = children.get(id);
  if (!child) return;
  child.state = 'draining';
  jobs.set(id, { command: { id, action: 'stop', operationId }, phase: 'waiting' });
  child.handle.send('stop');
  const exit = await child.exited;
  if (exit.code !== 0 || exit.signal !== null) throw new Error('Fixture module exit was not clean');
  children.delete(id);
  jobs.set(id, { command: { id, action: 'stop', operationId }, phase: 'done' });
}
function activationAllowed(id) {
  const configPath = join(root, 'module-config', `${id}.json`);
  if (!existsSync(configPath)) return false;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return config.values.ownership === 'managed' && config.values.activationEnabled === true;
}
const server = createServer(socket => {
  let text = '';
  socket.on('error', () => {});
  socket.on('data', chunk => {
    text += chunk;
    if (!text.includes('\n')) return;
    void (async () => {
      const request = JSON.parse(text.slice(0, text.indexOf('\n')));
      if (request.type === 'status') {
        const child = children.get(request.id), busy = existsSync(join(root, 'data/fixture-runner-busy-job'));
        const job = busy ? { command: { id: request.id }, phase: 'waiting' } : jobs.get(request.id);
        socket.end(`${JSON.stringify({ ok: true, result: { id: request.id, status: child?.state ?? 'stopped',
          owned: Boolean(child), recoveryRequired: false, ...(child ? { pid: child.handle.pid,
            identity: { moduleId: child.pin.id, moduleVersion: child.pin.version, moduleDigest: child.pin.digest, instanceId: child.instanceId } } : {}),
          ...(job ? { job } : {}) } })}\n`);
        return;
      }
      if (request.type !== 'control' || !['task', 'wechat'].includes(request.command?.id)) throw new Error('Invalid fixture request');
      if (closing || restoring || !initialized) throw new Error('Fixture runner is quiescing or awaiting initial restoration; no new control');
      const { id, action, operationId } = request.command;
      if (action === 'start') await start(id);
      else if (action === 'stop') await stop(id, operationId);
      const job = { command: request.command, phase: 'done' };
      jobs.set(id, job);
      socket.end(`${JSON.stringify({ ok: true, result: job })}\n`);
    })().catch(error => socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`));
  });
});
await new Promise(resolve => server.listen(socketPath, resolve));
chmodSync(socketPath, 0o600);
process.send({ type: 'module-runner-ready', apiVersion: 1, lifecycleApi: 1, pid: process.pid, socket: socketPath });
const reply = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
process.on('message', message => {
  if (message?.type === 'fixture-crash') process.exit(23);
  if (!['drain-and-stop', 'restore-enabled'].includes(message?.type)) return;
  void (async () => {
    const draining = message.type === 'drain-and-stop';
    const response = { type: draining ? 'module-runner-drain' : 'module-runner-restore', operationId: message.operationId, pid: process.pid };
    if (operations.has(message.operationId)) throw new Error('Fixture lifecycle request was replayed');
    operations.add(message.operationId);
    appendFileSync(join(root, 'data/fixture-runner-requests'), `${JSON.stringify(message)}\n`);
    if (existsSync(join(root, 'data/fixture-runner-busy-job')) || existsSync(join(root, 'data/fixture-runner-refuse'))) {
      await reply({ ...response, state: 'refused', error: 'Fixture active job refuses shutdown before any effect' });
      return;
    }
    if (draining && existsSync(join(root, 'data/fixture-race-module-start'))) await start('task');
    const services = draining ? [...children.values()].map(child => child.pin) : message.services;
    if (!Array.isArray(services)) throw new Error('Fixture restoration requires explicit captured service pins');
    if (draining) closing = true; else restoring = true;
    while (existsSync(join(root, 'data', draining ? 'fixture-delay-drain-ack' : 'fixture-delay-restore-ack'))) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await reply({ ...response, state: 'accepted' });
    try {
      if (draining) {
        for (const id of children.keys()) await stop(id, `${message.operationId}-${id}`);
        await new Promise(resolve => server.close(resolve));
        unlinkSync(lockPath);
        await reply({ ...response, state: 'stopped', services });
        process.disconnect();
      } else {
        for (const pin of services) {
          if (!activationAllowed(pin.id)) throw new Error('Captured fixture service activation is not permitted');
          await start(pin.id, pin);
        }
        restoring = false;
        initialized = true;
        if (existsSync(join(root, 'data/fixture-unknown-restored-ack'))) {
          await reply({ ...response, state: 'unknown', error: 'Fixture restoration acknowledgement lost after owned startup' });
          return;
        }
        await reply({ ...response, state: 'restored', services: services.map(pin => children.get(pin.id).pin) });
      }
    } catch (error) { await reply({ ...response, state: 'unknown', error: error.message }); }
  })().catch(error => process.stderr.write(`${error.message}\n`));
});
