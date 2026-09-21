import { useState } from 'react';
import type { IntentResult, RoleSelection, SessionRole } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import type { ChatSession } from '../net/types';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { RoleBadge } from './ModuleLabel';
import { RolePicker } from './RolePicker';
import { ResourceStatus } from './SessionPanelKit';

const sameRole = (a: RoleSelection, b: RoleSelection) => a.moduleId === b.moduleId && a.roleId === b.roleId;

function roleAdditionBlocked(session?: ChatSession) {
  if (!session) return true;
  return Boolean(session.loading || session.closing);
}

function RoleList({ label, roles }: { label: string; roles?: SessionRole[] }) {
  return <div className="info-controls">
    <span>{label}</span>
    {roles ? roles.length ? <div className="session-role-badges" aria-label={label}>
      {roles.map(role => <RoleBadge key={`${role.moduleId}/${role.roleId}`} role={role} />)}
    </div> : <span className="info-meta-id-label">无</span>
      : <span className="info-meta-id-label">未读取</span>}
  </div>;
}

export function RoleAdditionOutcome({ result }: { result: IntentResult<'roles/add'> }) {
  return <div className="info-model-result">
    <div role={result.status === 'uncertain' ? 'alert' : 'status'} className="info-model-status">
      {result.status === 'saved' ? '角色选择已保存，未重新加载会话。'
        : result.status === 'unchanged' ? '角色选择未变。'
          : '操作未完成或结果不确定；可能已有部分效果。请先检查当前状态，再显式重试；不会自动重试。'}
      {result.error && ` ${result.error}`}
    </div>
    <div>本次返回：{result.loaded ? result.rolesNeedReload ? '需要重新加载' : '无需重新加载' : '下次加载时应用已保存的角色'}</div>
    <RoleList label="本次返回的已保存选择" roles={result.roles} />
    <RoleList label="本次返回的已应用角色" roles={result.appliedRoles} />
    {result.recovery && <div>{result.recovery}</div>}
    <details className="info-model-details">
      <summary>角色追加完整结果</summary>
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </details>
  </div>;
}

