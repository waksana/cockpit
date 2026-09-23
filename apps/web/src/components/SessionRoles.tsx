import { useId } from 'react';
import type { ChatSession } from '../net/types';
import { useSessionRoles } from '../features/session-settings/useSessionRoles';
import { RoleBadge } from './ModuleLabel';
import { RolePicker } from './RolePicker';
import { Button, RefreshButton } from './Button';
import { HeadingAction, SectionHeading } from './UI';
import { ResourceStatus, StateNotice } from './StateNotice';

function RolesSection({ session }: { session: ChatSession }) {
  const { open, setOpen, opened, setOpened, catalog, action, setSelected, result, needsInspection,
    operation, refreshed, available, additions, connected, blocked, resultNeedsReload, refresh, submit } = useSessionRoles(session);
  const pickerId = useId();
  return <section className="info-section">
    <SectionHeading className="info-section-name" actions={<>
      <HeadingAction icon="add" aria-label="追加模块角色" aria-expanded={open} aria-controls={opened ? pickerId : undefined}
        onClick={() => { setOpened(true); setOpen(value => !value); }}>追加</HeadingAction>
      <RefreshButton label="刷新模块角色" pending={action.busy && operation === 'refresh'}
        disabled={!connected || action.busy} onClick={refresh} />
    </>}>模块角色</SectionHeading>
    <div className="info-section-content info-controls">
      {session.roles ? session.roles.length ? <div className="session-role-badges" aria-label="已保存的模块角色">
        {session.roles.map(role => <RoleBadge key={`${role.moduleId}/${role.roleId}`}
          role={role} session={session} connected={connected} />)}
      </div> : <span className="info-meta-id-label">无</span>
        : <span className="info-meta-id-label">未读取</span>}
      {!connected ? <StateNotice>等待连接，应用状态未确认。</StateNotice>
        : !session.loaded ? <StateNotice>会话未加载；已保存的角色将在下次加载时应用。</StateNotice>
          : session.rolesNeedReload || resultNeedsReload ? <StateNotice>角色选择已保存，需要另行显式重新加载会话。</StateNotice> : null}
      {action.error && <StateNotice kind="error" className="info-model-status">
        {operation === 'save' ? '追加结果未确认' : '刷新失败'}：{action.error}
      </StateNotice>}
      {needsInspection && !action.busy && <StateNotice kind="error" className="info-model-status">
        {result?.error && `${result.error}。`}追加结果未确认，请先刷新模块角色，再显式重试。
        {result?.recovery && <div>{result.recovery}</div>}
      </StateNotice>}
      {result && result.status !== 'uncertain'
        && (result.status === 'unchanged' || !session.rolesNeedReload && !resultNeedsReload || result.error || result.recovery)
        && <StateNotice className="info-model-status">
        {result.status === 'saved' ? '角色选择已保存，未重新加载会话。' : '角色选择未变。'}
        {result.error && ` ${result.error}`}
        {result.recovery && <div>{result.recovery}</div>}
      </StateNotice>}
      {refreshed && <StateNotice>角色状态已刷新；应用不代表能力就绪。</StateNotice>}
      {opened && <div id={pickerId} hidden={!open}><div className="info-controls">
        {blocked && <StateNotice className="info-model-status">当前不可保存：请等待连接及会话加载或关闭完成。</StateNotice>}
        <ResourceStatus status={catalog.status} failed={catalog.failed} pending={catalog.pending} />
        {catalog.failed && <Button
          disabled={!catalog.connected || catalog.pending || action.busy}
          onClick={() => { void catalog.refresh(); }}>重试读取角色目录</Button>}
        {catalog.usable && (!catalog.data?.length ? <StateNotice kind="empty">没有可用的模块角色。</StateNotice>
          : !available.length ? <StateNotice kind="empty">目录中的角色均已选择，无法重复追加。</StateNotice>
            : <RolePicker roles={available} selected={additions} disabled={blocked || action.busy || needsInspection}
              onChange={setSelected} />)}
        {additions.length > 64 && <StateNotice kind="error">每次最多追加 64 个角色。</StateNotice>}
        <div className="ck-actions">
          <Button variant="primary"
            disabled={blocked || action.busy || needsInspection || !catalog.usable || !additions.length || additions.length > 64}
            aria-busy={action.busy && operation === 'save'} onClick={submit}>保存追加角色</Button>
        </div>
        {action.busy && operation === 'save' && <StateNotice kind="loading">正在保存…</StateNotice>}
      </div></div>}
    </div>
  </section>;
}

export function SessionRoles({ session }: { session: ChatSession }) {
  return <RolesSection key={session.sessionId} session={session} />;
}
