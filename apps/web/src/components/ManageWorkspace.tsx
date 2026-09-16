// URL-driven master-detail management; Shell keeps list/detail navigation responsive.
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { McpServerGlobal } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { ManagementShell, type ManageSection } from './ManagementShell';
import { StateNotice } from './StateNotice';
import { MessageBody } from './MessageBody';
import { ResourceStatus } from './SessionPanelKit';
import { Toggle } from './Manage';

type ListProps = { selected: string | null; onSelect: (name: string) => void; revision: number };
type McpCatalog = ReturnType<typeof useKeyedResource<McpServerGlobal[]>>;
type GlobalToggle = (name: string, enabled: boolean) => Promise<void>;

function NavRow({ name, sub, badge, active, onClick }: {
  name: string; sub?: string; badge?: ReactNode; active: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`manage-row ck-button is-clickable rp${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined} onClick={onClick}>
      <span className="manage-row-main">
        <span className="manage-row-name">{name}{badge}</span>
        {sub && <span className="manage-row-sub ck-text-secondary">{sub}</span>}
      </span>
    </button>
  );
}

function ListBody({ status, failed, pending, empty, children }: {
  status: string | null; failed: boolean; pending: boolean; empty: string; children?: ReactNode;
}) {
  const hasRows = children && (!Array.isArray(children) || children.length > 0);
  return <>
    <ResourceStatus status={status} failed={failed} pending={pending} placement={hasRows ? 'inline' : 'pane'} />
    {hasRows ? <div className="manage-list">{children}</div>
      : !status && <StateNotice kind="empty" placement="pane">{empty}</StateNotice>}
  </>;
}

function McpList({ selected, onSelect, catalog }: Omit<ListProps, 'revision'> & { catalog: McpCatalog }) {
  const { data: rows, status, failed, pending } = catalog;
  return (
    <>
      <ListBody status={status} failed={failed} pending={pending} empty="没有配置 MCP 服务器">
        {rows?.map((server) => (
          <NavRow key={server.name} name={server.name} sub={server.detail}
            badge={server.defaultOn ? <span className="manage-tag">新会话默认开启</span> : undefined}
            active={selected === server.name} onClick={() => onSelect(server.name)} />
        ))}
      </ListBody>
    </>
  );
}

function McpDefault({ name, on, onChange, disabled }: { name: string; on: boolean; onChange: GlobalToggle; disabled: boolean }) {
  const connState = useCockpit((s) => s.connState);
  const { run, busy, error } = useKeyedAction(`global:mcp:${name}`);
  return (
    <div className="manage-detail-line">
      <button type="button" className={`switch ck-button${on ? ' is-on' : ''}`} role="switch"
        aria-label="新会话默认开启" aria-checked={on} aria-busy={busy} disabled={disabled || connState !== 'open' || busy}
        onClick={() => { void run(() => onChange(name, !on)); }}>
        <span className="switch-knob" />
      </button>{' '}新会话默认开启
      {busy && <StateNotice kind="loading">正在提交…</StateNotice>}
      {!disabled && <p className="manage-note">不改变已加载会话的连接。</p>}
      {error && <div className="manage-note" role="alert">设置失败：{error}</div>}
    </div>
  );
}

function McpDetail({ name, onChange, catalog }: { name: string; onChange: GlobalToggle; catalog: McpCatalog }) {
  const { data: rows, status, failed, valid, pending } = catalog;
  const row = rows?.find((server) => server.name === name);
  if (!row) return status ? <ResourceStatus status={status} failed={failed} pending={pending} placement="pane" />
    : <div className="detail-empty"><p>未找到该 MCP 服务器。</p></div>;
  return (
    <div className="manage-detail scrollable">
      <ResourceStatus status={status} failed={failed} pending={pending} />
      <h2 className="manage-detail-title">{row.name}</h2>
      <div className="manage-detail-line">{row.detail}</div>
      <McpDefault name={row.name} on={row.defaultOn} disabled={!valid} onChange={onChange} />
      {row.config && <pre className="manage-config">{JSON.stringify(row.config, null, 2)}</pre>}
    </div>
  );
}

function SkillsList({ selected, onSelect, revision }: ListProps) {
  const skillsGlobal = useCockpit((s) => s.skillsGlobal);
  const load = useCallback(() => skillsGlobal(), [skillsGlobal]);
  const { data: rows, status, failed, pending } = useKeyedResource('global:skills', load, revision);
  return (
    <ListBody status={status} failed={failed} pending={pending} empty="没有可用的 skill">
      {rows?.map((skill) => (
        <NavRow key={skill.name} name={skill.name} sub={skill.description}
          badge={skill.source ? <span className="manage-tag">{skill.source}</span> : undefined}
          active={selected === skill.name} onClick={() => onSelect(skill.name)} />
      ))}
    </ListBody>
  );
}

function SkillGlobalToggle({ name, enabled, disabled, onChange }: {
  name: string; enabled: boolean; disabled: boolean; onChange: GlobalToggle;
}) {
  const action = useKeyedAction(`global:skill-toggle:${name}`);
  return (
    <div className="manage-detail-line">
      <Toggle label="全局默认启用" on={enabled} disabled={disabled || !action.connected || action.busy}
        onChange={(next) => { void action.run(() => onChange(name, next)); }} />{' '}全局默认启用
      {!disabled && <p className="manage-note">用于新建或卸载后重新加载的会话，不改变当前已加载会话。</p>}
      {action.busy && <StateNotice kind="loading">正在提交…</StateNotice>}
      {action.error && <div className="manage-note" role="alert">设置失败：{action.error}</div>}
    </div>
  );
}

function SkillDetail({ name, revision, onChange }: { name: string; revision: number; onChange: GlobalToggle }) {
  const skillsRead = useCockpit((s) => s.skillsRead);
  const load = useCallback(() => skillsRead(name), [skillsRead, name]);
  const { data, status, failed, valid, pending } = useKeyedResource(`global:skill:${name}`, load, revision);
  if (!data) return status ? <ResourceStatus status={status} failed={failed} pending={pending} placement="pane" />
    : <div className="detail-empty"><p>未找到该 skill。</p></div>;
  const meta = [data.source, data.userInvocable ? '可手动调用' : null].filter(Boolean).join(' · ');
  return (
    <div className="manage-detail scrollable">
      <ResourceStatus status={status} failed={failed} pending={pending} />
      <h2 className="manage-detail-title">{data.name}</h2>
      {meta && <div className="manage-detail-meta">{meta}</div>}
      {typeof data.enabled === 'boolean'
        ? <SkillGlobalToggle name={data.name} enabled={data.enabled} disabled={!valid} onChange={onChange} />
        : <div className="manage-detail-meta">Copilot 未提供全局启用状态</div>}
      {data.description && <p className="manage-detail-line">{data.description}</p>}
      {data.body ? <div className="manage-detail-body"><MessageBody body={data.body} /></div>
        : <div className="manage-empty">没有 SKILL.md 内容</div>}
    </div>
  );
}

// Routes: /mcp, /skills and each section's optional /:item detail.
export function ManageWorkspace({ section: selectedSection }: { section?: ManageSection }) {
  const { pathname } = useLocation();
  const { item = null } = useParams();
  const segment = pathname.split('/')[1];
  const section: ManageSection = selectedSection ?? (segment === 'skills' ? segment : 'mcp');
  return <ManagementContent key={section} section={section} item={item} />;
}

function ManagementContent({ section, item }: {
  section: ManageSection; item: string | null;
}) {
  const navigate = useNavigate();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const mcpGlobal = useCockpit((s) => s.mcpGlobal);
  const mutate = useCockpit((s) => section === 'mcp' ? s.mcpSetDefault : s.skillsSetGlobal);
  const connected = useCockpit((s) => s.connState === 'open');
  const generation = useCockpit((s) => s.connectionGeneration);
  const owner = useRef({ active: false });
  useLayoutEffect(() => {
    const current = { active: true };
    owner.current = current;
    return () => { current.active = false; };
  }, [connected, generation]);
  const mcpCatalog = useKeyedResource('global:mcp', mcpGlobal, refreshNonce, section === 'mcp');
  const refresh = () => setRefreshNonce((n) => n + 1);
  // Detail tasks own their feedback; the mounted catalog owns mutation readback.
  const onChange: GlobalToggle = async (name, enabled) => {
    const current = owner.current;
    try { await mutate(name, enabled); }
    finally {
      const state = useCockpit.getState();
      if (current.active && state.connState === 'open' && state.connectionGeneration === generation) refresh();
    }
  };
  const select = (name: string) => { void navigate(`/${section}/${encodeURIComponent(name)}`, { replace: item !== null }); };
  return (
    <ManagementShell section={section} item={item} onRefresh={refresh}
      master={section === 'mcp' ? <McpList catalog={mcpCatalog} selected={item} onSelect={select} />
        : <SkillsList revision={refreshNonce} selected={item} onSelect={select} />}
      detail={item === null ? (
          <div className="detail-empty manage-selection-hint"><p>选择左侧的一项查看详情。</p></div>
        ) : section === 'mcp' ? <McpDetail catalog={mcpCatalog} name={item} onChange={onChange} />
          : <SkillDetail revision={refreshNonce} name={item} onChange={onChange} />} />
  );
}