function Readiness({ result }: { result: IntentResult<'roles/readiness'> }) {
  return <div className="info-controls">
    <div>本次检查：{result.loaded ? '已加载' : '未加载'}；能力{result.ready ? '就绪' : '未就绪'}（仅此时刻，不持续监测）</div>
    {result.reasons.length > 0 && <ul>{result.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
  </div>;
}

function RoleAddition({ session }: { session: ChatSession }) {
  const sid = session.sessionId;
  const listRoles = useCockpit(state => state.listRoles);
  const catalog = useKeyedResource(`role-catalog:${sid}`, listRoles);
  const action = useKeyedAction(`role-add:${sid}`);
  const [selected, setSelected] = useState<RoleSelection[]>([]);
  const [result, setResult] = useState<IntentResult<'roles/add'> | null>(null);
  const [inspection, setInspection] = useState<IntentResult<'roles/readiness'> | null>(null);
  const [submission, setSubmission] = useState<RoleSelection[] | null>(null);
  const [needsInspection, setNeedsInspection] = useState(false);
  const savedRoles = session.roles ?? [];
  const available = catalog.usable ? catalog.data?.filter(role => !savedRoles.some(saved => sameRole(role, saved))) ?? [] : [];
  const additions = selected.filter(role => available.some(option => sameRole(role, option)));
  const blocked = roleAdditionBlocked(session) || !action.connected;
  const inspect = () => {
    if (action.busy || !action.connected) return;
    let next: IntentResult<'roles/readiness'>;
    void action.run(async () => {
      next = await useCockpit.getState().roleReadiness(sid);
      if (next.sessionId !== sid) throw new Error('返回的会话 ID 不匹配，请检查原会话');
    }, () => {
      setInspection(next);
      setNeedsInspection(false);
    });
  };
  const submit = (roles: RoleSelection[]) => {
    const current = useCockpit.getState().sessions.find(row => row.sessionId === sid);
    if (blocked || roleAdditionBlocked(current) || action.busy || needsInspection
      || !roles.length || roles.length > 64) return;
    setSubmission(roles);
    setNeedsInspection(true);
    setResult(null);
    setInspection(null);
    let next: IntentResult<'roles/add'>;
    void action.run(async () => {
      next = await useCockpit.getState().addRoles(sid, roles);
      if (next.sessionId !== sid) throw new Error('返回的会话 ID 不匹配，请检查原会话');
    }, () => {
      setResult(next);
      if (next.status === 'saved' || next.status === 'unchanged') {
        setSelected([]);
        setNeedsInspection(false);
      }
    });
  };
  return <div className="info-controls">
    <div>只保存追加选择，不移除已有角色，不重新加载或恢复会话，也不发送隐藏提示。
      执行中、有待决问题、排队消息或活跃定时任务时仍可保存。</div>
    <div>已加载会话需要另行显式重新加载才能应用新增角色；未加载会话在下次加载时应用。
      普通重新加载使用原生全局默认值，不保留临时 MCP / Skill 开关。角色应用不代表能力就绪。</div>
    {blocked && <div className="info-model-status" role="status">当前不可保存：请等待连接及会话加载或关闭完成。最终以服务端检查为准。</div>}
    <ResourceStatus status={catalog.status} failed={catalog.failed} pending={catalog.pending} />
    {catalog.failed && <button type="button" className="dialog-btn ck-button rp"
      disabled={!catalog.connected || catalog.pending || action.busy} onClick={() => { void catalog.refresh(); }}>重试读取角色目录</button>}
    {catalog.usable && (!catalog.data?.length ? <div>没有可用的模块角色。</div>
      : !available.length ? <div>目录中的角色均已选择，无法重复追加。</div>
        : <RolePicker roles={available} selected={additions} disabled={blocked || action.busy || needsInspection}
          onChange={setSelected} />)}
    {additions.length > 64 && <div role="alert">每次最多追加 64 个角色。</div>}
    <div className="info-model-actions">
      <button type="button" className="dialog-btn ck-button ck-primary primary rp"
        disabled={blocked || action.busy || needsInspection || !catalog.usable || !additions.length || additions.length > 64}
        aria-busy={action.busy} onClick={() => { if (catalog.usable) submit(additions); }}>保存追加角色</button>
      <button type="button" className="dialog-btn ck-button rp"
        disabled={!action.connected || action.busy} onClick={inspect}>检查当前角色状态</button>
    </div>
    {action.busy && <div role="status">正在请求…</div>}
    {action.error && <div className="info-model-status" role="alert">
      请求结果未确认：{action.error}。请检查当前状态后再显式重试，不会自动重试。
    </div>}
    {submission && !action.busy && !result && !action.error && <div role="status">尚未确认追加结果，请检查当前状态。</div>}
    {result && <RoleAdditionOutcome result={result} />}
    {inspection && <div className="info-model-result">
      <RoleList label="检查时已保存选择" roles={inspection.roles} />
      <RoleList label="检查时已应用角色" roles={inspection.appliedRoles} />
      <Readiness result={inspection} />
      <details className="info-model-details"><summary>角色检查完整结果</summary><pre>{JSON.stringify(inspection, null, 2)}</pre></details>
    </div>}
  </div>;
}

function RolesSection({ session }: { session: ChatSession }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return <section className="info-section">
    <div className="info-section-name">模块角色</div>
    <div className="info-section-content info-controls">
      <RoleList label="已保存的角色选择（不代表当前应用或就绪）" roles={session.roles} />
      <RoleList label="当前已应用角色（不代表能力就绪）" roles={session.appliedRoles} />
      <div role="status">{!session.loaded ? '会话未加载；已保存的角色将在下次加载时应用。'
        : session.rolesNeedReload ? '角色选择已保存，需要另行显式重新加载会话。' : null}</div>
      <button type="button" className="dialog-btn ck-button rp" aria-expanded={open}
        onClick={() => { setOpened(true); setOpen(value => !value); }}>{open ? '收起角色追加' : '追加模块角色…'}</button>
      {opened && <div hidden={!open}>
        <RoleAddition session={session} />
      </div>}
    </div>
  </section>;
}

export function SessionRoles({ session }: { session: ChatSession }) {
  const generation = useCockpit(state => state.connectionGeneration);
  const connected = useCockpit(state => state.connState);
  return <RolesSection key={`${session.sessionId}:${generation}:${connected}`} session={session} />;
}
