import { z } from 'zod';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const JsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValue), z.record(JsonValue),
]));
export const ModuleId = z.enum(['assistant', 'task', 'wechat']);
export const ModuleSelection = z.object({
  moduleId: ModuleId,
  roleId: z.string().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().min(1).max(80).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/).optional(),
}).strict();
export type ModuleSelection = z.infer<typeof ModuleSelection>;

export const ModuleSelections = z.array(ModuleSelection).max(8).superRefine((selections, ctx) => {
  const names = new Set<string>();
  for (const selection of selections) {
    if (names.has(selection.moduleId)) ctx.addIssue({ code: 'custom',
      message: `Choose only one role from module ${selection.moduleId}` });
    names.add(selection.moduleId);
  }
});
export const AppliedModuleSelection = ModuleSelection.extend({ version: z.string().min(1) });
export type AppliedModuleSelection = z.infer<typeof AppliedModuleSelection>;
export const SessionModules = z.object({
  sessionId: z.string(),
  selections: z.array(AppliedModuleSelection),
  pendingSelections: z.array(AppliedModuleSelection).optional(),
  phase: z.enum(['preparing', 'applied', 'failed', 'unknown']),
  operationId: z.string(),
  error: z.string().optional(),
  nativePresent: z.boolean().optional(),
});
export type SessionModules = z.infer<typeof SessionModules>;

export const ModuleUnbindOperation = z.object({
  operationId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/),
  sessionId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  state: z.enum(['working', 'succeeded', 'failed', 'unknown']), error: z.string().optional(),
}).strict();
export type ModuleUnbindOperation = z.infer<typeof ModuleUnbindOperation>;

export const ModuleServiceId = z.enum(['task', 'wechat']);
export const ModuleServiceCommand = z.object({
  operationId: z.string().min(8).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  id: ModuleServiceId,
  action: z.enum(['start', 'stop', 'apply']),
  version: z.string().max(80).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/).optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  recoveryOf: z.string().min(8).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).optional(),
  confirmRecovery: z.literal(true).optional(),
}).strict();
export type ModuleServiceCommand = z.infer<typeof ModuleServiceCommand>;
export const ModuleServiceRequest = ModuleServiceCommand.omit({ id: true }).extend({ moduleId: ModuleServiceId })
  .superRefine((request, ctx) => {
    if (request.action === 'stop' ? request.version !== undefined || request.digest !== undefined : !request.version || !request.digest) {
      ctx.addIssue({ code: 'custom', message: 'Start/apply require the exact installed version and digest; stop does not select a release' });
    }
    if ((request.recoveryOf !== undefined || request.confirmRecovery !== undefined)
      && (request.action !== 'stop' || !request.recoveryOf || request.confirmRecovery !== true)) {
      ctx.addIssue({ code: 'custom', message: 'Recovery requires an explicit safe stop referencing the unresolved operation' });
    }
  });
export const ModuleServiceIdentity = z.object({
  moduleId: ModuleServiceId, moduleVersion: z.string(),
  moduleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  instanceId: z.string().min(8).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
}).strict();
export const ModuleServiceJob = z.object({
  schemaVersion: z.literal(1), command: ModuleServiceCommand,
  phase: z.enum(['accepted', 'running', 'waiting', 'done', 'failed', 'unknown']),
  step: z.enum(['queued', 'starting', 'verifying', 'draining', 'waiting-exit', 'complete']),
  acceptedAt: z.string().datetime(), updatedAt: z.string().datetime(),
  reason: z.string().optional(),
  result: z.object({
    state: z.enum(['running', 'stopped']), identity: ModuleServiceIdentity.optional(),
  }).strict().optional(),
}).strict();
export type ModuleServiceJob = z.infer<typeof ModuleServiceJob>;
export const ModuleServiceStatus = z.object({
  id: ModuleServiceId,
  status: z.enum(['stopped', 'starting', 'running', 'draining', 'failed', 'unknown']),
  owned: z.boolean(), recoveryRequired: z.boolean(),
  canRecoverStop: z.boolean().optional(),
  identity: ModuleServiceIdentity.optional(), expectedIdentity: ModuleServiceIdentity.optional(),
  pid: z.number().int().positive().optional(), expectedPid: z.number().int().positive().optional(),
  job: ModuleServiceJob.optional(), reason: z.string().optional(),
}).strict();
export type ModuleServiceStatus = z.infer<typeof ModuleServiceStatus>;

