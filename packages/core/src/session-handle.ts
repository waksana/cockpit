import type { CopilotSession } from '@github/copilot-sdk';
import type { IntentResult, SessionMeta, SessionResource } from '@cockpit/protocol';
import type { RoleAssembly, SessionInstructions } from './roles.ts';

export type DecisionKind = 'ask' | 'planRequest' | 'elicitation';
export interface Decision {
  kind: DecisionKind;
  epoch: number;
  interactionId?: string;
  value: NonNullable<SessionMeta[DecisionKind]>;
  answer: (value: unknown) => void;
  reject: (error: Error) => void;
  validate?: (value: unknown) => void;
}
export interface InterruptTarget { epoch: number; interactionId?: string; decisions: Map<string, Decision> }
export type MutationGate = 'scheduleGate' | 'modelGate' | 'controlGate';

/**
 * Per-session native handle, gates and bookkeeping. It only holds state; the
 * Engine kernel owns admission, publication and retention.
 */
export class SessionHandle {
  readonly id: string;
  roleAssembly?: RoleAssembly;
  instructionSources?: SessionInstructions['sources'];
  creationSubmitted?: boolean;
  observedCwd?: string | null;
  sdk: CopilotSession | null = null;
  controlToken?: string;
  controlGate: Promise<void> = Promise.resolve();
  observedCompaction = false;
  manualCompactions = 0;
  load?: Promise<void>;
  closing = false;
  cancelling?: Promise<void>;
  interrupting?: Promise<IntentResult<'session/interrupt'>>;
  interruptTurn?: InterruptTarget;
  turnEpoch = 0;
  interruptedEpoch?: number;
  interactionId?: string;
  operations = 0;
  // Read-only resource leases retain the handle like operations but are not
  // published as activeOperations, so passive reads emit no SSE frames.
  readLeases = 0;
  mcpOperations = 0;
  sends = 0;
  accepted = new Set<string>();
  steeringAccepted = new Set<string>();
  decisions = new Map<string, Decision>();
  eventOwner?: { closed?: WeakSet<CopilotSession>; contextChanged?: boolean };
  sendReceipts = new Set<string>();
  revision = 0;
  activityRevision = 0;
  scheduleGate: Promise<void> = Promise.resolve();
  resourceWrites = new Map<SessionResource, number>();
  pendingInvalidations = new Set<SessionResource>();
  modelGate: Promise<void> = Promise.resolve();

  constructor(id: string) {
    this.id = id;
  }

  activeOperations(): number {
    return this.operations - this.readLeases;
  }

  localBusy(ownTransition = false): boolean {
    return (!ownTransition && this.closing) || this.operations > 0 || !!this.load
      || !!this.cancelling || this.decisions.size > 0 || this.sends > 0 || this.accepted.size > 0;
  }

  serialize<T>(gate: MutationGate, work: () => Promise<T>): Promise<T> {
    const next = this[gate].then(work);
    this[gate] = next.then(() => {}, () => {});
    return next;
  }

  decisionFields() {
    const decisions = [...this.decisions.values()];
    return {
      ask: decisions.find(d => d.kind === 'ask')?.value as SessionMeta['ask'] ?? null,
      planRequest: decisions.find(d => d.kind === 'planRequest')?.value as SessionMeta['planRequest'] ?? null,
      elicitation: decisions.find(d => d.kind === 'elicitation')?.value as SessionMeta['elicitation'] ?? null,
    };
  }
}
