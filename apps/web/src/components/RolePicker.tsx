import { useId } from 'react';
import type { RoleSelection, SessionRole } from '@cockpit/protocol';
import { ModuleLabel } from './ModuleLabel';
import { CheckboxCard } from './UI';

export function RolePicker({ roles, selected, disabled, onChange }: {
  roles: Array<SessionRole & { description?: string }>;
  selected: RoleSelection[];
  disabled: boolean;
  onChange: (selected: RoleSelection[]) => void;
}) {
  const id = useId();
  return <fieldset className="role-picker" disabled={disabled}>
    <legend>模块角色</legend>
    <div className="role-picker-options">
      {roles.map((role, index) => {
        const selectedHere = selected.some(value => value.moduleId === role.moduleId && value.roleId === role.roleId);
        const identity = `${id}-${index}`;
        return <CheckboxCard className="role-option" key={`${role.moduleId}/${role.roleId}`} checked={selectedHere}
            aria-labelledby={`${identity}-name ${identity}-module`}
            aria-describedby={role.description ? `${identity}-description` : undefined}
            onChange={event => onChange(event.target.checked
              ? [...selected, { moduleId: role.moduleId, roleId: role.roleId }]
              : selected.filter(value => value.moduleId !== role.moduleId || value.roleId !== role.roleId))}>
            <span className="role-option-heading">
              <span className="role-option-name" id={`${identity}-name`}>{role.name}</span>
              <span id={`${identity}-module`}><ModuleLabel name={role.moduleName} id={role.moduleId} /></span>
            </span>
            {role.description && <span className="role-option-description" id={`${identity}-description`}>{role.description}</span>}
        </CheckboxCard>;
      })}
    </div>
  </fieldset>;
}
