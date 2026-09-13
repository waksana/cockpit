import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { diagnosticFetch, diagnosticOptions as parseOptions, readSyntheticLogs as readLogs } from './diagnostic-safety.mjs';

const diagnosticOptions = (kind, args) => parseOptions(kind, args, {});
const readSyntheticLogs = root => readLogs(root, {});

const repo = fileURLToPath(new URL('..', import.meta.url));
const work = resolve(`.diagnostic-test-${process.pid}-${randomUUID()}`);
mkdirSync(work);
after(() => rmSync(work, { recursive: true, force: true }));
const fixture = (name) => {
  const root = join(work, name);
  mkdirSync(root);
  return root;
};
const logs = fixture('logs');
writeFileSync(join(logs, 'conversation.jsonl'), [
  { id: 'u', type: 'user.message', data: { content: 'synthetic question' } },
  { id: 'a', type: 'assistant.message', data: { messageId: 'a', content: 'synthetic answer' } },
].map(event => JSON.stringify(event)).join('\n'));
const rootArgs = ['--synthetic-fixture-root', logs];
const targetArgs = ['--test-base-url', 'http://127.0.0.1:45678'];

// Fail closed inside child processes too. The assertions prove no attempted
// private-path access or network operation, rather than just an exit code.
const audit = `data:text/javascript,${encodeURIComponent(`
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
let privateReads = 0, network = 0;
const privateRoots = [process.env.COCKPIT_HOME, process.env.COCKPIT_SESSION_STATE_DIR,
  process.env.COCKPIT_SESSION_STORE ? dirname(resolve(process.env.COCKPIT_SESSION_STORE)) : undefined,
].filter(Boolean).map(value => resolve(value));
function forbidden(path) {
  const value = String(path);
  return value.split('/').includes('.copilot') || privateRoots.some(root => value === root || value.startsWith(root + '/'));
}
for (const api of [fs, fsPromises]) {
  for (const key of ['readdir', 'readdirSync', 'readFile', 'readFileSync', 'open', 'openSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'realpath', 'realpathSync', 'existsSync']) {
    if (typeof api[key] !== 'function') continue;
    const original = api[key];
    api[key] = function(path, ...args) {
      if (forbidden(path)) { privateReads++; throw new Error('PRIVATE_READ_ATTEMPT'); }
      return original.call(this, path, ...args);
    };
  }
}
globalThis.fetch = () => { network++; throw new Error('NETWORK_ATTEMPT'); };
net.Socket.prototype.connect = (...args) => {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  // tsx attempts optional local IPC; block it too, but do not count it as TCP.
  if (options && typeof options === 'object' && options.path) throw new Error('IPC_DISABLED');
  network++;
  throw new Error('NETWORK_ATTEMPT');
};
syncBuiltinESMExports();
process.on('exit', () => console.error('DIAGNOSTIC_AUDIT ' + JSON.stringify({privateReads, network})));
`)}`;

const performanceTransport = `data:text/javascript,${encodeURIComponent(`
import assert from 'node:assert/strict';
let requests = 0;
globalThis.fetch = async (url, init) => {
  requests++;
  assert.equal(init.redirect, 'error');
  const target = new URL(url);
  assert.equal(target.origin, 'http://127.0.0.1:45678');
  if (target.pathname === '/health' || target.pathname === '/status') return new Response('{}');
  if (target.pathname === '/events') return new Response('data: {"type":"snapshot"}\\n\\n');
  throw new Error('unexpected diagnostic request');
};
process.on('exit', () => {
  assert.equal(requests, 461);
  console.log('SYNTHETIC_HTTP 461 requests, no file transfer');
});
`)}`;

function run(script, args = [], transport, env = {}) {
  return new Promise((resolveResult, reject) => {
    const typescript = script !== 'scripts/e2e.mjs' || Boolean(transport);
    const child = spawn(process.execPath, [
      '--import', audit, ...(typescript ? ['--import', 'tsx'] : []),
      ...(transport ? ['--import', transport] : []),
      join(repo, script), ...args,
    ], {
      cwd: typescript ? join(repo, 'packages/core') : repo,
      env: { HOME: work, TMPDIR: work, TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1', COCKPIT_PORT: '8771', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      try { assert.match(stderr, /DIAGNOSTIC_AUDIT \{"privateReads":0,"network":0\}/); }
      catch (error) { reject(error); return; }
      resolveResult({ code, stdout, stderr });
    });
  });
}

for (const script of ['scripts/perf.mjs', 'scripts/e2e.mjs']) {
  test(`${script}: production target refuses before private I/O or network`, async () => {
    const result = await run(script, [...rootArgs, '--test-base-url', 'http://127.0.0.1:8771']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /test target must be explicit/);
  });
}

for (const script of ['scripts/perf.mjs', 'scripts/e2e.mjs', 'packages/core/src/regress-reallog.mts']) {
  test(`${script}: defaults refuse before private I/O or network`, async () => {
    const result = await run(script);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Diagnostic refused: use --synthetic-fixture-root/);
  });
  test(`${script}: explicit personal roots refuse without reading them`, async () => {
    const args = ['--synthetic-fixture-root', join(work, '.copilot', 'session-state')];
    if (!script.endsWith('.mts')) args.push(...targetArgs);
    const result = await run(script, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /personal\/configuration roots/);
  });
}

test('all required options and target validation precede fixture filesystem access', () => {
  for (const kind of ['e2e', 'perf']) {
    assert.throws(() => diagnosticOptions(kind, rootArgs), /Diagnostic refused/);
    assert.throws(() => diagnosticOptions(kind, targetArgs), /Diagnostic refused/);
    assert.throws(() => diagnosticOptions(kind, [...rootArgs, ...targetArgs, '--unknown', 'yes']), /Diagnostic refused/);
    assert.throws(() => diagnosticOptions(kind, [...rootArgs, ...rootArgs, ...targetArgs]), /Diagnostic refused/);
    for (const target of [
      'http://127.0.0.1:8771', 'http://localhost:8771', 'http://127.0.0.1:08771',
      'http://[::1]:8771', 'https://cockpit.example', 'http://192.0.2.1:45678',
      'http://127.0.0.1:80', 'http://127.0.0.1:65536',
      'http://127.0.0.1:45678/path', 'http://user@127.0.0.1:45678',
    ]) {
      assert.throws(() => diagnosticOptions(kind, [
        '--synthetic-fixture-root', join(work, 'does-not-exist'),
        '--test-base-url', target,
      ]), /test target must be explicit/);
    }
  }
});

test('personal/ancestor roots and symlink components are rejected', () => {
  for (const root of ['/', homedir(), join(homedir(), '.copilot', 'session-state'), join(work, '..', '.copilot')]) {
    assert.throws(() => diagnosticOptions('regress', ['--synthetic-fixture-root', root]), /Diagnostic refused/);
  }
  const link = join(work, 'linked-root');
  symlinkSync(logs, link);
  assert.throws(() => diagnosticOptions('regress', ['--synthetic-fixture-root', link]), /symlinks/);
  const nested = fixture('nested');
  mkdirSync(join(nested, 'child'));
  const ancestor = join(work, 'linked-ancestor');
  symlinkSync(nested, ancestor);
  assert.throws(() => diagnosticOptions('regress', ['--synthetic-fixture-root', join(ancestor, 'child')]), /symlinks/);
});

test('flat synthetic logs are accepted; native trees, linked files and oversized files are rejected', () => {
  assert.deepEqual(diagnosticOptions('perf', [...rootArgs, ...targetArgs]), { root: logs, base: targetArgs[1] });
  assert.equal(readSyntheticLogs(logs)[0].events.length, 2);
  const nested = fixture('native-tree');
  mkdirSync(join(nested, 'session'));
  assert.throws(() => readSyntheticLogs(nested), /regular, non-linked/);
  for (const kind of ['symbolic', 'hard']) {
    const root = fixture(kind);
    (kind === 'symbolic' ? symlinkSync : linkSync)(join(logs, 'conversation.jsonl'), join(root, 'linked.jsonl'));
    assert.throws(() => readSyntheticLogs(root), /symlinks|non-linked/);
    rmSync(join(root, 'linked.jsonl'));
  }
  const large = fixture('large');
  writeFileSync(join(large, 'large.jsonl'), Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.throws(() => readSyntheticLogs(large), /byte budget/);
  const empty = fixture('empty');
  assert.throws(() => readSyntheticLogs(empty), /flat JSONL fixtures/);
  const invalid = fixture('invalid');
  writeFileSync(join(invalid, 'invalid.jsonl'), '{bad json}');
  assert.throws(() => readSyntheticLogs(invalid), /invalid JSON/);
});

test('regression runs the actual fold/schema on synthetic fixtures without network or private reads', async () => {
  const result = await run('packages/core/src/regress-reallog.mts', rootArgs);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /2 msgs \| 0 fold errors \| 0 invalid/);
});

test('performance paths remain executable with synthetic fold and in-memory HTTP fixtures only', async () => {
  const result = await run('scripts/perf.mjs', [...rootArgs, ...targetArgs], performanceTransport);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /synthetic browser-fold fixtures/);
  assert.match(result.stdout, /SYNTHETIC_HTTP 461 requests, no file transfer/);
});

