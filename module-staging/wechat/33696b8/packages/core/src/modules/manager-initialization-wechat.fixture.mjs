import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const state = JSON.parse(readFileSync(config.stateFile, 'utf8'));
const mode = JSON.parse(readFileSync(config.modeFile, 'utf8'));
appendFileSync(config.callsFile, `${JSON.stringify(request)}\n`, { mode: 0o600 });
if (request.operation === 'status') {
  const reason = mode.reason ?? (mode.unknown ? 'OPERATION_OUTCOME_UNKNOWN'
    : mode.runnerUnknown ? 'RUNNER_STATE_UNKNOWN'
      : mode.notReady ? 'NOT_CONFIGURED'
        : state.boundSessionId ? (mode.running ? 'RUNNING' : 'ALREADY_BOUND') : null);
  process.stdout.write(JSON.stringify({ ok: true, status: {
    available: reason === null, reason, boundSessionId: state.boundSessionId, revision: state.revision,
    managed: true, configReady: !mode.notReady, credentialsPresent: true, unknownOperation: !!mode.unknown,
    runnerUnknown: !!mode.runnerUnknown, running: !!mode.running,
    pendingJobs: Object.hasOwn(mode, 'pendingJobs') ? mode.pendingJobs : 0,
    unknownJobs: Object.hasOwn(mode, 'unknownJobs') ? mode.unknownJobs : 0,
    ...(Object.hasOwn(mode, 'detailsAvailable') ? { detailsAvailable: mode.detailsAvailable } : {}),
    ...(Object.hasOwn(mode, 'bindingConfirmed') ? { bindingConfirmed: mode.bindingConfirmed } : {}),
  } }));
} else {
  if (request.operation !== 'bind') throw new Error('Fixture permits status and bind only');
  const code = mode.unknown ? 'OPERATION_OUTCOME_UNKNOWN' : mode.failBind ? 'NOT_CONFIGURED'
    : state.boundSessionId ? 'ALREADY_BOUND' : null;
  if (code) {
    process.stdout.write(JSON.stringify({ ok: false, operationId: request.operationId, error: { code } }));
    process.exitCode = 2;
  } else {
    state.boundSessionId = request.sessionId;
    state.revision++;
    state.operationId = request.operationId;
    writeFileSync(config.stateFile, JSON.stringify(state), { mode: 0o600 });
    process.stdout.write(mode.loseReply ? 'unconfirmed response' : JSON.stringify({
      ok: true, operationId: request.operationId, boundSessionId: request.sessionId, revision: state.revision, replayed: false,
    }));
  }
}
