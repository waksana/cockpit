import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const body = JSON.parse(input), data = body.dataDirectory;
const mode = process.argv[process.argv.indexOf('--mode') + 1];
mkdirSync(data, { recursive: true, mode: 0o700 });
appendFileSync(join(data, 'calls.jsonl'), `${JSON.stringify({ body, argv: process.argv.slice(2), env: process.env })}\n`, { mode: 0o600 });
if (mode === 'overflow-held') process.stdout.write('x'.repeat(70 * 1024));
if (mode === 'held' || mode === 'overflow-held') {
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(data, 'release'))) {
    if (Date.now() > deadline) throw new Error('Synthetic initializer was not released');
    await sleep(10);
  }
}
if (mode === 'exit') {
  process.stderr.write('private initializer diagnostic');
  process.stdout.write('{"ok":false,"error":{"code":"SETUP_OUTCOME_UNKNOWN"}}');
  process.exitCode = 2;
} else {
  const credentialDirectory = join(data, 'credentials'), managerCredentialFile = join(data, 'module-manager.json'),
    viewerCredentialFile = join(credentialDirectory, 'module-viewer.json');
  mkdirSync(credentialDirectory, { mode: 0o700 });
  writeFileSync(managerCredentialFile, JSON.stringify({ token: 'M'.repeat(48) }), { mode: 0o600 });
  writeFileSync(viewerCredentialFile, JSON.stringify({ token: mode === 'duplicate-value' ? 'M'.repeat(48) : 'V'.repeat(48) }), { mode: 0o600 });
  const result = { ok: true, operationId: body.operationId, dataDirectory: data,
    credentialDirectory, managerCredentialFile, viewerCredentialFile };
  if (mode === 'wrong-operation') result.operationId = 'different-operation';
  if (mode === 'wrong-data') result.dataDirectory = dirname(data);
  if (mode === 'outside') result.managerCredentialFile = join(dirname(data), 'not-authorized.json');
  if (mode === 'extra-field') result.token = 'M'.repeat(48);
  if (mode === 'public') chmodSync(viewerCredentialFile, 0o644);
  if (mode === 'symlink') {
    const link = join(data, 'manager-link.json');
    symlinkSync(managerCredentialFile, link); result.managerCredentialFile = link;
  }
  process.stdout.write(mode === 'malformed' ? 'private malformed response' : JSON.stringify(result));
}
