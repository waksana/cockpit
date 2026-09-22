import type { MetaResource, SessionMeta, SessionProjection } from '@cockpit/protocol';

const fields = {
  identity: ['title', 'cwd', 'createdAt', 'lastActivity', 'lastActivitySource', 'roles', 'appliedRoles', 'rolesNeedReload'],
  control: ['status', 'nativeProcessing', 'activeSubagents', 'activeMcpOperations', 'intent'],
  queue: ['queue'],
  model: ['currentModelId', 'currentReasoningEffort', 'currentContextTier'],
  models: ['availableModels'],
  mode: ['currentMode'],
  todo: ['todo'],
  schedule: ['scheduleCount'],
} as const satisfies Record<MetaResource, readonly (keyof SessionProjection)[]>;

// Keep fresh independent parts of an in-flight response; only the late-dirtied
// dependencies need another read. Product patches are merged separately.
export function cleanProjection(meta: SessionProjection, dirty: ReadonlySet<MetaResource>): SessionProjection {
  const fresh = { ...meta };
  for (const resource of dirty) for (const field of fields[resource]) delete fresh[field];
  return fresh;
}

export function applyProjection(meta: SessionProjection, previous?: SessionMeta): SessionMeta {
  const next = meta.loaded ? { ...previous, ...meta } : meta;
  const { title, cwd, lastActivity, status, ask } = next;
  if (title === undefined || cwd === undefined || lastActivity === undefined || status === undefined || ask === undefined) {
    throw new Error('Session projection is missing identity or control fields');
  }
  return { ...next, title, cwd, lastActivity, status, ask };
}
