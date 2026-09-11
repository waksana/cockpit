// Synthetic API1 process fixture. Real archived supervisor acceptance belongs to the parent.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const flags = process.argv.slice(2);
const root = flags[flags.indexOf('--user-root') + 1], cockpitUrl = flags[flags.indexOf('--cockpit-url') + 1];
const socketPath = join(root, '.module-runner.sock'), lockPath = join(root, '.module-runner.lock');
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID() }), { flag: 'wx', mode: 0o600 });
writeFileSync(join(root, 'data/fixture-runner-launch.json'), JSON.stringify({ pid: process.pid, root, cockpitUrl, entry: import.meta.url }));
const children = new Map(), jobs = new Map();
function start(id) {
  const child = spawn(process.execPath, ['--eval', "process.on('message', value => { if (value === 'stop') process.exit(0); });"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.set(id, child);
}
const server = createServer(socket => {
  let text = '';
  socket.on('data', chunk => {
    text += chunk;
    if (!text.includes('\n')) return;
    void (async () => {
      const request = JSON.parse(text.slice(0, text.indexOf('\n')));
      if (request.type === 'status') {
        const child = children.get(request.id), busy = existsSync(join(root, 'data/fixture-runner-busy-job'));
        const job = busy ? { command: { id: request.id }, phase: 'waiting' } : jobs.get(request.id);
        socket.end(`${JSON.stringify({ ok: true, result: { id: request.id, status: child ? 'running' : 'stopped',
          owned: Boolean(child), recoveryRequired: false, ...(child ? { pid: child.pid } : {}), ...(job ? { job } : {}) } })}\n`);
        return;
      }
      if (request.type !== 'control' || !['task', 'wechat'].includes(request.command?.id)) throw new Error('Invalid fixture request');
      const { id, action } = request.command;
      if (action === 'start' && !children.has(id)) {
        start(id);
      } else if (action === 'stop' && children.has(id)) {
        const child = children.get(id);
        const exit = new Promise(resolve => child.once('exit', resolve));
        child.send('stop');
        await exit;
        children.delete(id);
      }
      const job = { command: request.command, phase: 'done' };
      jobs.set(id, job);
      socket.end(`${JSON.stringify({ ok: true, result: job })}\n`);
    })().catch(error => socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`));
  });
});
await new Promise(resolve => server.listen(socketPath, resolve));
chmodSync(socketPath, 0o600);
process.send({ type: 'module-runner-ready', apiVersion: 1, pid: process.pid, socket: socketPath });
process.on('message', message => {
  if (message?.type === 'fixture-crash') process.exit(23);
  if (message?.type !== 'shutdown-if-idle') return;
  const reply = { type: 'module-runner-shutdown', operationId: message.operationId, pid: process.pid };
  if (existsSync(join(root, 'data/fixture-race-module-start')) && !children.has('task')) start('task');
  if (children.size || existsSync(join(root, 'data/fixture-runner-busy-job'))) {
    process.send({ ...reply, ok: false, error: 'Runner still owns active children/jobs; request ordinary graceful drain first' });
    return;
  }
  server.close(() => {
    unlinkSync(lockPath);
    process.send({ ...reply, ok: true }, () => process.disconnect());
  });
});
