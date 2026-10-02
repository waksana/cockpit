import { useId } from 'react';
import type { RoleAvailability, RoleSelection, SessionRole } from '@cockpit/protocol';
import { ModuleLabel } from './ModuleLabel';
import { CheckboxCard } from './UI';
import { Button } from './Button';
import type { RoleAvailabilityResource } from '../features/session-settings/useRoleAvailability';

export function RoleReasons({ result }: { result?: RoleAvailability }) {
  return result?.reasons.map((reason, index) => <span className="role-option-description" key={index}>
    {reason.status === 'unknown' ? '未确认' : '不可选'} · {reason.source.kind === 'host' ? 'Host' : reason.source.moduleId}
    {reason.roles.length ? ` · ${reason.roles.map(role => `${role.moduleId}/${role.roleId}`).join(', ')}` : ''}
    {reason.capabilities.length ? ` · ${reason.capabilities.join(', ')}` : ''}：{reason.message}
  </span>);
}

export function RolePicker({ roles, selected, disabled, onChange, availability }: {
  roles: Array<SessionRole & { description?: string }>;
  selected: RoleSelection[];
  disabled: boolean;
  onChange: (selected: RoleSelection[]) => void;
  availability: RoleAvailabilityResource;
}) {
  const id = useId();
  return <fieldset className="role-picker" disabled={disabled}>
    <legend>模块角色</legend>
    <Button disabled={disabled || availability.pending || !availability.connected}
      onClick={() => void availability.refresh()}>重新查询可选角色</Button>
    {availability.pending && <span role="status">正在查询角色可用性…</span>}
    <RoleReasons result={availability.data?.selection} />
    <div className="role-picker-options">
      {roles.map((role, index) => {
        const selectedHere = selected.some(value => value.moduleId === role.moduleId && value.roleId === role.roleId);
        const identity = `${id}-${index}`;
        const result = selectedHere ? undefined : availability.data?.candidates.get(`${role.moduleId}/${role.roleId}`);
        return <CheckboxCard className="role-option" key={`${role.moduleId}/${role.roleId}`} checked={selectedHere}
            disabled={!selectedHere && (!availability.valid || result?.status !== 'available')}
            aria-labelledby={`${identity}-name ${identity}-module`}
            aria-describedby={`${identity}-description`}
            onChange={event => onChange(event.target.checked
              ? [...selected, { moduleId: role.moduleId, roleId: role.roleId }]
              : selected.filter(value => value.moduleId !== role.moduleId || value.roleId !== role.roleId))}>
            <span className="role-option-heading">
              <span className="role-option-name" id={`${identity}-name`}>{role.name}</span>
              <span id={`${identity}-module`}><ModuleLabel name={role.moduleName} id={role.moduleId} /></span>
            </span>
            <span id={`${identity}-description`}>
              {role.description && <span className="role-option-description">{role.description}</span>}
              <RoleReasons result={result} />
            </span>
        </CheckboxCard>;
      })}
    </div>
  </fieldset>;
}
