import { startModuleSupervisor } from './supervisor.ts';

const args = process.argv.slice(2);
const options: { userRoot?: string; cockpitUrl?: string } = {};
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (!value || (flag !== '--user-root' && flag !== '--cockpit-url')) {
    throw new Error('Usage: node --import tsx supervisor-entry.ts [--user-root /absolute/private/root] [--cockpit-url http://127.0.0.1:PORT]');
  }
  const key = flag === '--user-root' ? 'userRoot' : 'cockpitUrl';
  if (options[key] !== undefined) throw new Error(`Duplicate runner option: ${flag}`);
  options[key] = value;
}
const runner = await startModuleSupervisor(options);
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, socket: runner.socketPath })}\n`);
if (process.send) process.send({ type: 'module-runner-ready', apiVersion: 1, pid: process.pid, socket: runner.socketPath });
let stopping = false;
async function parentReply(value: object): Promise<void> {
  if (!process.send || !process.connected) throw new Error('Module runner parent IPC is unavailable; shutdown outcome must be inspected');
  await new Promise<void>((resolve, reject) => {
    process.send!(value, error => { if (error) reject(error); else resolve(); });
  });
}
process.on('message', value => {
  void (async () => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('operationId' in value)
      || typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,120}$/.test(value.operationId)
      || !('type' in value) || value.type !== 'shutdown-if-idle'
      || Object.keys(value).some(key => key !== 'type' && key !== 'operationId')) {
      throw new Error('Invalid module runner parent IPC request');
    }
    const reply = { type: 'module-runner-shutdown', operationId: value.operationId, pid: process.pid };
    if (stopping) {
      await parentReply({ ...reply, ok: false, error: 'Module runner shutdown is already in progress' });
      return;
    }
    stopping = true;
    try { await runner.close(); }
    catch (error) {
      stopping = false;
      await parentReply({ ...reply, ok: false, error: error instanceof Error ? error.message : 'Module runner shutdown is unconfirmed' });
      return;
    }
    await parentReply({ ...reply, ok: true });
    if (process.connected && process.disconnect) process.disconnect();
  })().catch(error => {
    process.stderr.write(`Module runner parent operation failed: ${error instanceof Error ? error.message : 'Unconfirmed outcome'}\n`);
  });
});
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void runner.close({ drain: true }).catch(error => {
    stopping = false;
    process.stderr.write(`Module runner remains active: ${error instanceof Error ? error.message : 'Unconfirmed graceful shutdown'}\n`);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
