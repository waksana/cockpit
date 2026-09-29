import { createHash, randomUUID } from 'node:crypto';
import type { CopilotSession } from '@github/copilot-sdk';
import type { SessionActivity, SessionControlAction } from '@cockpit/protocol';
import type { DecisionKind, InterruptTarget, SessionHandle } from './session-handle.ts';
import type { SdkEvent } from './sdk-types.ts';

type Log = (message: string, data?: Record<string, unknown>) => void;
type Action = SessionControlAction['type'] | 'cancel' | 'interrupt' | 'prompt' | 'queue/remove';
type Fields = {
  decisionKind?: DecisionKind | 'plan';
  requestId?: string;
  targetId?: string;
  targetCount?: number;
  mode?: 'enqueue' | 'immediate';
};
export type DiagnosticTrace = Fields & {
  operationId: string; action: Action; startedAt: number;
  entryEpoch: number | null; entryInteractionId: string | null; entryHandleId: string | null;
};
type Sample = { afterSequence: number; revision: number; epoch: number; interactionId: string | null; startedAt: number };
const lifecycle = new Set([
  'user.message', 'assistant.turn_start', 'assistant.turn_end', 'abort', 'session.idle',
  'subagent.started', 'subagent.completed', 'subagent.failed', 'pending_messages.modified',
  'session.background_tasks_changed',
]);
const unavailable = 'unavailable';

