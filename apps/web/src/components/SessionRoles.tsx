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
  return Boolean(session.loading || session.closing || session.cancelling || session.compacting
    || session.activeOperations || session.activeMcpOperations || session.scheduleCount
    || (session.loaded && (session.status !== 'idle' || session.nativeProcessing || session.activeSubagents
      || session.ask || session.planRequest || session.elicitation || session.queue?.length)));
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
  const incomplete = result.status === 'incomplete' || result.status === 'uncertain';
  return <div className="info-model-result">
    <div role={incomplete ? 'alert' : 'status'} className="info-model-status">
      {result.status === 'applied' ? '角色已应用到同一会话。'
        : result.status === 'unchanged' ? '角色选择未变。'
          : '操作未完成或结果不确定；可能已有部分效果。请先检查当前状态，再显式重试；不会自动重试。'}
      {result.error && ` ${result.error}`}
    </div>
    <div>返回阶段：{result.phase} · {result.loaded ? '已加载' : '未加载'}</div>
    <RoleList label="本次返回的已保存选择" roles={result.roles} />
    <RoleList label="本次返回的已应用角色" roles={result.appliedRoles} />
    {result.readiness && <Readiness result={result.readiness} />}
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

function RoleAddition({ session, savedRoles, onSavedRoles }: {
  session: ChatSession; savedRoles: SessionRole[];
  onSavedRoles: (roles: SessionRole[]) => void;
}) {
  const sid = session.sessionId;
  const listRoles = useCockpit(state => state.listRoles);
  const catalog = useKeyedResource(`role-catalog:${sid}`, listRoles);
  const action = useKeyedAction(`role-add:${sid}`);
  const [selected, setSelected] = useState<RoleSelection[]>([]);
  const [result, setResult] = useState<IntentResult<'roles/add'> | null>(null);
  const [inspection, setInspection] = useState<IntentResult<'roles/readiness'> | null>(null);
  const [submission, setSubmission] = useState<RoleSelection[] | null>(null);
  const [retryNeeded, setRetryNeeded] = useState(false);
  const [needsInspection, setNeedsInspection] = useState(false);
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
      onSavedRoles(next.roles);
      setNeedsInspection(false);
    });
  };
  const submit = (roles: RoleSelection[]) => {
    const current = useCockpit.getState().sessions.find(row => row.sessionId === sid);
    if (blocked || roleAdditionBlocked(current) || action.busy || needsInspection
      || !roles.length || roles.length > 64) return;
    setSubmission(roles);
    setRetryNeeded(true);
    setNeedsInspection(true);
    setResult(null);
    setInspection(null);
    let next: IntentResult<'roles/add'>;
    void action.run(async () => {
      next = await useCockpit.getState().addRoles(sid, roles);
      if (next.sessionId !== sid) throw new Error('返回的会话 ID 不匹配，请检查原会话');
    }, () => {
      setResult(next);
      onSavedRoles(next.roles);
      if (next.status === 'applied' || next.status === 'unchanged') {
        setSelected([]);
        setNeedsInspection(false);
        setRetryNeeded(false);
      }
    });
  };
  return <div className="info-controls">
    <div>只追加，不移除已有角色。点击提交会显式重新加载已加载的空闲会话；未加载时直接恢复同一会话。
      保留 Session ID、历史和工作目录，不新建会话，也不发送隐藏提示。</div>
    <div>本次操作保留已加载会话的临时 MCP / Skill 开关；以后普通冷恢复仍使用原生全局默认值。执行中、待决交互、
      活跃定时任务或控制操作未结束时拒绝追加，
      不排队等待；会话对自身的忙碌调用也会拒绝，请在本轮结束后操作。</div>
    <div>服务端还会拒绝没有根用户消息的已加载空会话，以及无法确认会话专用资源配置或 MCP 已停止 / 未配置的情况。
      角色应用不代表能力就绪；原有资源关闭时仍可能未就绪。</div>
    {blocked && <div className="info-model-status" role="status">当前不可提交：请等待连接、会话空闲且控制操作结束，并先停止活跃定时任务。最终以服务端检查为准。</div>}
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
        aria-busy={action.busy} onClick={() => { if (catalog.usable) submit(additions); }}>追加角色并{session.loaded ? '重新加载' : '恢复'}此会话</button>
      <button type="button" className="dialog-btn ck-button rp"
        disabled={!action.connected || action.busy} onClick={inspect}>检查当前角色状态</button>
      {retryNeeded && submission && !action.busy && <button type="button" className="dialog-btn ck-button rp"
        disabled={blocked || needsInspection}
        onClick={() => submit(submission)}>显式重试上次角色追加</button>}
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
  const [savedRoles, setSavedRoles] = useState<SessionRole[] | null>(null);
  return <section className="info-section">
    <div className="info-section-name">模块角色</div>
    <div className="info-section-content info-controls">
      <RoleList label="已保存的角色选择（不代表当前应用或就绪）" roles={savedRoles ?? session.roles} />
      <button type="button" className="dialog-btn ck-button rp" aria-expanded={open}
        onClick={() => { setOpened(true); setOpen(value => !value); }}>{open ? '收起角色追加' : '追加模块角色…'}</button>
      {opened && <div hidden={!open}>
        <RoleAddition session={session} savedRoles={savedRoles ?? session.roles ?? []} onSavedRoles={setSavedRoles} />
      </div>}
    </div>
  </section>;
}

export function SessionRoles({ session }: { session: ChatSession }) {
  const generation = useCockpit(state => state.connectionGeneration);
  const connected = useCockpit(state => state.connState);
  return <RolesSection key={`${session.sessionId}:${generation}:${connected}`} session={session} />;
}
