import { z } from 'zod';

export const ConsumerOperationId = z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/);
export const ConsumerIdentity = z.object({
  authority: z.literal('consumer'), installationId: z.string().uuid(),
  sha: z.string().regex(/^[a-f0-9]{40}$/), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().min(1), instanceId: z.string().uuid(), version: z.string().min(1),
});
export const ConsumerOperation = z.object({
  operationId: ConsumerOperationId, kind: z.string().min(1), state: z.string().min(1),
  updatedAt: z.string(), error: z.string().optional(), observed: ConsumerIdentity.optional(),
});
export type ConsumerOperation = z.infer<typeof ConsumerOperation>;
export const ConsumerStatus = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string().min(1) }),
  z.object({
    available: z.literal(true), installationId: z.string().uuid(),
    health: z.enum(['healthy', 'unavailable', 'stopped']), runtime: ConsumerIdentity.nullable(),
    mainLifecycleReady: z.boolean(), moduleRunnerState: z.string().min(1),
    activeOperationId: ConsumerOperationId.nullable(), operation: ConsumerOperation.nullable(), error: z.string().optional(),
  }),
]);
export type ConsumerStatus = z.infer<typeof ConsumerStatus>;
