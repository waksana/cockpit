import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseModuleServicePins, startModuleSupervisor, type ModuleServicePin } from './supervisor.ts';
import { readPrivateModuleJson } from './adapters.ts';
import { writeModuleRecord } from './private-files.ts';

const args = process.argv.slice(2);
const options: { userRoot?: string; cockpitUrl?: string } = {};
let hostOwned = false;
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (flag === '--host-owned') {
    if (value !== 'true' || hostOwned || !process.send || !process.connected) {
      throw new Error('Host-owned module supervision requires its actual parent IPC channel');
    }
    hostOwned = true;
    continue;
  }
  if (!value || (flag !== '--user-root' && flag !== '--cockpit-url')) {
    throw new Error('Usage: node --import tsx supervisor-entry.ts [--user-root /absolute/private/root] [--cockpit-url http://127.0.0.1:PORT] [--host-owned true]');
  }
  const key = flag === '--user-root' ? 'userRoot' : 'cockpitUrl';
  if (options[key] !== undefined) throw new Error(`Duplicate runner option: ${flag}`);
  options[key] = value;
}
const runner = await startModuleSupervisor(options);
process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, socket: runner.socketPath })}\n`);
if (process.send) process.send({ type: 'module-runner-ready', apiVersion: 1, lifecycleApi: 1, pid: process.pid, socket: runner.socketPath });
let stopping = false;
async function parentReply(value: object): Promise<void> {
  if (!process.send || !process.connected) throw new Error('Module runner parent IPC is unavailable; inspect the original lifecycle');
  await new Promise<void>((resolve, reject) => {
    process.send!(value, error => { if (error) reject(error); else resolve(); });
  });
}
process.on('message', value => {
  void (async () => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('operationId' in value)
      || typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,120}$/.test(value.operationId)
      || !('type' in value) || (value.type !== 'drain-and-stop' && value.type !== 'restore-enabled')
      || Object.keys(value).some(key => key !== 'type' && key !== 'operationId' && !(value.type === 'restore-enabled' && key === 'services'))) {
      throw new Error('Invalid module runner parent IPC request');
    }
    const draining = value.type === 'drain-and-stop';
    const requestedServices = draining ? undefined : parseModuleServicePins('services' in value ? value.services : undefined);
    const reply = { type: draining ? 'module-runner-drain' : 'module-runner-restore', operationId: value.operationId, pid: process.pid };
    const file = join(runner.userRoot, '.module-runner', 'lifecycle', `${value.operationId}.json`);
    if (existsSync(file)) {
      const previous = readPrivateModuleJson(file);
      if (previous.schemaVersion !== 1 || previous.operationId !== value.operationId || previous.request !== value.type
        || previous.instanceId !== runner.instanceId || previous.pid !== process.pid
        || JSON.stringify(previous.requestedServices) !== JSON.stringify(requestedServices)
        || typeof previous.state !== 'string' || !['accepted', 'stopped', 'restored', 'refused', 'unknown'].includes(previous.state)) {
        await parentReply({ ...reply, state: 'unknown', error: 'Lifecycle belongs to an earlier or different runner operation; no replay' });
      } else {
        await parentReply({ ...reply, state: previous.state, ...(typeof previous.error === 'string' ? { error: previous.error } : {}),
          ...(['stopped', 'restored'].includes(previous.state) ? { services: parseModuleServicePins(previous.services) } : {}) });
      }
      return;
    }
    if (stopping) {
      await parentReply({ ...reply, state: 'refused', error: 'Another runner lifecycle owns the control fence; no new effect' });
      return;
    }
    stopping = true;
    let admitted = false;
    const save = (state: string, error?: string, services?: ModuleServicePin[]) => writeModuleRecord(file, {
      schemaVersion: 1, request: value.type, instanceId: runner.instanceId, ...reply, state,
      ...(requestedServices ? { requestedServices } : {}), ...(services ? { services } : {}), ...(error ? { error } : {}),
    });
    const accepted = async () => {
      save('accepted');
      admitted = true;
      await parentReply({ ...reply, state: 'accepted' });
    };
    try {
      const services = draining ? await runner.drainAndStop(value.operationId, accepted)
        : await runner.restoreEnabled(value.operationId, requestedServices, accepted);
      const state = draining ? 'stopped' : 'restored';
      save(state, undefined, services);
      await parentReply({ ...reply, state, services });
      if (draining && process.connected && process.disconnect) process.disconnect();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'Runner lifecycle outcome is unconfirmed';
      const state = admitted ? 'unknown' : 'refused';
      save(state, error);
      await parentReply({ ...reply, state, error });
    } finally { stopping = false; }
  })().catch(error => {
    process.stderr.write(`Module runner parent operation failed: ${error instanceof Error ? error.message : 'Unconfirmed outcome'}\n`);
  });
});
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void runner.close({ drain: true }).then(() => {
    if (process.connected && process.disconnect) process.disconnect();
  }).catch(error => {
    stopping = false;
    process.stderr.write(`Module runner remains active: ${error instanceof Error ? error.message : 'Unconfirmed graceful shutdown'}\n`);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
