// URL-driven master-detail management; Shell keeps list/detail navigation responsive.
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { McpServerGlobal } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useUp } from '../lib/nav';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { Shell, MasterPane, DetailPane } from './Shell';
import { Icon } from './Icon';
import { MessageBody } from './MessageBody';
import { ResourceStatus } from './SessionPanelKit';
import { Toggle } from './Manage';

export type ManageSection = 'mcp' | 'skills';

const SECTION_TITLE: Record<ManageSection, string> = { mcp: '全局 MCP', skills: '全局 Skills' };
type ListProps = { selected: string | null; onSelect: (name: string) => void; revision: number };
type McpCatalog = ReturnType<typeof useKeyedResource<McpServerGlobal[]>>;

function NavRow({ name, sub, badge, active, onClick }: {
  name: string; sub?: string; badge?: ReactNode; active: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`manage-row is-clickable rp${active ? ' is-active' : ''}`} onClick={onClick}>
      <div className="manage-row-main">
        <div className="manage-row-name">{name}{badge}</div>
        {sub && <div className="manage-row-sub">{sub}</div>}
      </div>
    </button>
  );
}

function ListBody({ status, failed, empty, children }: {
  status: string | null; failed: boolean; empty: string; children?: ReactNode;
}) {
  const hasRows = children && (!Array.isArray(children) || children.length > 0);
  return <>
    <ResourceStatus status={status} failed={failed} />
    {hasRows ? <div className="manage-list">{children}</div>
      : !status && <div className="manage-empty">{empty}</div>}
  </>;
}

function McpList({ selected, onSelect, catalog }: Omit<ListProps, 'revision'> & { catalog: McpCatalog }) {
  const { data: rows, status, failed } = catalog;
  return (
    <>
      <ListBody status={status} failed={failed} empty="没有配置 MCP 服务器">
        {rows?.map((server) => (
          <NavRow key={server.name} name={server.name} sub={server.detail}
            badge={server.defaultOn ? <span className="manage-tag">新会话默认开启</span> : undefined}
            active={selected === server.name} onClick={() => onSelect(server.name)} />
        ))}
      </ListBody>
    </>
  );
}

function McpDefault({ name, on, onChanged, disabled }: { name: string; on: boolean; onChanged: () => void; disabled: boolean }) {
  const mcpSetDefault = useCockpit((s) => s.mcpSetDefault);
  const connState = useCockpit((s) => s.connState);
  const { run, busy, error } = useKeyedAction(`global:mcp:${name}`);
  return (
    <div className="manage-detail-line">
      <button type="button" className={`switch${on ? ' is-on' : ''}`} role="switch"
        aria-label="新会话默认开启" aria-checked={on} disabled={disabled || connState !== 'open' || busy}
        onClick={() => { void run(async () => {
          try { await mcpSetDefault(name, !on); }
          finally { onChanged(); }
        }); }}>
        <span className="switch-knob" />
      </button>{' '}新会话默认开启
      {!disabled && <p className="manage-note">不改变已加载会话的连接。</p>}
      {error && <div className="manage-note" role="alert">设置失败：{error}</div>}
    </div>
  );
}

function McpDetail({ name, onChanged, catalog }: { name: string; onChanged: () => void; catalog: McpCatalog }) {
  const { data: rows, status, failed, valid } = catalog;
  const row = rows?.find((server) => server.name === name);
  if (!row) return status ? <ResourceStatus status={status} failed={failed} />
    : <div className="detail-empty"><p>未找到该 MCP 服务器。</p></div>;
  return (
    <div className="manage-detail scrollable">
      <ResourceStatus status={status} failed={failed} />
      <h2 className="manage-detail-title">{row.name}</h2>
      <div className="manage-detail-line">{row.detail}</div>
      <McpDefault name={row.name} on={row.defaultOn} disabled={!valid} onChanged={onChanged} />
      {row.config && <pre className="manage-config">{JSON.stringify(row.config, null, 2)}</pre>}
    </div>
  );
}

function SkillsList({ selected, onSelect, revision }: ListProps) {
  const skillsGlobal = useCockpit((s) => s.skillsGlobal);
  const load = useCallback(() => skillsGlobal(), [skillsGlobal]);
  const { data: rows, status, failed } = useKeyedResource('global:skills', load, revision);
  return (
    <ListBody status={status} failed={failed} empty="没有可用的 skill">
      {rows?.map((skill) => (
        <NavRow key={skill.name} name={skill.name} sub={skill.description}
          badge={skill.source ? <span className="manage-tag">{skill.source}</span> : undefined}
          active={selected === skill.name} onClick={() => onSelect(skill.name)} />
      ))}
    </ListBody>
  );
}

