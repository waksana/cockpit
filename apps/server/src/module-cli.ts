import { pathToFileURL } from 'node:url';
import { installLocalModule, listInstalledModules, readModuleSettings, selectModule } from './module-install.ts';
import { migrateModuleId } from './module-migration.ts';

const usage = `Usage:
  cockpit module install <local.tgz> --trust-local-code [--enable]
  cockpit module enable <id> [--version <version> --digest <sha256>]
  cockpit module disable <id>
  cockpit module list [--server <http://127.0.0.1:port>]
  cockpit module migrate-id <old-id> <new-id> --version <version> --digest <sha256> --offline [--apply | --resume]
Local packages execute trusted code in the host process. No install scripts or package manager run.
Install/enable/disable affect the next server start only; a running host is never hot-loaded.
migrate-id defaults to a read-only plan. --offline acknowledges all old/noncooperating hosts are stopped.
--apply cuts over host metadata/data; --resume completes an interrupted migration with identical parameters.
No permanent ID aliases or native session changes are made.`;

export async function moduleCli(args: string[], options: { hostRoot?: string; fetch?: typeof fetch } = {}): Promise<unknown> {
  const [command, ...rest] = args;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const bools = new Set(['--trust-local-code', '--enable', '--offline', '--apply', '--resume']);
  const values = new Set(['--version', '--digest', '--server']);
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if ((!bools.has(arg) && !values.has(arg)) || flags.has(arg)) throw new Error(`Unknown or duplicate option ${arg}\n${usage}`);
    if (bools.has(arg)) flags.set(arg, true);
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      flags.set(arg, value);
    }
  }
  const allowed: Record<string, string[]> = {
    install: ['--trust-local-code', '--enable'], enable: ['--version', '--digest'], disable: [], list: ['--server'],
    'migrate-id': ['--version', '--digest', '--offline', '--apply', '--resume'],
  };
  if (!command || !Object.hasOwn(allowed, command) || [...flags.keys()].some(flag => !allowed[command]!.includes(flag))
    || positional.length !== (command === 'list' ? 0 : command === 'migrate-id' ? 2 : 1)) throw new Error(usage);
  const hostRoot = options.hostRoot;
  if (command === 'migrate-id') {
    if (!flags.has('--version') || !flags.has('--digest') || (flags.has('--apply') && flags.has('--resume'))) throw new Error(usage);
    return migrateModuleId({
      hostRoot, from: positional[0]!, to: positional[1]!, version: flags.get('--version') as string,
      digest: flags.get('--digest') as string, offline: flags.has('--offline'),
      mode: flags.has('--resume') ? 'resume' : flags.has('--apply') ? 'apply' : 'plan',
    });
  }
  if (command === 'install') {
    const result = await installLocalModule(positional[0]!, { hostRoot, trustLocalCode: flags.has('--trust-local-code'), enable: flags.has('--enable') });
    const selected = (await readModuleSettings(hostRoot)).selected[result.manifest.id];
    return {
      installed: { id: result.manifest.id, version: result.manifest.version, digest: result.digest },
      enabled: !!selected && selected.digest === result.digest && selected.enabled, restartRequired: true,
    };
  }
  if (command === 'enable' || command === 'disable') {
    const selection = await selectModule(positional[0]!, {
      hostRoot, enabled: command === 'enable', version: flags.get('--version') as string | undefined, digest: flags.get('--digest') as string | undefined,
    });
    return { id: positional[0], selected: selection, restartRequired: true };
  }
  const installed = await listInstalledModules(hostRoot);
  const selected = (await readModuleSettings(hostRoot)).selected;
  const base = new URL(flags.get('--server') as string ?? `http://127.0.0.1:${process.env.COCKPIT_PORT ?? 8771}`);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password
    || base.pathname !== '/' || base.search || base.hash) throw new Error('--server must be a loopback HTTP origin');
  let running: unknown;
  let unavailable: string | undefined;
  try {
    const response = await (options.fetch ?? fetch)(new URL('/_modules', base), { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error(`Module bootstrap returned HTTP ${response.status}`);
    running = await response.json();
  } catch (error) { unavailable = error instanceof Error ? error.message : 'Running host unavailable'; }
  return { installed, selected, running: running ?? null, ...(unavailable ? { unavailable } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  moduleCli(process.argv.slice(2)).then(result => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
