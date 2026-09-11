import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: true });
for (const name of ['project', 'request', 'result']) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8')));
}

export function validateShape(name, value) {
  const validate = ajv.getSchema(`${name}.schema.json`);
  if (!validate) throw new Error(`Unknown contract: ${name}`);
  if (!validate(value)) throw new Error(`${name}: ${ajv.errorsText(validate.errors)}`);
  return value;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function timestamp(value) {
  const ms = Date.parse(value);
  requireCondition(Number.isFinite(ms) &&
    new Date(ms).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'),
  `Invalid UTC timestamp: ${value}`);
  return ms;
}

export function validateRequest(request, { checkExpiry = true, now = Date.now() } = {}) {
  validateShape('request', request);
  const auth = request.authorization;
  if (request.intent === 'build-only') {
    requireCondition(auth === null, 'build-only must not carry deployment authorization');
  } else {
    requireCondition(auth !== null, 'deploy requires explicit authorization');
    requireCondition(auth.repoId === request.repo.id && auth.sha === request.repo.sha &&
      auth.environment === request.environment, 'Authorization does not bind this repo/SHA/environment');
    const expiry = timestamp(auth.expiresAt);
    if (checkExpiry) requireCondition(expiry > now, 'Deployment authorization is expired');
  }
  return request;
}

export function validateResult(request, result) {
  // Readback may occur after authorization expiry; activation must enforce it separately.
  validateRequest(request, { checkExpiry: false });
  validateShape('result', result);
  requireCondition(result.requestId === request.requestId && result.repoId === request.repo.id &&
    result.requestedSha === request.repo.sha && result.configSha256 === request.projectConfig.sha256 &&
    result.environment === request.environment, 'Result identity does not match request');
  const updatedAt = timestamp(result.updatedAt);
  for (const evidence of [result.running, result.health]) {
    if (evidence) requireCondition(timestamp(evidence.observedAt) <= updatedAt,
      'Evidence observation is later than result update');
  }
  const { artifact, running, health, failure, recovery, state } = result;
  if (artifact) {
    requireCondition(artifact.sourceSha === request.repo.sha &&
      artifact.configSha256 === request.projectConfig.sha256, 'Artifact provenance does not match request');
  }
  if (['built', 'waiting-idle', 'activating', 'verifying', 'succeeded'].includes(state)) {
    requireCondition(artifact !== null, `${state} requires an immutable artifact`);
  }
  if (request.intent === 'build-only') {
    requireCondition(!['waiting-idle', 'activating', 'verifying', 'succeeded'].includes(state),
      'build-only cannot enter deployment states');
    requireCondition(running === null && health === null && recovery === null,
      'build-only cannot report runtime mutation or recovery');
  }
  if (['failed', 'unknown', 'cancelled'].includes(state)) {
    requireCondition(failure !== null, `${state} requires explicit failure/effect information`);
    if (request.intent === 'deploy') requireCondition(recovery !== null, `${state} requires recovery status`);
    if (state === 'unknown') requireCondition(failure.effects === 'unknown', 'unknown requires unknown effects');
    if (state === 'cancelled') requireCondition(failure.effects === 'not-applied',
      'Cancellation is only terminal before deployment effects');
  } else {
    requireCondition(failure === null && recovery === null, `${state} cannot hide failure/recovery information`);
  }
  if (state === 'succeeded') {
    requireCondition(running !== null && health !== null, 'succeeded requires runtime identity and health');
    requireCondition(running.sha === request.repo.sha && running.artifactSha256 === artifact.sha256,
      'Running version/artifact does not match requested release');
    requireCondition(health.status === 'healthy' && health.instanceId === running.instanceId,
      'Health must be healthy for the same runtime instance');
  }
  if (recovery?.state === 'restored') {
    requireCondition(running !== null && health?.status === 'healthy' &&
      recovery.runningSha === running.sha && health.instanceId === running.instanceId,
    'Restored recovery requires matching actual healthy runtime identity');
  }
  return result;
}