function SkillGlobalToggle({ name, enabled, disabled, onChanged }: {
  name: string; enabled: boolean; disabled: boolean; onChanged: () => void;
}) {
  const skillsSetGlobal = useCockpit((s) => s.skillsSetGlobal);
  const action = useKeyedAction(`global:skill-toggle:${name}`);
  return (
    <div className="manage-detail-line">
      <Toggle label="全局默认启用" on={enabled} disabled={disabled || !action.connected || action.busy}
        onChange={(next) => { void action.run(async () => {
          try { await skillsSetGlobal(name, next); }
          finally { onChanged(); }
        }); }} />{' '}全局默认启用
      {!disabled && <p className="manage-note">用于新建或卸载后重新加载的会话，不改变当前已加载会话。</p>}
      {action.error && <div className="manage-note" role="alert">设置失败：{action.error}</div>}
    </div>
  );
}

function SkillDetail({ name, revision, onChanged }: { name: string; revision: number; onChanged: () => void }) {
  const skillsRead = useCockpit((s) => s.skillsRead);
  const load = useCallback(() => skillsRead(name), [skillsRead, name]);
  const { data, status, failed, valid } = useKeyedResource(`global:skill:${name}`, load, revision);
  if (!data) return status ? <ResourceStatus status={status} failed={failed} />
    : <div className="detail-empty"><p>未找到该 skill。</p></div>;
  const meta = [data.source, data.userInvocable ? '可手动调用' : null].filter(Boolean).join(' · ');
  return (
    <div className="manage-detail scrollable">
      <ResourceStatus status={status} failed={failed} />
      <h2 className="manage-detail-title">{data.name}</h2>
      {meta && <div className="manage-detail-meta">{meta}</div>}
      {typeof data.enabled === 'boolean'
        ? <SkillGlobalToggle name={data.name} enabled={data.enabled} disabled={!valid} onChanged={onChanged} />
        : <div className="manage-detail-meta">Copilot 未提供全局启用状态</div>}
      {data.description && <p className="manage-detail-line">{data.description}</p>}
      {data.body ? <div className="manage-detail-body"><MessageBody body={data.body} /></div>
        : <div className="manage-empty">没有 SKILL.md 内容</div>}
    </div>
  );
}

function MasterHeader({ section, item, onRefresh }: {
  section: ManageSection; item: string | null; onRefresh: () => void;
}) {
  const up = useUp();
  const backRef = useRef<HTMLButtonElement | null>(null);
  const connState = useCockpit((s) => s.connState);
  const mcpRefresh = useCockpit((s) => s.mcpRefresh);
  const { run, busy, error } = useKeyedAction(`global:refresh:${section}`);
  useLayoutEffect(() => {
    if (item === null) backRef.current?.focus();
  }, [item]);
  return (
    <>
      <header className="manage-header">
        <button ref={backRef} className="btn-icon rp" type="button"
          aria-label={item === null ? '返回会话列表' : `返回${SECTION_TITLE[section]}列表`}
          onClick={() => up(item === null ? '/' : `/${section}`)}>
          <Icon name="back" size={24} />
        </button>
        <span className="manage-title">{SECTION_TITLE[section]}</span>
        <button className="btn-icon rp manage-action" type="button" aria-label={section === 'mcp' ? '刷新 Copilot MCP 配置缓存' : '刷新'}
          disabled={connState !== 'open' || busy} aria-busy={busy} onClick={() => {
            void run(async () => { if (section === 'mcp') await mcpRefresh(); }, onRefresh);
          }}>
          <Icon name="reload" size={20} />
        </button>
      </header>
      {error && <div className="manage-note" role="alert">刷新失败：{error}</div>}
    </>
  );
}

function DetailHeader({ item }: { item: string }) {
  const up = useUp();
  const titleRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => { titleRef.current?.focus(); }, [item]);
  return (
    <>
      <header className="chat-topbar">
        <button className="chat-back btn-icon rp lg:hidden" type="button" aria-label="返回" onClick={() => up()}>
          <Icon name="back" size={24} />
        </button>
        <span ref={titleRef} tabIndex={-1} className="manage-title manage-detail-headtitle">{item}</span>
      </header>
    </>
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
  const mcpCatalog = useKeyedResource('global:mcp', mcpGlobal, refreshNonce, section === 'mcp');
  const refresh = () => setRefreshNonce((n) => n + 1);
  const select = (name: string) => { void navigate(`/${section}/${encodeURIComponent(name)}`, { replace: item !== null }); };
  const masterHeader = (
    <MasterHeader section={section} item={item} onRefresh={refresh} />
  );
  const detailHeader = item !== null ? (
    <DetailHeader item={item} />
  ) : undefined;
  return (
    <Shell ariaLabel="管理">
      <MasterPane ariaLabel={SECTION_TITLE[section]} mobileVisible={item === null} header={masterHeader}>
        {section === 'mcp' ? <McpList catalog={mcpCatalog} selected={item} onSelect={select} />
          : <SkillsList revision={refreshNonce} selected={item} onSelect={select} />}
      </MasterPane>
      <DetailPane ariaLabel="详情" mobileVisible={item !== null} header={detailHeader}>
        {item === null ? (
          <div className="detail-empty manage-selection-hint"><p>选择左侧的一项查看详情。</p></div>
        ) : section === 'mcp' ? <McpDetail catalog={mcpCatalog} name={item} onChanged={refresh} />
          : <SkillDetail revision={refreshNonce} name={item} onChanged={refresh} />}
      </DetailPane>
    </Shell>
  );
}