// Caller-supplied/native opaque IDs are not free-form log fields.
function identity(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value : `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function acknowledgement(result: unknown) {
  const flags: Record<string, boolean> = {};
  if (result && typeof result === 'object') {
    for (const key of ['ok', 'success', 'interrupted', 'cancelled', 'removed', 'steered', 'aborted']) {
      const value = Reflect.get(result, key);
      if (typeof value === 'boolean') flags[key] = value;
    }
  }
  return flags;
}

/** Content-free observations only: no RPCs, timers, native-state cache or control decisions. */
export class SessionDiagnostics {
  private readonly handles = new WeakMap<CopilotSession, string>();
  private sequence = 0;
  private warned = false;

  constructor(private readonly state: (id: string) => SessionHandle | undefined, private readonly logger: () => Log) {}

  private handle(sdk: CopilotSession | null | undefined) {
    if (!sdk) return null;
    let id = this.handles.get(sdk);
    if (!id) { id = randomUUID(); this.handles.set(sdk, id); }
    return id;
  }

  private emit(id: string, event: string, fields: Record<string, unknown> = {}) {
    const st = this.state(id);
    try {
      const sequence = ++this.sequence;
      if (st && event !== 'native.sample') st.diagnosticSampleAfterSequence = sequence;
      this.logger()('session.diagnostic', {
        schemaVersion: 1, event, sequence, at: Date.now(), sessionId: identity(id),
        handleId: this.handle(st?.sdk), epoch: st?.turnEpoch ?? null,
        interactionId: identity(st?.interactionId),
        host: st ? {
          sends: st.sends, accepted: st.accepted.size, operations: st.activeOperations(),
          readLeases: st.readLeases, mcpOperations: st.mcpOperations, decisions: st.decisions.size,
          cancelling: !!st.cancelling, interrupting: !!st.interruptTurn,
        } : unavailable,
        native: unavailable, nativeUnavailableReason: 'not-sampled-at-this-boundary', ...fields,
      });
    } catch {
      // Like native observers, diagnostics must not fail a control or its callback.
      // Report a constant only; the failed logger/error may contain user data.
      if (!this.warned) {
        this.warned = true;
        process.emitWarning('Session diagnostic logger failed', { code: 'COCKPIT_DIAGNOSTIC_LOG_FAILED' });
      }
    }
  }

  private fields(trace: DiagnosticTrace) {
    return {
      operationId: trace.operationId, action: trace.action, entryEpoch: trace.entryEpoch,
      entryInteractionId: trace.entryInteractionId, entryHandleId: trace.entryHandleId,
      decisionKind: trace.decisionKind, requestId: identity(trace.requestId),
      targetId: identity(trace.targetId), targetCount: trace.targetCount, mode: trace.mode,
    };
  }

  beginSample(st: SessionHandle): Sample | undefined {
    const afterSequence = st.diagnosticSampleAfterSequence;
    if (afterSequence === undefined) return undefined;
    st.diagnosticSampleAfterSequence = undefined;
    return { afterSequence, revision: st.revision, epoch: st.turnEpoch,
      interactionId: identity(st.interactionId), startedAt: Date.now() };
  }

  async operation<T>(id: string, action: Action, fields: Fields, work: (trace: DiagnosticTrace) => Promise<T>): Promise<T> {
    const st = this.state(id);
    const trace: DiagnosticTrace = { ...fields, action, operationId: randomUUID(), startedAt: Date.now(),
      entryEpoch: st?.turnEpoch ?? null, entryInteractionId: identity(st?.interactionId),
      entryHandleId: this.handle(st?.sdk) };
    this.emit(id, 'operation.start', this.fields(trace));
    try {
      const result = await work(trace);
      this.emit(id, 'operation.end', { ...this.fields(trace), outcome: 'returned',
        acknowledgement: acknowledgement(result), durationMs: Date.now() - trace.startedAt });
      return result;
    } catch (error) {
      this.emit(id, 'operation.end', { ...this.fields(trace), outcome: 'threw',
        durationMs: Date.now() - trace.startedAt });
      throw error;
    }
  }

  async native<T>(id: string, trace: DiagnosticTrace, sdk: CopilotSession, method: string, work: () => Promise<T>,
    targetId?: string, target?: Pick<InterruptTarget, 'epoch' | 'interactionId'>): Promise<T> {
    const st = this.state(id);
    const fields = { ...this.fields(trace), method, ...(targetId ? { targetId: identity(targetId) } : {}),
      targetHandleId: this.handle(sdk), targetEpoch: target?.epoch ?? st?.turnEpoch ?? null,
      targetInteractionId: identity(target ? target.interactionId : st?.interactionId) };
    const startedAt = Date.now();
    this.emit(id, 'native.start', fields);
    try {
      const result = await work();
      this.emit(id, 'native.ack', { ...fields, acknowledgement: acknowledgement(result),
        ...(method === 'session.send' ? { messageId: identity(result) } : {}),
        durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.emit(id, 'native.error', { ...fields, outcome: 'unconfirmed', durationMs: Date.now() - startedAt });
      throw error;
    }

  }

  step(id: string, trace: DiagnosticTrace, method: string, targetId: string | undefined,
    outcome: 'accepted' | 'unchanged' | 'failed' | 'unconfirmed') {
    this.emit(id, 'control.step', { ...this.fields(trace), method, targetId: identity(targetId), outcome });
  }

  decision(st: SessionHandle, kind: DecisionKind, requestId: string, outcome: 'pending' | 'answered' | 'rejected',
    epoch: number, interactionId: string | undefined) {
    this.emit(st.id, 'decision.settlement', {
      decisionKind: kind, requestId: identity(requestId), outcome,
      targetEpoch: epoch, targetInteractionId: identity(interactionId),
    });
  }

  observe(st: SessionHandle, event: SdkEvent, root: boolean) {
    if (!lifecycle.has(event.type)) return;
    this.emit(st.id, 'native.event', {
      nativeEvent: event.type, eventId: identity(event.id), scope: root ? 'primary' : 'agent',
      eventInteractionId: identity(event.data.interactionId),
      agentId: identity(event.agentId ?? event.data.agentId),
      toolCallId: identity(event.data.toolCallId),
      parentToolCallId: identity(event.parentToolCallId ?? event.data.parentToolCallId),
      eventTurnId: identity(event.data.turnId),
      messageId: identity(event.type === 'user.message' ? event.data.messageId : undefined),
      cancelled: typeof event.data.cancelled === 'boolean' ? event.data.cancelled : undefined,
      queueDrain: unavailable,
    });
  }

  sample(st: SessionHandle, sdk: CopilotSession, sample: Sample, summary?: SessionActivity) {
    this.emit(st.id, 'native.sample', {
      afterSequence: sample.afterSequence, readStartedAt: sample.startedAt,
      durationMs: Date.now() - sample.startedAt, readEpoch: sample.epoch,
      readInteractionId: sample.interactionId, readRevision: sample.revision,
      currentRevision: st.revision, sameHandle: st.sdk === sdk,
      nativeUnavailableReason: summary ? undefined : 'read-failed',
      native: summary ? {
        sampledAt: summary.sampledAt, processing: summary.processing,
        hasActiveWork: summary.hasActiveWork, abortable: summary.abortable,
        tasks: { activeAgents: summary.tasks.activeAgents, activeShells: summary.tasks.activeShells, unknown: summary.tasks.unknown },
        queue: { pendingCount: summary.queue.pendingCount, steeringCount: summary.queue.steeringCount,
          inFlightSteeringCount: summary.queue.inFlightSteeringCount },
        mcp: { pendingConnectionCount: summary.mcp.pendingConnectionCount },
        atomic: false, sameRevision: sample.revision === st.revision,
        turnActive: unavailable, pendingSendAdmission: unavailable, operationGateOwners: unavailable,
        backgroundNotificationOwners: unavailable, deferredIdle: unavailable, queueDrain: unavailable,
      } : unavailable,
    });
  }
}
