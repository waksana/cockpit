import { fault } from './delivery-store.mjs';

export async function observeRuntime(project, expected) {
  async function read(path) {
    const response = await fetch(`${project.url}${path}`, { redirect: 'error',
      headers: { 'cache-control': 'no-store' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw fault('RUNTIME_UNAVAILABLE', `Runtime ${path}: HTTP ${response.status}`);
    return response.json();
  }
  const health = await read(project.healthPath), version = await read(project.versionPath);
  if (health.ok !== true || !health.instanceId || health.instanceId !== version.instanceId
    || version.sha !== expected.sha || version.artifactSha256 !== expected.artifactSha256
    || version.requestId !== expected.requestId || version.instanceId !== expected.instanceId) {
    throw fault('IDENTITY_MISMATCH', 'Health/version is absent, cached, or does not identify this artifact and process');
  }
  const observedAt = new Date().toISOString();
  return {
    running: { sha: version.sha, artifactSha256: version.artifactSha256, instanceId: version.instanceId,
      authority: `${project.url}${project.versionPath}`, observedAt },
    health: { status: 'healthy', instanceId: version.instanceId,
      authority: `${project.url}${project.healthPath}`, observedAt },
  };
}
