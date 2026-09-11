export function publicRequest(row) {
  if (!row) return null;
  const { result, request } = row;
  return { requestId: request.requestId, sha: request.repo.sha, intent: request.intent,
    state: result.state, sequence: result.sequence, updatedAt: result.updatedAt,
    artifactReady: Boolean(result.artifact), artifactSha256: result.artifact?.sha256 ?? null,
    failure: result.failure ? { stage: result.failure.stage, code: result.failure.code, effects: result.failure.effects } : null,
    recovery: result.recovery?.state ?? null };
}

export async function projectStatus(store, id, policy, readRuntime) {
  const head = store.head(id, policy.environment);
  const latest = store.latest(id, policy.environment);
  const active = store.setting(`active:${id}:${policy.environment}`);
  const activeRow = active?.requestId ? store.get(active.requestId) : null;
  const activeSerial = activeRow?.request.repo.id === id && activeRow.request.environment === policy.environment ? activeRow.serial : 0;
  const prepared = store.prepared(id, policy.environment, activeSerial);
  const runtime = await readRuntime(policy);
  let waitingReason = null;
  if (policy.activationEnabled === false) waitingReason = policy.pauseReason ?? 'activation-disabled';
  else if (head?.result.state === 'waiting-idle') waitingReason = runtime.lifecycle?.reason ?? 'safe-idle-not-yet-confirmed';
  else if (head && latest && head.request.requestId !== latest.request.requestId) waitingReason = 'earlier-deployment-reserves-environment';
  else if (latest?.request.intent === 'build-only' && latest.result.state === 'built') waitingReason = 'explicit-deployment-not-requested';
  return { projectId: id, name: policy.displayName ?? id, environment: policy.environment,
    observedAt: new Date().toISOString(), runtime, latest: publicRequest(latest),
    pending: publicRequest(head), prepared: publicRequest(prepared), waitingReason };
}

export async function readRuntime(policy) {
  async function read(path) {
    try {
      const response = await fetch(`${policy.url}${path}`, { signal: AbortSignal.timeout(3000), redirect: 'error',
        headers: { 'cache-control': 'no-store' } });
      if (!response.ok) return { error: `HTTP_${response.status}` };
      return { value: await response.json() };
    } catch (error) { return { error: error.name === 'TimeoutError' ? 'timeout' : 'unavailable' }; }
  }
  const [version, health, state] = await Promise.all([
    read(policy.versionPath), read(policy.healthPath), policy.statusPath ? read(policy.statusPath) : null,
  ]);
  const identity = version.value;
  const valid = Boolean(identity && typeof identity.instanceId === 'string' && identity.instanceId.length > 0);
  return {
    available: Boolean(valid), error: version.error ?? (valid ? null : 'invalid-runtime-identity'),
    version: typeof identity?.version === 'string' ? identity.version : null,
    sha: typeof identity?.sha === 'string' ? identity.sha : null,
    artifactSha256: typeof identity?.artifactSha256 === 'string' ? identity.artifactSha256 : null,
    instanceId: valid ? identity.instanceId : null,
    healthy: valid && health.value?.instanceId === identity.instanceId && health.value.ok === true,
    lifecycle: state?.value ? {
      restartPending: state.value.restartPending === true,
      reason: typeof state.value.reason === 'string' ? state.value.reason :
        state.value.busy === true || (typeof state.value.busy === 'number' && state.value.busy > 0) ? 'native-busy' : null,
      inFlight: typeof state.value.inFlight === 'number' ? state.value.inFlight : null,
    } : null,
  };
}
