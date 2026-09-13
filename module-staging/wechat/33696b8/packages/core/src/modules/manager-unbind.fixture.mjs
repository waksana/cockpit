import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input), state = JSON.parse(readFileSync(config.stateFile, 'utf8'));
state.calls.push({ request, argv: process.argv.slice(2) });
const save = () => writeFileSync(config.stateFile, JSON.stringify(state), { mode: 0o600 });
save();
if (config.mode === 'held') {
  writeFileSync(`${config.stateFile}.ready`, 'ready');
  while (!existsSync(`${config.stateFile}.release`)) await setTimeout(10);
}
if (request.operation !== 'session-unbind' || Object.keys(request).sort().join(',') !== 'operation,operationId,sessionId') {
  throw new Error('Only native-independent session unbind is allowed');
}
let response;
if (['unknown', 'known-failure', 'wrong-failure-session'].includes(config.mode)) {
  response = { ok: false, operationId: request.operationId,
    sessionId: config.mode === 'wrong-failure-session' ? 'another-session' : request.sessionId,
    error: { code: config.mode === 'unknown' ? 'OPERATION_OUTCOME_UNKNOWN' : 'RUNNING' }, replayed: true };
  process.exitCode = 2;
} else {
  const previous = state.operations[request.operationId];
  if (previous && previous !== request.sessionId) throw new Error('Conflicting operation');
  if (!previous) {
    if (state.boundSessionId === request.sessionId) { state.boundSessionId = null; state.mutations++; }
    state.operations[request.operationId] = request.sessionId;
    save();
  }
  response = { ok: true, operationId: request.operationId, sessionId: request.sessionId, unbound: true, replayed: !!previous };
  if (config.mode === 'wrong-operation') response.operationId = 'another-operation';
  if (config.mode === 'wrong-session') response.sessionId = 'another-session';
  if (config.mode === 'not-unbound') response.unbound = false;
  if (config.mode === 'missing-replayed') delete response.replayed;
}
process.stderr.write('private-fixture-diagnostic');
process.stdout.write(config.mode === 'malformed' ? 'not-json private-fixture-diagnostic' : JSON.stringify(response));