export const ModuleStatus = z.object({
  id: ModuleId, name: z.string(), description: z.string(),
  installed: z.array(z.object({ version: z.string(), digest: z.string() })),
  selectedVersion: z.string().nullable(),
  roles: z.array(z.object({
    roleId: z.string(), name: z.string(), description: z.string(), available: z.boolean(),
    reason: z.string().optional(), boundSessionId: z.string().optional(),
  })),
  service: z.object({
    ownership: z.enum(['none', 'managed', 'external']),
    status: z.enum(['stopped', 'starting', 'running', 'draining', 'failed', 'unknown']),
    version: z.string().optional(), instanceId: z.string().optional(), reason: z.string().optional(),
    digest: z.string().optional(), runner: ModuleServiceStatus.optional(),
  }),
  page: z.string().optional(),
  supportsInitialization: z.boolean().optional(),
  localRelease: z.object({ version: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  localSourceError: z.string().optional(),
});
export type ModuleStatus = z.infer<typeof ModuleStatus>;

export const ModuleConfig = z.object({
  moduleId: ModuleId,
  revision: z.number().int().nonnegative(),
  configVersion: z.number().int().positive(),
  values: z.record(JsonValue),
});
export type ModuleConfig = z.infer<typeof ModuleConfig>;

export const ModuleInitializationRequest = z.object({
  moduleId: z.literal('task'), operationId: ModuleServiceCommand.shape.operationId,
  version: ModuleServiceCommand.shape.version.unwrap(), digest: ModuleServiceCommand.shape.digest.unwrap(),
  gatewayUrl: z.string().url().pipe(z.string().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  }, 'A canonical HTTPS public origin is required')),
  confirm: z.literal(true),
}).strict();
export type ModuleInitializationRequest = z.infer<typeof ModuleInitializationRequest>;
export const ModuleInitializationOperation = ModuleInitializationRequest.omit({ confirm: true }).extend({
  phase: z.enum(['preparing', 'succeeded', 'failed', 'unknown']),
  updatedAt: z.number().int().nonnegative(), config: ModuleConfig.optional(), reason: z.string().optional(),
}).strict();
export type ModuleInitializationOperation = z.infer<typeof ModuleInitializationOperation>;

export const ModuleReleaseTarget = z.object({
  moduleId: ModuleId, version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/),
  platform: z.literal('linux'), arch: z.literal('x64'), nodeMajor: z.literal(24),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(400 * 1024 * 1024), url: z.string().url(),
}).strict();
export type ModuleReleaseTarget = z.infer<typeof ModuleReleaseTarget>;
export const ModuleReleaseMetadata = z.object({
  schemaVersion: z.literal(1), channel: z.literal('stable'), sequence: z.number().int().positive(),
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), targets: z.array(ModuleReleaseTarget).max(30),
}).strict();
export type ModuleReleaseMetadata = z.infer<typeof ModuleReleaseMetadata>;
export const SignedModuleRelease = z.object({ payload: z.string().max(300_000), signature: z.string().max(200) }).strict();
export const ModuleUpdateOperation = z.object({
  operationId: z.string(), moduleId: ModuleId, version: z.string(), sha256: z.string(),
  source: z.literal('local').optional(),
  state: z.enum(['downloading', 'extracting', 'installing', 'succeeded', 'failed', 'unknown']),
  updatedAt: z.number(), error: z.string().optional(), installedDigest: z.string().optional(),
});
export type ModuleUpdateOperation = z.infer<typeof ModuleUpdateOperation>;
