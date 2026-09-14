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
