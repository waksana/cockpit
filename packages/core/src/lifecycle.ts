// lifecycle.ts — pure, unit-testable helpers shared across the Engine's
// lifecycle/correctness paths. Kept dependency-free (only protocol types) so the
// same predicates can be reused by the transport (which only holds a SessionMeta
// snapshot) without pulling in the Engine.

import type { SessionMeta } from '@cockpit/protocol';

// Protect sessions from teardown while work, decisions, or transitions
// remain active. Status alone misses work such as manual compaction and background
// operations. Future schedules and UI pinning do not protect idle sessions.
export function sessionMetaBusy(
  s: Pick<SessionMeta, 'status' | 'ask' | 'planRequest' | 'elicitation' | 'activeSubagents' | 'compacting' | 'activeMcpOperations'>
    & Partial<Pick<SessionMeta, 'loading' | 'closing' | 'cancelling' | 'queue' | 'scheduleCount'>>
    & { activeOperations?: number; nativeProcessing?: boolean },
): boolean {
  return s.status === 'running'
    || !!(s.ask || s.planRequest || s.elicitation)
    || (s.activeSubagents ?? 0) > 0
    || !!s.compacting
    || (s.activeMcpOperations ?? 0) > 0
    || !!(s.loading || s.closing || s.cancelling)
    || (s.queue?.length ?? 0) > 0
    || (s.activeOperations ?? 0) > 0
    || !!s.nativeProcessing;
}

// Engine-authoritative wrapper: ORs the live in-memory in-flight `task` count
// (the Set the Engine maintains) on top of the projected predicate. The Engine
// passes `st.inflightTasks.size`; the meta's `activeSubagents` is the projection
// of that same set, so this is belt-and-suspenders against a not-yet-projected
// add. Exported for reuse (the transport can call `sessionMetaBusy` directly with
// just a snapshot; this overload is for callers that also hold the live count).
export function engineSessionBusy(
  meta: Parameters<typeof sessionMetaBusy>[0],
  inflightTaskCount: number,
): boolean {
  return sessionMetaBusy(meta) || inflightTaskCount > 0;
}
