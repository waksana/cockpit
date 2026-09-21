import type { ModuleSource, SessionMeta, SessionRole } from '@cockpit/protocol';

export function ModuleLabel({ name, id, description }: { name: string; id: string; description?: string }) {
  return <span className="module-label" title={`模块：${name} (${id})${description ? `；${description}` : ''}`}>
    <span className="module-label-name">{name}</span>
  </span>;
}

export function ModuleSourceBadge({ module, description }: { module: ModuleSource; description?: string }) {
  if (!module.roles?.length) return <ModuleLabel name={module.name} id={module.id} description={description} />;
  return <span className="role-badge"
    title={`模块：${module.name} (${module.id}) · 来源角色：${module.roles.map(role => `${role.name} (${role.id})`).join('、')}；不代表授权、启用或就绪${description ? `；${description}` : ''}`}>
    <ModuleLabel name={module.name} id={module.id} description={description} />
    <span className="role-badge-name">{module.roles.map(role => role.name).join('、')}</span>
  </span>;
}

export function RoleBadge({ role, session, connected }: {
  role: SessionRole;
  session: Pick<SessionMeta, 'loaded' | 'appliedRoles'>;
  connected: boolean;
}) {
  const applied = connected && session.loaded === true
    && session.appliedRoles?.some(value => value.moduleId === role.moduleId && value.roleId === role.roleId);
  const status = !connected || session.loaded && !session.appliedRoles ? '应用状态未确认'
    : applied ? '已应用' : '未应用';
  return <span className="role-badge" data-unapplied={!applied || undefined}
    title={`模块：${role.moduleName} · 角色：${role.name}；${status}；不代表当前能力就绪`}>
    <ModuleLabel name={role.moduleName} id={role.moduleId} />
    <span className="role-badge-name">{role.name}</span>
    <span className="chat-sr-only">（{status}，不代表能力就绪）</span>
  </span>;
}
