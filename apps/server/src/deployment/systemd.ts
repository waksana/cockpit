import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { id, type DeploymentConfig } from './contracts.ts';
import { exclusiveJson, hash, missing, privateBytes, writeJson } from './files.ts';
import { directory, regularBytes, syncModuleDirectory, writeModuleBytes } from '../module-install.ts';

const exec = promisify(execFile);
export interface ServiceState { pid: number; active: string; sub: string }
export interface HostManager {
  inspect(): Promise<ServiceState>;
  stop(runId: string): Promise<void>;
  start(runId: string): Promise<void>;
  complete(runId: string): Promise<void>;
  recovery?(): Promise<unknown>;
}
const restart = z.enum(['no', 'always', 'on-success', 'on-failure', 'on-abnormal', 'on-abort', 'on-watchdog']);
const guardSchema = z.object({
  format: z.literal(1), runId: id, unit: z.string(), restart, guard: z.string(), block: z.string(),
  sources: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()),
}).strict();

export async function command(program: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
  const result = await exec(program, args, {
    timeout, signal, maxBuffer: 1024 * 1024, encoding: 'utf8',
    windowsHide: true, env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HOME: process.env.HOME,
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus`,
      NODE_OPTIONS: '', NODE_PATH: '',
    },
  });
  return result.stdout;
}

export async function assertControllerUnit(config: DeploymentConfig): Promise<void> {
  const text = await command(config.host.service.systemctl, [
    '--user', '--no-pager', 'show', config.controllerUnit, '--property=MainPID,KillMode,SendSIGKILL,ControlGroup',
  ], config.limits.requestMs);
  const properties = Object.fromEntries(text.trim().split('\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  const group = properties.ControlGroup;
  const ownGroups = await readFile('/proc/self/cgroup', 'utf8');
  if (Number(properties.MainPID) !== process.pid || properties.KillMode !== 'control-group' || properties.SendSIGKILL !== 'yes'
    || !group || !ownGroups.split('\n').some(line => line.endsWith(`:${group}`))) {
    throw new Error('Run the deployment server directly in its configured, separate user unit with KillMode=control-group and SendSIGKILL=yes');
  }
}

export class SystemdHost implements HostManager {
  constructor(private readonly config: DeploymentConfig) {}
  private call(args: string[]): Promise<string> {
    return command(this.config.host.service.systemctl, ['--user', '--no-pager', ...args], this.config.limits.requestMs);
  }

  private async properties(): Promise<Record<string, string>> {
    const properties = ['MainPID', 'ActiveState', 'SubState', 'Restart', 'KillMode', 'KillSignal', 'SendSIGKILL',
      'TimeoutStopUSec', 'ExecStart', 'ExecStop', 'FragmentPath', 'DropInPaths', 'Conditions'];
    const text = await this.call(['show', this.config.host.service.unit, `--property=${properties.join(',')}`]);
    return Object.fromEntries(text.trim().split('\n').map(line => {
      const split = line.indexOf('=');
      if (split < 1) throw new Error('Invalid systemd property response');
      return [line.slice(0, split), line.slice(split + 1)];
    }));
  }

  private validate(data: Record<string, string>): ServiceState {
    restart.parse(data.Restart);
    if (data.KillMode !== 'mixed' || data.KillSignal !== '15'
      || data.SendSIGKILL !== 'no' || data.TimeoutStopUSec !== 'infinity' || data.ExecStop) {
      throw new Error('Unsupported host unit: require KillMode=mixed, SIGTERM, SendSIGKILL=no, infinite stop timeout and no ExecStop');
    }
    const { node, currentLink } = this.config.host;
    if (/\s/.test(node + currentLink)
      || !data.ExecStart?.startsWith(`{ path=${node} ; argv[]=${node} --enable-source-maps ${currentLink}/apps/server/dist/index.js ; `)
      || data.ExecStart.includes('} {')) {
      throw new Error('Host ExecStart must directly run the configured Node and current package entry point');
    }
    const pid = Number(data.MainPID);
    if (!Number.isSafeInteger(pid) || pid < 0 || !data.ActiveState || !data.SubState) throw new Error('Invalid systemd service observation');
    return { pid, active: data.ActiveState, sub: data.SubState };
  }

  async inspect(): Promise<ServiceState> { return this.validate(await this.properties()); }

  private get recordPath() { return join(this.config.stateRoot, 'service-guard.json'); }
  private get blockPath() { return join(this.config.stateRoot, 'host-start-blocked'); }
  private contents(block: string) { return `[Unit]\nConditionPathExists=!${block}\n[Service]\nRestart=no\n`; }

  private async sources(properties: Record<string, string>, except?: string) {
    const paths = [properties.FragmentPath!, ...(properties.DropInPaths ?? '').split(' ').filter(Boolean)].filter(path => path !== except);
    const result = [];
    for (const path of paths) {
      if (!path.startsWith('/') || /[\s%\\'"]/.test(path)) throw new Error('Unit files must use unambiguous absolute paths without whitespace or specifiers');
      result.push({ path, sha256: hash(await regularBytes(path, 1024 * 1024)) });
    }
    return result;
  }

  private async guard(runId: string) {
    const record = guardSchema.parse(JSON.parse((await privateBytes(this.recordPath)).toString('utf8')));
    if (record.runId !== runId || record.unit !== this.config.host.service.unit || record.block !== this.blockPath) {
      throw new Error('Service guard belongs to another deployment; it is not automatically replaced');
    }
    const properties = await this.properties();
    this.validate(properties);
    if (record.guard !== join(dirname(properties.FragmentPath!), `${record.unit}.d`, 'zzzz-cockpit-deployment.conf')
      || await readFile(record.guard, 'utf8') !== this.contents(record.block)
      || properties.Restart !== 'no'
      || JSON.stringify(await this.sources(properties, record.guard)) !== JSON.stringify(record.sources)) {
      throw new Error('The guarded unit or its source files changed; explicit recovery is required');
    }
    return record;
  }

  async stop(runId: string): Promise<void> {
    id.parse(runId);
    const properties = await this.properties();
    this.validate(properties);
    const fragment = properties.FragmentPath!;
    const info = await lstat(fragment);
    if (!info.isFile() || info.uid !== process.getuid?.() || /[\s%\\'"]/.test(this.blockPath)) {
      throw new Error('The host user unit must be a regular file owned by the deployment user; state paths cannot contain whitespace or specifiers');
    }
    const dropIns = join(dirname(fragment), `${this.config.host.service.unit}.d`);
    await directory(dropIns, true);
    const guard = join(dropIns, 'zzzz-cockpit-deployment.conf');
    for (const path of [guard, this.recordPath, this.blockPath]) {
      try { await lstat(path); throw new Error('An existing deployment guard must be inspected, not overwritten'); }
      catch (error) { if (!missing(error)) throw error; }
    }
    const record = guardSchema.parse({
      format: 1, runId, unit: this.config.host.service.unit, restart: properties.Restart,
      guard, block: this.blockPath, sources: await this.sources(properties),
    });
    await exclusiveJson(this.recordPath, record);
    await exclusiveJson(record.block, { runId });
    await writeModuleBytes(guard, this.contents(record.block));
    await this.call(['daemon-reload']);
    await this.guard(runId);
    // KillMode=mixed sends SIGTERM only to the main host; its existing handler drains native work.
    await this.call(['stop', '--no-block', this.config.host.service.unit]);
  }

  async start(runId: string): Promise<void> {
    const record = await this.guard(runId);
    const state = await this.inspect();
    if (state.pid || state.active === 'active' || state.active === 'activating') throw new Error('Host is not stopped');
    const block = z.object({ runId: id }).strict().parse(JSON.parse((await privateBytes(record.block)).toString('utf8')));
    if (block.runId !== runId) throw new Error('Host startup permit belongs to another run');
    await unlink(record.block);
    await syncModuleDirectory(dirname(record.block));
    await this.call(['start', '--no-block', this.config.host.service.unit]);
  }

  async complete(runId: string): Promise<void> {
    const record = await this.guard(runId);
    const state = await this.inspect();
    if (state.active !== 'active' || !state.pid) throw new Error('Only a confirmed running host can regain its original restart policy');
    try {
      const block = z.object({ runId: id }).strict().parse(JSON.parse((await privateBytes(record.block)).toString('utf8')));
      if (block.runId !== runId) throw new Error('Startup guard changed after inspection');
      await unlink(record.block);
      await syncModuleDirectory(dirname(record.block));
    } catch (error) { if (!missing(error)) throw error; }
    await unlink(record.guard);
    await syncModuleDirectory(dirname(record.guard));
    await this.call(['daemon-reload']);
    const properties = await this.properties();
    this.validate(properties);
    if (properties.Restart !== record.restart || JSON.stringify(await this.sources(properties)) !== JSON.stringify(record.sources)) {
      throw new Error('Original unit policy was not restored; deployment remains unconfirmed');
    }
    await writeJson(join(this.config.stateRoot, 'runs', id.parse(runId), 'service-policy.json'), { ...record, restored: true });
    await rename(this.recordPath, join(this.config.stateRoot, 'runs', runId, 'service-guard-completed.json'));
    await syncModuleDirectory(this.config.stateRoot);
    await syncModuleDirectory(join(this.config.stateRoot, 'runs', runId));
  }

  async recovery(): Promise<unknown> {
    try { return guardSchema.parse(JSON.parse((await privateBytes(this.recordPath)).toString('utf8'))); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
}
