import type { SessionMeta } from '@cockpit/protocol';

export function activityFixture(patch: Partial<NonNullable<SessionMeta['activity']>> = {}): NonNullable<SessionMeta['activity']> {
  return {
    sampledAt: 1_790_000_000_000, processing: false, hasActiveWork: false, abortable: false,
    tasks: { activeAgents: 0, activeShells: 0, unknown: 0 },
    queue: { pendingCount: 0, steeringCount: 0, inFlightSteeringCount: 0 },
    mcp: { pendingConnectionCount: 0 },
    ...patch,
  };
}
