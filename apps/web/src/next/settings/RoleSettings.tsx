import { useId } from 'react';
import { Button, Checkbox, Label } from '@cockpit/ui';
import type { ChatSession } from '../../net/types';
import { sameRole, useSessionRoles } from '../../features/session-settings/useSessionRoles';
import { Notice } from './SettingsControls';

export function RoleSettings({ session }: { session: ChatSession }) {
  const roles = useSessionRoles(session);
  const id = useId();
  const { action, catalog } = roles;
  return <section className="next-settings-section" aria-labelledby={`${id}-title`}>
    <div className="next-settings-heading"><h2 id={`${id}-title`}>模块角色</h2>
      <Button variant="outline" disabled={!roles.connected || action.busy} onClick={roles.refresh}>检查保存状态</Button>
    </div>
    <dl className="next-settings-metadata">
      <dt>已保存</dt><dd>{session.roles?.map(role => `${role.moduleId}/${role.roleId}`).join('、') || (session.roles ? '无' : '未读取')}</dd>
      <dt>已应用</dt><dd>{session.appliedRoles?.map(role => `${role.moduleId}/${role.roleId}`).join('、') || (session.appliedRoles ? '无' : '未读取')}</dd>
    </dl>
    <p className="next-settings-muted">角色是配置来源，不代表 MCP 连接或能力就绪。保存仅追加元数据，不会自动重新加载。</p>
    {!roles.connected ? <Notice>等待连接，应用状态未确认。</Notice>
      : !session.loaded ? <Notice>会话未加载；保存的角色将在下次加载时应用。</Notice>
        : session.rolesNeedReload || roles.resultNeedsReload ? <Notice>已保存的角色需要另行显式重新加载会话才会应用。</Notice> : null}
    {action.error && <Notice error>{roles.operation === 'save' ? '追加结果未确认' : '检查失败'}：{action.error}</Notice>}
    {roles.needsInspection && !action.busy && <Notice error>
      追加结果未确认。请先检查保存状态，再显式重试。{roles.result?.error}{roles.result?.recovery}
    </Notice>}
    {roles.result && roles.result.status !== 'uncertain' && <Notice>
      {roles.result.status === 'saved' ? '角色选择已保存，未重新加载会话。' : '角色选择未变。'}
      {roles.result.error}{roles.result.recovery}
    </Notice>}
    {roles.refreshed && <Notice>保存和应用状态已检查；应用不代表能力就绪。</Notice>}
    <Button variant="outline" aria-expanded={roles.open}
      onClick={() => { roles.setOpened(true); roles.setOpen(!roles.open); }}>{roles.open ? '收起角色目录' : '追加模块角色'}</Button>
    {roles.opened && <div hidden={!roles.open}>
      <div className="next-settings-section">
        {roles.blocked && <Notice>请等待连接及会话加载或关闭完成。会话正在运行不妨碍追加元数据。</Notice>}
        {catalog.status && <Notice error={catalog.failed}>{catalog.status}</Notice>}
        {catalog.failed && <Button variant="outline" disabled={!catalog.connected || catalog.pending || action.busy}
          onClick={() => { void catalog.refresh(); }}>重新读取目录</Button>}
        {catalog.usable && !roles.available.length && <Notice>没有尚未添加的可用角色。</Notice>}
        {roles.available.map((role, index) => {
          const checked = roles.additions.some(selected => sameRole(selected, role));
          return <div key={`${role.moduleId}/${role.roleId}`} className="next-settings-role">
            <Checkbox id={`${id}-${index}`} checked={checked} disabled={roles.blocked || action.busy || roles.needsInspection}
              onCheckedChange={next => roles.setSelected(next === true
                ? [...roles.selected, { moduleId: role.moduleId, roleId: role.roleId }]
                : roles.selected.filter(selected => !sameRole(selected, role)))} />
            <div><Label htmlFor={`${id}-${index}`}>{role.moduleName} / {role.name}</Label>
              <p>{role.moduleId}/{role.roleId}</p>{role.description && <p>{role.description}</p>}</div>
          </div>;
        })}
        {roles.additions.length > 64 && <Notice error>每次最多追加 64 个角色。</Notice>}
        <Button disabled={roles.blocked || action.busy || roles.needsInspection || !catalog.usable || !roles.additions.length || roles.additions.length > 64}
          aria-busy={action.busy && roles.operation === 'save'} onClick={roles.submit}>
          {action.busy && roles.operation === 'save' ? '正在保存…' : '保存追加角色'}
        </Button>
      </div>
    </div>}
  </section>;
}
