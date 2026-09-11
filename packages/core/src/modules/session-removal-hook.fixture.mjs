import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const configFile = process.argv[process.argv.indexOf('--config') + 1];
const config = JSON.parse(readFileSync(configFile, 'utf8'));
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const control = () => JSON.parse(readFileSync(config.controlFile, 'utf8'));
const state = () => JSON.parse(readFileSync(config.stateFile, 'utf8'));
const reply = (replayed, extra = {}) => ({ ok: true, operationId: request.operationId, sessionId: request.sessionId, unbound: true, replayed, ...extra });
const failed = code => { process.stdout.write(JSON.stringify({ ok: false, error: { code } })); process.exitCode = 2; };
appendFileSync(config.callsFile, `${JSON.stringify({ request, argv: process.argv.slice(2), env: process.env })}\n`, { mode: 0o600 });
while (control().hold) await sleep(10);
const mode = control().mode;
if (mode === 'malformed') {
  process.stderr.write('private-credential-must-not-escape');
  process.stdout.write('not-json private-credential-must-not-escape');
} else if (mode === 'mismatch') {
  process.stdout.write(JSON.stringify(reply(false, { sessionId: 'some-other-session' })));
} else if (mode === 'wrong-operation') {
  process.stdout.write(JSON.stringify(reply(false, { operationId: 'some-other-operation' })));
} else if (mode === 'wrong-exit') {
  process.stdout.write(JSON.stringify(reply(false))); process.exitCode = 7;
} else if (mode === 'overflow' || mode === 'overflow-held') {
  process.stdout.write('x'.repeat(70 * 1024));
  while (control().holdAfterOutput) await sleep(10);
} else if (mode === 'fail') {
  process.stderr.write('private-credential-must-not-escape');
  failed('MODULE_BUSY');
} else if (mode === 'unknown-receipt' || mode === 'failure-receipt' || mode === 'failure-wrong-session') {
  process.stdout.write(JSON.stringify({ ok: false, operationId: request.operationId,
    sessionId: mode === 'failure-wrong-session' ? 'different-session' : request.sessionId,
    error: { code: mode === 'unknown-receipt' ? 'OPERATION_OUTCOME_UNKNOWN' : 'RUNNING' }, replayed: true }));
  process.exitCode = 2;
} else if (mode === 'bad-error') {
  failed('private-credential-must-not-escape');
} else if (mode === 'inspect-lock') {
  if (existsSync(config.parentLock)) failed('PARENT_LOCK_HELD_DURING_HOOK');
  else process.stdout.write(JSON.stringify(reply(false)));
} else {
  const current = state();
  const old = current.operations[request.operationId];
  if (old && old !== request.sessionId) failed('OPERATION_CONFLICT');
  else if (old) process.stdout.write(JSON.stringify(reply(true)));
  else if (current.boundSessionId && current.boundSessionId !== request.sessionId) failed('SESSION_MISMATCH');
  else {
    current.boundSessionId = null;
    current.operations[request.operationId] = request.sessionId;
    current.mutations++;
    writeFileSync(config.stateFile, JSON.stringify(current), { mode: 0o600 });
    if (mode === 'mutate-then-malformed') process.stdout.write('unknown-after-mutation');
    else process.stdout.write(JSON.stringify(reply(false)));
  }
}
