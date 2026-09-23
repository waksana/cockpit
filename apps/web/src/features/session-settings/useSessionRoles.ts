import { useState } from 'react';
import type { IntentResult, RoleSelection, SessionProjection } from '@cockpit/protocol';
import { useCockpit } from '../../net/store';
import { cockpitApi, loadRoleCatalog } from '../../net/api';
import type { ChatSession } from '../../net/types';
import { useKeyedAction, useKeyedResource } from '../../lib/useKeyedResource';
import { useHostUnsavedChanges } from '../../lib/hostLeave';

export const sameRole = (a: RoleSelection, b: RoleSelection) => a.moduleId === b.moduleId && a.roleId === b.roleId;
export function roleAdditionBlocked(session?: ChatSession) {
  return !session || Boolean(session.loading || session.closing);
}
export function useSessionRoles(session: ChatSession) {
  const sid = session.sessionId;
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const snapshotReady = useCockpit(state => state.snapshotReady);
  const catalog = useKeyedResource(`role-catalog:${sid}`, loadRoleCatalog, 0, opened);
  const action = useKeyedAction(`role-action:${sid}`);
  const [selected, setSelected] = useState<RoleSelection[]>([]);
  const [result, setResult] = useState<IntentResult<'roles/add'> | null>(null);
  const [needsInspection, setNeedsInspection] = useState(false);
  const [operation, setOperation] = useState<'save' | 'refresh'>('refresh');
  const [refreshed, setRefreshed] = useState(false);
  const savedRoles = session.roles ?? [];
  const available = catalog.usable ? catalog.data?.filter(role => !savedRoles.some(saved => sameRole(role, saved))) ?? [] : [];
  const additions = selected.filter(role => available.some(option => sameRole(role, option)));
  const connected = action.connected && snapshotReady;
  const blocked = roleAdditionBlocked(session) || !connected;
  const resultNeedsReload = result?.rolesNeedReload
    && result.roles.some(role => !session.appliedRoles?.some(applied => sameRole(role, applied)));
  useHostUnsavedChanges(selected.some(role => !savedRoles.some(saved => sameRole(role, saved))));
  const refresh = () => {
    if (action.busy || !connected) return;
    setOperation('refresh');
    setRefreshed(false);
    let next: SessionProjection;
    void action.run(async signal => {
      next = await useCockpit.getState().refreshRoles(sid, signal);
      if (next.sessionId !== sid) throw new Error('返回的会话 ID 不匹配，请刷新原会话');
      if (!next.roles || !next.appliedRoles || next.rolesNeedReload === undefined) {
        throw new Error('角色保存或应用状态未确认，请重新刷新');
      }
    }, () => {
      setSelected(roles => roles.filter(role => !next.roles!.some(saved => sameRole(role, saved))));
      setNeedsInspection(false);
      setResult(null);
      setRefreshed(true);
    });
  };
  const submit = () => {
    const current = useCockpit.getState().sessions.find(row => row.sessionId === sid);
    if (blocked || roleAdditionBlocked(current) || action.busy || needsInspection
      || !catalog.usable || !additions.length || additions.length > 64) return;
    setOperation('save');
    setNeedsInspection(true);
    setResult(null);
    setRefreshed(false);
    let next: IntentResult<'roles/add'>;
    void action.run(async () => {
      next = await cockpitApi.addRoles(sid, additions);
      if (next.sessionId !== sid) throw new Error('返回的会话 ID 不匹配，请刷新原会话');
    }, () => {
      setResult(next);
      if (next.status === 'saved' || next.status === 'unchanged') {
        setSelected([]);
        setNeedsInspection(false);
      }
    });
  };
  return { open, setOpen, opened, setOpened, catalog, action, selected, setSelected, result, needsInspection, operation,
    refreshed, available, additions, connected, blocked, resultNeedsReload, refresh, submit };
}
