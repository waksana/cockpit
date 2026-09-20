import type { SessionRole } from '@cockpit/protocol';

export function ModuleLabel({ name, id, description }: { name: string; id: string; description?: string }) {
  return <span className="module-label" title={`模块：${name} (${id})${description ? `；${description}` : ''}`}>
    <span className="module-mark" aria-hidden="true" />
    <span className="module-label-name">{name}</span>
  </span>;
}

export function RoleBadge({ role }: { role: SessionRole }) {
  return <span className="role-badge" title={`模块：${role.moduleName} · 角色：${role.name}；不代表当前能力就绪`}>
    <ModuleLabel name={role.moduleName} id={role.moduleId} />
    <span className="role-badge-name">{role.name}</span>
  </span>;
}
