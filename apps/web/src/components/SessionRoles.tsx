import { useState } from 'react';
import type { IntentResult, RoleSelection, SessionProjection } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import type { ChatSession } from '../net/types';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { RoleBadge } from './ModuleLabel';
import { RolePicker } from './RolePicker';
import { RefreshButton, ResourceStatus } from './SessionPanelKit';
import { SectionHeading } from './UI';
import { StateNotice } from './StateNotice';

const sameRole = (a: RoleSelection, b: RoleSelection) => a.moduleId === b.moduleId && a.roleId === b.roleId;

function roleAdditionBlocked(session?: ChatSession) {
  return !session || Boolean(session.loading || session.closing);
}

function RolesSection({ session }: { session: ChatSession }) {
  const sid = session.sessionId;
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const listRoles = useCockpit(state => state.listRoles);
  const snapshotReady = useCockpit(state => state.snapshotReady);
  const catalog = useKeyedResource(`role-catalog:${sid}`, listRoles, 0, opened);
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
      next = await useCockpit.getState().addRoles(sid, additions);
      if (next.sessionId !== sid) throw new Error('返回的会话 ID 不匹配，请刷新原会话');
    }, () => {
      setResult(next);
      if (next.status === 'saved' || next.status === 'unchanged') {
        setSelected([]);
        setNeedsInspection(false);
      }
    });
  };
  return <section className="info-section">
    <SectionHeading className="info-section-name" actions={
      <RefreshButton label="刷新模块角色" pending={action.busy && operation === 'refresh'}
        disabled={!connected || action.busy} onClick={refresh} />}>模块角色</SectionHeading>
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
      <button type="button" className="dialog-btn ck-button rp" aria-expanded={open}
        onClick={() => { setOpened(true); setOpen(value => !value); }}>{open ? '收起角色追加' : '追加模块角色…'}</button>
      {opened && <div hidden={!open}><div className="info-controls">
        {blocked && <StateNotice className="info-model-status">当前不可保存：请等待连接及会话加载或关闭完成。</StateNotice>}
        <ResourceStatus status={catalog.status} failed={catalog.failed} pending={catalog.pending} />
        {catalog.failed && <button type="button" className="dialog-btn ck-button rp"
          disabled={!catalog.connected || catalog.pending || action.busy}
          onClick={() => { void catalog.refresh(); }}>重试读取角色目录</button>}
        {catalog.usable && (!catalog.data?.length ? <StateNotice kind="empty">没有可用的模块角色。</StateNotice>
          : !available.length ? <StateNotice kind="empty">目录中的角色均已选择，无法重复追加。</StateNotice>
            : <RolePicker roles={available} selected={additions} disabled={blocked || action.busy || needsInspection}
              onChange={setSelected} />)}
        {additions.length > 64 && <StateNotice kind="error">每次最多追加 64 个角色。</StateNotice>}
        <div className="info-model-actions ck-actions">
          <button type="button" className="dialog-btn ck-button ck-primary primary rp"
            disabled={blocked || action.busy || needsInspection || !catalog.usable || !additions.length || additions.length > 64}
            aria-busy={action.busy && operation === 'save'} onClick={submit}>保存追加角色</button>
        </div>
        {action.busy && operation === 'save' && <StateNotice kind="loading">正在保存…</StateNotice>}
      </div></div>}
    </div>
  </section>;
}

export function SessionRoles({ session }: { session: ChatSession }) {
  return <RolesSection key={session.sessionId} session={session} />;
}