test('allowed E2E completes against in-memory state with actual intent body/result schemas', async () => {
  const transport = new URL('./diagnostic-e2e-fixture.mjs', import.meta.url).href;
  const result = await run('scripts/e2e.mjs', [...rootArgs, ...targetArgs], transport);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\d+ passed, 0 failed/);
  assert.match(result.stdout, /SYNTHETIC_E2E \d+ intent contracts validated, no real backend/);
});

test('configured data roots and their ancestors refuse before filesystem access', async () => {
  const parent = join(work, 'configured-private');
  const state = join(parent, 'state');
  for (const key of ['COCKPIT_HOME', 'COCKPIT_SESSION_STATE_DIR', 'COCKPIT_SESSION_STORE']) {
    const env = { [key]: key === 'COCKPIT_SESSION_STORE' ? join(state, 'session-store.db') : state };
    for (const root of [parent, state, join(state, 'child')]) {
      const result = await run('packages/core/src/regress-reallog.mts', ['--synthetic-fixture-root', root], undefined, env);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /overlaps a configured Cockpit data root/);
    }
  }
});

test('configured endpoint ports refuse before filesystem access or network', async () => {
  for (const script of ['scripts/perf.mjs', 'scripts/e2e.mjs']) {
    for (const env of [
      { COCKPIT_PORT: '45678' }, { PORT: '45678' },
      { COCKPIT_URL: 'http://localhost:45678/service' },
      { COCKPIT_URL: 'https://cockpit.example:45678/' },
    ]) {
      const result = await run(script, [...rootArgs, ...targetArgs], undefined, env);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /test target must be explicit/);
    }
  }
});

test('test transport permits an owned ephemeral server but never follows redirects or crosses origins', async t => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:8771/health' });
    }
    res.end('synthetic response');
  });
  await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = diagnosticFetch(base);
  assert.equal(await (await request(`${base}/health`)).text(), 'synthetic response');
  await assert.rejects(request(`${base}/redirect`), /fetch failed/);
  assert.throws(() => request('http://127.0.0.1:8771/health'), /escaped/);
  assert.equal(requests, 2);
});
