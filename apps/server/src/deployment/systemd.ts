import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeploymentConfig } from './contracts.ts';

const exec = promisify(execFile);
export interface ServiceState { pid: number; active: string; sub: string }
export interface HostManager {
  inspect(): Promise<ServiceState>;
  stop(): Promise<void>;
  start(): Promise<void>;
}

export async function command(program: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  const result = await exec(program, args, {
    timeout, signal, maxBuffer: 1024 * 1024, encoding: 'utf8',
    windowsHide: true, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  });
  return result.stdout;
}

export class SystemdHost implements HostManager {
  constructor(private readonly config: DeploymentConfig) {}
  private call(args: string[]): Promise<string> {
    const { systemctl, scope } = this.config.host.service;
    return command(systemctl, [scope === 'user' ? '--user' : '--system', '--no-pager', ...args], this.config.limits.requestMs);
  }

  async inspect(): Promise<ServiceState> {
    const properties = ['MainPID', 'ActiveState', 'SubState', 'Restart', 'KillMode', 'KillSignal', 'SendSIGKILL', 'TimeoutStopUSec', 'ExecStart', 'ExecStop'];
    const text = await this.call(['show', this.config.host.service.unit, `--property=${properties.join(',')}`]);
    const data = Object.fromEntries(text.trim().split('\n').map(line => {
      const split = line.indexOf('=');
      return [line.slice(0, split), line.slice(split + 1)];
    }));
    // systemd suppresses Restart during an explicit stop; Restart=no also prevents failed new hosts looping.
    if (data.Restart !== 'no' || data.KillMode !== 'mixed' || data.KillSignal !== '15'
      || data.SendSIGKILL !== 'no' || data.TimeoutStopUSec !== 'infinity' || data.ExecStop) {
      throw new Error('Unsupported host unit: require Restart=no, KillMode=mixed, SIGTERM, SendSIGKILL=no, infinite stop timeout and no ExecStop');
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

  async stop(): Promise<void> {
    await this.inspect();
    // KillMode=mixed sends SIGTERM only to the main host; its existing handler drains native work.
    await this.call(['stop', '--no-block', this.config.host.service.unit]);
  }

  async start(): Promise<void> {
    const state = await this.inspect();
    if (state.pid || state.active === 'active' || state.active === 'activating') throw new Error('Host is not stopped');
    await this.call(['start', '--no-block', this.config.host.service.unit]);
  }
}
