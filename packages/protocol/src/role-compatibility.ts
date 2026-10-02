import type { RoleAvailability, RoleAvailabilityReason, RoleCatalogEntry, RoleSelection } from './index.ts';

const key = (role: RoleSelection) => `${role.moduleId}/${role.roleId}`;

/** Structural declarations only: no tool-name overlap or semantic inference. */
export function roleCompatibilityReasons(selections: RoleSelection[], catalog: RoleCatalogEntry[]): RoleAvailabilityReason[] {
  const selected = [...new Map(selections.map(role => [key(role), role])).values()];
  const reasons: RoleAvailabilityReason[] = [];
  const deny = (code: string, message: string, roles: RoleSelection[], capabilities: RoleAvailabilityReason['capabilities'] = []) =>
    reasons.push({ code, message, roles: roles.map(({ moduleId, roleId }) => ({ moduleId, roleId })),
      capabilities, source: { kind: 'host' }, status: 'denied' });
  if (selected.length > 64) deny('ROLE_LIMIT', 'A session can select at most 64 roles', []);
  const found: RoleCatalogEntry[] = [];
  for (const selection of selected) {
    const role = catalog.find(role => key(role) === key(selection));
    if (!role) deny('ROLE_NOT_FOUND', `Unknown module role (unavailable): ${key(selection)}`, [selection]);
    else found.push(role);
  }
  for (let i = 0; i < found.length; i++) {
    for (const other of found.slice(i + 1)) {
      const first = found[i]!;
      const exclusive = first.resourcePolicy === 'exclusive' ? first : other.resourcePolicy === 'exclusive' ? other : undefined;
      if (!exclusive) continue;
      const peer = exclusive === first ? other : first;
      const capabilities = peer.resourcePolicy === 'exclusive' ? ['exclusive' as const] : peer.capabilities ?? [];
      if (capabilities.length) deny('ROLE_EXCLUSIVE_CONFLICT',
        `Exclusive role ${key(exclusive)} conflicts with ${key(peer)} (${capabilities.join(', ')})`,
        [exclusive, peer], capabilities);
    }
  }
  return reasons;
}

export function roleAvailability(roles: RoleSelection[], reasons: RoleAvailabilityReason[], sessionId?: string): RoleAvailability {
  return { roles: roles.map(({ moduleId, roleId }) => ({ moduleId, roleId })),
    ...(sessionId ? { sessionId } : {}), reasons,
    status: reasons.some(reason => reason.status === 'denied') ? 'unavailable' : reasons.length ? 'unknown' : 'available' };
}

export function assertRoleCompatibility(roles: RoleSelection[], catalog: RoleCatalogEntry[]): void {
  const result = roleAvailability(roles, roleCompatibilityReasons(roles, catalog));
  if (result.status !== 'available') throw Object.assign(new Error(result.reasons.map(reason => reason.message).join('; ')), {
    code: 'ROLE_SELECTION_UNAVAILABLE', statusCode: 409, roleAvailability: result,
  });
}
