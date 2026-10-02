import { useCallback, useMemo } from 'react';
import { RoleCatalogEntry, RoleSelection, roleAvailability, roleCompatibilityReasons } from '@cockpit/protocol';
import { cockpitApi } from '../../net/api';
import { useKeyedResource } from '../../lib/useKeyedResource';

const roleKey = (role: RoleSelection) => `${role.moduleId}/${role.roleId}`;

export function useRoleAvailability(catalog: RoleCatalogEntry[], selected: RoleSelection[], enabled: boolean,
  sessionId?: string, saved: RoleSelection[] = []) {
  const selections = (roles: RoleSelection[]) => roles.map(({ moduleId, roleId }) => ({ moduleId, roleId }));
  const identity = JSON.stringify([catalog, selections(selected), selections(saved), sessionId]);
  const input = useMemo(() => {
    const [catalog, selected, saved, sessionId] = JSON.parse(identity);
    return { catalog: RoleCatalogEntry.array().parse(catalog), selected: RoleSelection.array().parse(selected),
      saved: RoleSelection.array().parse(saved), sessionId: typeof sessionId === 'string' ? sessionId : undefined };
  }, [identity]);
  const load = useCallback(async (signal: AbortSignal) => {
    if (!input.catalog.length && !input.selected.length && !input.saved.length) {
      return { selection: roleAvailability([], [], input.sessionId), candidates: new Map() };
    }
    const check = async (roles: RoleSelection[]) => {
      try { return await cockpitApi.roleAvailability({ roles, sessionId: input.sessionId }, signal); }
      catch {
        const combined = [...input.saved, ...roles];
        return roleAvailability(combined, [...roleCompatibilityReasons(combined, input.catalog), {
          code: 'ROLE_QUERY_FAILED', message: '查询失败，模块可用性未确认；请重新查询。',
          status: 'unknown', source: { kind: 'host' }, roles: [], capabilities: [],
        }], input.sessionId);
      }
    };
    const selection = check(input.selected);
    const candidates = await Promise.all(input.catalog
      .filter(role => !input.selected.some(selected => roleKey(selected) === roleKey(role)))
      .map(async role => [roleKey(role), await check([...input.selected, { moduleId: role.moduleId, roleId: role.roleId }])] as const));
    return { selection: await selection, candidates: new Map(candidates) };
  }, [input]);
  const resource = useKeyedResource(`role-availability:${identity}`, load, 0, enabled);
  return { ...resource, allowed: resource.valid && resource.data?.selection.status === 'available' };
}

export type RoleAvailabilityResource = ReturnType<typeof useRoleAvailability>;
