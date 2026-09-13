import { z } from 'zod';

const Request = z.object({
  requestId: z.string(), sha: z.string(), intent: z.enum(['build-only', 'deploy']),
  state: z.enum(['queued', 'building', 'built', 'waiting-idle', 'activating', 'verifying', 'succeeded', 'failed', 'cancelled', 'unknown']),
  sequence: z.number(), updatedAt: z.string(), artifactReady: z.boolean(), artifactSha256: z.string().nullable(),
  failure: z.object({ stage: z.string(), code: z.string(), effects: z.string() }).nullable(),
  recovery: z.string().nullable(),
});
export const DeliveryStatus = z.object({
  projects: z.array(z.object({
    projectId: z.string(), name: z.string(), environment: z.string(), observedAt: z.string(),
    runtime: z.object({
      available: z.boolean(), error: z.string().nullable(), version: z.string().nullable(), sha: z.string().nullable(),
      artifactSha256: z.string().nullable(), instanceId: z.string().nullable(), healthy: z.boolean(),
      lifecycle: z.object({ restartPending: z.boolean(), reason: z.string().nullable(), inFlight: z.number().nullable() }).nullable(),
    }),
    latest: Request.nullable(), pending: Request.nullable(), prepared: Request.nullable(), waitingReason: z.string().nullable(),
  })),
});
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;
