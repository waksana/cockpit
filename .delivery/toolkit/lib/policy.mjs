import { isAbsolute } from 'node:path';

const relativePath = value => typeof value === 'string' && value.length > 0 && !isAbsolute(value)
  && !value.split('/').includes('..') && !value.includes('\\');
export function validatePolicy(config) {
  if (!Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535
    || !isAbsolute(config.root ?? '') || !Array.isArray(config.actors)
    || !config.projects || Object.keys(config.projects).length === 0) throw Error('Invalid runner configuration');
  for (const [id, p] of Object.entries(config.projects)) {
    const url = new URL(p.url);
    if (!/^[\w.-]+$/.test(id) || !isAbsolute(p.repo ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(p.repository)
      || !p.targetRef?.startsWith('refs/heads/') || !relativePath(p.configPath)
      || !p.workflowPath?.startsWith('.github/workflows/') || !relativePath(p.workflowPath)
      || !p.configHashes?.length || p.configHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))
      || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || ![p.healthPath, p.versionPath].every(path => typeof path === 'string' && /^\/[^?#]*$/.test(path))
      || ![p.buildTimeoutMs, p.busyTimeoutMs, p.healthTimeoutMs].every(ms => Number.isSafeInteger(ms) && ms > 0)
      || !relativePath(p.launch?.cwd) || !Array.isArray(p.launch.argv) || p.launch.argv.length === 0
      || p.launch.argv.some(arg => typeof arg !== 'string')
      || (p.launch.webPath && !relativePath(p.launch.webPath))) throw Error(`Invalid project policy: ${id}`);
    for (const name of [...Object.keys(p.launch.environment ?? {}),
      p.launch.webEnvironment, p.launch.assetEnvironment].filter(Boolean)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || /^(?:NODE_|SERVICE_DELIVERY_|PATH$)/.test(name)) {
        throw Error(`Reserved or invalid launch environment key: ${name}`);
      }
    }
  }
  return config;
}
