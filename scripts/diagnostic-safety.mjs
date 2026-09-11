import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const MAX_FILES = 32;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

function refuse(message) {
  throw new Error(`Diagnostic refused: ${message}`);
}

function inside(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function checkPath(path, env) {
  const home = resolve(homedir());
  if (inside(home, path) || path.split(sep).some(part => ['.copilot', '.ssh', '.aws', '.config', '.local'].includes(part))) {
    refuse('personal/configuration roots are not synthetic fixtures');
  }
  const configuredRoots = [
    env.COCKPIT_HOME, env.COCKPIT_SESSION_STATE_DIR,
    env.COCKPIT_SESSION_STORE ? dirname(resolve(env.COCKPIT_SESSION_STORE)) : undefined,
  ].filter(Boolean).map(value => resolve(value));
  if (configuredRoots.some(root => inside(path, root) || inside(root, path))) {
    refuse('fixture selection overlaps a configured Cockpit data root');
  }
  // Reject every symlink component, not just a final symlink. Do not resolve a
  // link into a private directory and then inspect its contents.
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) refuse('fixture paths must not contain symlinks');
  }
  return lstatSync(path);
}

export function diagnosticOptions(kind, args = process.argv.slice(2), env = process.env) {
  const http = kind === 'e2e' || kind === 'perf';
  const usage = `use --synthetic-fixture-root <absolute-directory>${http ? ' --test-base-url http://127.0.0.1:<test-port>' : ''}. Only operator-owned synthetic data and a separately isolated test backend are allowed; flags do not isolate a backend.`;
  const allowed = new Set(['--synthetic-fixture-root', ...(http ? ['--test-base-url'] : [])]);
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || options.has(args[i])) refuse(usage);
    options.set(args[i], args[i + 1]);
  }
  if (options.size !== allowed.size) refuse(usage);
  // Validate all arguments before inspecting even the supplied fixture root.
  const rawRoot = options.get('--synthetic-fixture-root');
  if (!isAbsolute(rawRoot) || rawRoot.split(sep).includes('..')) refuse(usage);
  const root = resolve(rawRoot);
  let base;
  if (http) {
    base = options.get('--test-base-url');
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]*)$/.exec(base);
    const port = Number(match?.[1]);
    const productionPorts = new Set([8771, Number(env.COCKPIT_PORT), Number(env.PORT)]);
    if (env.COCKPIT_URL) {
      let configured;
      try { configured = new URL(env.COCKPIT_URL); }
      catch { refuse('configured COCKPIT_URL is invalid; cannot exclude its production endpoint'); }
      if (!['http:', 'https:'].includes(configured.protocol)) refuse('configured COCKPIT_URL must use HTTP or HTTPS');
      productionPorts.add(Number(configured.port || (configured.protocol === 'https:' ? 443 : 80)));
    }
    if (!match || port < 1024 || port > 65535 || productionPorts.has(port)) {
      refuse('test target must be explicit IPv4 loopback on an unprivileged port other than 8771 or configured production ports; no remote URLs, aliases, paths or redirects');
    }
  }
  if (!checkPath(root, env).isDirectory()) refuse('fixture root must be a directory');
  return { root, base };
}

export function readSyntheticLogs(root, env = process.env) {
  if (!checkPath(root, env).isDirectory()) refuse('fixture root must be a directory');
  // A flat, bounded set of JSONL fixtures, not a native session-state tree.
  const names = readdirSync(root);
  if (!names.length || names.length > MAX_FILES) refuse(`supply 1–${MAX_FILES} flat JSONL fixtures`);
  let totalBytes = 0;
  const files = names.sort().map(name => {
    const file = join(root, name);
    const stat = checkPath(file, env);
    if (!name.endsWith('.jsonl') || !stat.isFile() || stat.nlink !== 1) refuse('only regular, non-linked *.jsonl fixtures are allowed');
    totalBytes += stat.size;
    if (stat.size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) refuse('fixture byte budget exceeded (4 MiB/file, 16 MiB total)');
    return { name, file };
  });
  // Validate the complete selection before reading any file contents.
  return files.map(({ name, file }) => ({
    name,
    events: readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); }
      catch { refuse(`invalid JSON in ${name}:${index + 1}`); }
    }),
  }));
}

export function diagnosticFetch(base) {
  return (url, init = {}) => {
    if (new URL(url).origin !== base) refuse('request escaped the explicit test origin');
    return fetch(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) });
  };
}
