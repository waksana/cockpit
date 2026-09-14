import { z } from 'zod';

// These projections have no SDK dependency. Open statuses and passthrough fields
// preserve native outcomes instead of inferring success from an incomplete ACK.
const ModelSwitchConfirmation = z.object({
  targetModelDisplayName: z.string(),
  currentTokens: z.number(),
  targetLimit: z.number(),
}).passthrough();

export const NativeModelSwitchResult = z.object({
  modelId: z.string().optional(),
  deferred: z.boolean().optional().describe('True means queued, not applied, even when native status says applied.'),
  status: z.string().optional().describe('Native lifecycle status; missing or unknown values do not establish application. Check deferred and follow-up fields first.'),
  confirmation: ModelSwitchConfirmation.optional(),
  persistenceError: z.string().optional(),
  message: z.string().optional(),
  warning: z.string().optional(),
  deprecationWarnings: z.array(z.string()).optional(),
  modelState: z.object({
    modelId: z.string().optional(),
    reasoningEffort: z.string().optional(),
    contextTier: z.string().optional(),
    autoTier: z.string().optional(),
    pendingAutoTier: z.string().nullable().optional(),
    activatingAutoTier: z.string().nullable().optional(),
  }).passthrough().optional().describe('Native current state returned with the acknowledgement; a deferred selection is not yet reflected here.'),
}).passthrough();
export type NativeModelSwitchResult = z.infer<typeof NativeModelSwitchResult>;

export const NativeModeSetResult = z.object({
  status: z.string(),
  modelChanged: z.boolean(),
  confirmation: ModelSwitchConfirmation.optional(),
  warning: z.string().optional(),
  message: z.string().optional(),
  deprecationWarnings: z.array(z.string()).optional(),
  deferImplementation: z.boolean().optional(),
  armInteractiveContinuation: z.boolean().optional(),
}).passthrough();
export type NativeModeSetResult = z.infer<typeof NativeModeSetResult>;

export const NativeCompactResult = z.object({
  success: z.boolean(),
  tokensRemoved: z.number(),
  messagesRemoved: z.number(),
  summaryContent: z.string().optional(),
  contextWindow: z.object({
    tokenLimit: z.number(),
    currentTokens: z.number(),
    messagesLength: z.number(),
    systemTokens: z.number().optional(),
    conversationTokens: z.number().optional(),
    toolDefinitionsTokens: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();
export type NativeCompactResult = z.infer<typeof NativeCompactResult>;

export const NativeRewindResult = z.object({
  outcome: z.string(),
  eventsRemoved: z.number().optional(),
  restoredFiles: z.array(z.string()),
  skippedFiles: z.array(z.object({ path: z.string(), reason: z.string() }).passthrough()),
  error: z.string().optional(),
}).passthrough();
export type NativeRewindResult = z.infer<typeof NativeRewindResult>;

export interface NativeOperationClassification {
  state: 'applied' | 'unchanged' | 'queued' | 'failed' | 'needs-action' | 'unknown';
  isError: boolean;
  persistenceFailed: boolean;
}

function switchState(status: string | undefined): NativeOperationClassification['state'] {
  switch (status) {
    case 'applied':
    case 'unchanged': return status;
    case 'queued':
    case 'deferred': return 'queued';
    case 'rejected':
    case 'cancelled':
    case 'failed': return 'failed';
    case 'confirmation_required': return 'needs-action';
    default: return 'unknown';
  }
}

// Consumer-only interpretation: never rewrite the native result, infer success
// from modelState/message, or treat an unfamiliar lifecycle status as a failure.
export function classifyNativeModelSwitchResult(result: NativeModelSwitchResult): NativeOperationClassification {
  let state = result.deferred === true ? 'queued' : switchState(result.status);
  if (state !== 'queued' && state !== 'failed' && result.confirmation) state = 'needs-action';
  const persistenceFailed = result.persistenceError !== undefined;
  return { state, isError: state === 'failed' || persistenceFailed, persistenceFailed };
}

export function classifyNativeModeSetResult(result: NativeModeSetResult): NativeOperationClassification {
  let state = switchState(result.status);
  if (state !== 'queued' && state !== 'failed'
    && (result.confirmation || result.deferImplementation || result.armInteractiveContinuation)) state = 'needs-action';
  return { state, isError: state === 'failed', persistenceFailed: false };
}

export function classifyNativeCompactResult(result: NativeCompactResult): NativeOperationClassification {
  return { state: result.success ? 'applied' : 'failed', isError: !result.success, persistenceFailed: false };
}

export function classifyNativeRewindResult(result: NativeRewindResult): NativeOperationClassification {
  let state: NativeOperationClassification['state'];
  switch (result.outcome) {
    case 'success': state = 'applied'; break;
    case 'session-busy':
    case 'file-change-tracking-disabled':
    case 'unsupported-remote-session':
    case 'files-rolled-back':
    case 'rollback-incomplete':
    case 'truncation-failed':
    case 'checkpoint-cleanup-failed':
    case 'snapshot-prune-failed': state = 'failed'; break;
    default: state = 'unknown';
  }
  return { state, isError: state === 'failed' || result.error !== undefined, persistenceFailed: false };
}
