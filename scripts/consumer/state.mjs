import { randomUUID } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, closeSync, fsyncSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const identifier = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][\w.-]{7,119}$/.test(value)) throw new Error('Expected stable operation ID (8–120 safe characters)');
  return value;
};
export function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_000_000) {
    throw new Error('Expected a bounded regular consumer JSON file without links');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function writeJson(path, data, exclusive = false) {
  const stage = exclusive ? path : `${path}.${randomUUID()}.new`;
  const fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  if (!exclusive) renameSync(stage, path);
  syncDirectory(dirname(path));
}
export function overlaps(a, b) {
  const inside = (parent, child) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}
export function privateDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error('Directory must be absolute and canonical without symlinks');
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`Directory must be owner-only: ${path}`);
  }
}
export function checkFreshDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Directory must be absolute and canonical');
  let ancestor = path;
  for (;;) {
    let stat;
    try { stat = lstatSync(ancestor); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(ancestor) !== ancestor) {
      throw new Error('Directory ancestors must be canonical without symbolic links');
    }
    break;
  }
  if (ancestor === path) {
    privateDirectory(path);
    if (readdirSync(path).length) throw new Error(`Refusing nonempty/unmarked directory: ${path}`);
  }
}
export function freshDirectory(path) {
  checkFreshDirectory(path);
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  privateDirectory(path);
}
export function hostChecks() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24
    || !process.report.getReport().header.glibcVersionRuntime) throw new Error('Requires Linux x64/glibc and Node24');
  execFileSync('python3', ['-c', 'import tarfile,sys; assert sys.version_info >= (3,12); assert hasattr(tarfile,"data_filter")'], { stdio: 'pipe' });
  rejectPrivateAuthority();
}
export function rejectPrivateAuthority(env = process.env) {
  if (Object.keys(env).some(key => key.startsWith('SERVICE_DELIVERY_'))
    || env.COCKPIT_DELIVERY_VIEWER_CREDENTIAL !== undefined) throw new Error('Private CD authority cannot coexist with consumer management');
}
export function loadAuthority(root) {
  privateDirectory(root);
  for (const competing of ['current', 'current.next', 'current.new']) {
    try { lstatSync(join(root, competing)); throw new Error('Competing current selector; refusing consumer management'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const authority = readJson(join(root, 'authority.json'));
  if (authority.schemaVersion !== 1 || authority.authority !== 'consumer' || authority.root !== root
    || !/^[a-f0-9-]{36}$/.test(authority.installationId)) throw new Error('Missing/invalid explicit consumer authority marker');
  privateDirectory(authority.userRoot);
  privateDirectory(join(authority.userRoot, 'logs'));
  if (overlaps(root, authority.userRoot) || overlaps(root, authority.nativeHome)
    || overlaps(authority.userRoot, authority.nativeHome)) throw new Error('Installation, user and native roots must be separate');
  const userMarker = readJson(join(authority.userRoot, '.consumer-installation.json'));
  if (userMarker.installationId !== authority.installationId || userMarker.root !== root) throw new Error('User root belongs to another installation');
  for (const path of ['launcher', 'releases', 'downloads', 'checks', 'operations', 'staging', 'assets']) privateDirectory(join(root, path));
  return authority;
}
export function nativeHome() {
  const path = resolve(process.env.COCKPIT_HOME ?? join(homedir(), '.copilot'));
  return existsSync(path) ? realpathSync(path) : path;
}

/** Linux PID start time plus boot ID prevents a reused PID from being adopted or killed. */
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process ID');
  try {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
    return { pid, start: fields[19], boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}
export function processStillExists(identity) {
  if (!identity) throw new Error('Process identity unknown; cannot infer a safe absence');
  const actual = processIdentity(identity.pid);
  return actual !== null && actual.start === identity.start && actual.boot === identity.boot;
}
export function operationPath(root, id) { return join(root, 'operations', `${identifier(id)}.json`); }
export function saveOperation(root, operation, exclusive = false) {
  operation.updatedAt = new Date().toISOString();
  writeJson(operationPath(root, operation.operationId), operation, exclusive);
  return operation;
}
