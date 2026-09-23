// URL-driven master-detail management; Shell keeps list/detail navigation responsive.
import { useCallback, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import type { McpServerGlobal, ModuleSource, SkillGlobal } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { isSkillNotFoundError } from '../net/client';
import { skillBodyContent } from '../lib/skillBody';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { ManagementShell, type ManageSection } from './ManagementShell';
import { StateNotice } from './StateNotice';
import { MessageBody } from './MessageBody';
import { ResourceStatus } from './SessionPanelKit';
import { PaneBody } from './PaneHeader';
import { ResourceSummary } from './ResourceRow';
import { ModuleSourceBadge } from './ModuleLabel';
import { SectionHeading, Toggle } from './UI';
import { useGlobalResourceMutations } from '../features/session-settings/useGlobalResources';
import { mcpConnectionLabel, skillSourceLabel } from '../lib/resourcePresentation';

type Catalog<T> = ReturnType<typeof useKeyedResource<T[]>>;
type GlobalToggle = (name: string, enabled: boolean) => Promise<void>;

function Provenance({ modules }: { modules?: ModuleSource[] }) {
  return modules?.map(module => <ModuleSourceBadge key={module.id} module={module} />);
}

function NavRow({ section, name, sub, modules, selected, enabled, disabled, onChange }: {
  section: ManageSection; name: string; sub?: string; modules?: ModuleSource[]; selected: string | null;
  enabled?: boolean; disabled: boolean; onChange: GlobalToggle;
}) {
  const action = useKeyedAction(`global:${section}:${name}`);
  const help = section === 'mcp' ? '不改变已加载会话的连接。'
    : '用于新建或卸载后重新加载的会话，不改变当前已加载会话。';
  return <div className={`resource-row manage-row manage-global-row${selected === name ? ' is-active' : ''}`}
    data-resource-name={name}>
    <Link className="manage-resource-link ck-button rp" to={`/${section}/${encodeURIComponent(name)}`}
      replace={selected !== null} aria-current={selected === name ? 'page' : undefined}>
      <ResourceSummary name={name} source={sub} badge={<Provenance modules={modules} />} />
    </Link>
    {typeof enabled === 'boolean'
      ? <span className="manage-global-control" title={help}>
        <Toggle label={`全局默认启用 ${name}`} on={enabled} busy={action.busy}
          disabled={disabled || !action.connected || action.busy}
          onChange={next => { void action.run(() => onChange(name, next)); }} />
      </span>
      : <span className="manage-global-unknown">Copilot 未提供全局启用状态</span>}
    {action.busy && <StateNotice kind="loading" className="manage-row-feedback">正在提交…</StateNotice>}
    {action.error && <StateNotice kind="error" className="manage-row-feedback">设置失败：{action.error}</StateNotice>}
  </div>;
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

function McpList({ selected, catalog, onChange }: {
  selected: string | null; catalog: Catalog<McpServerGlobal>; onChange: GlobalToggle;
}) {
  const { data: rows, status, failed, pending, valid } = catalog;
  return <ListBody status={status} failed={failed} pending={pending} empty="没有配置 MCP 服务器">
    {rows?.map(server => <NavRow key={server.name} section="mcp" name={server.name} sub={mcpConnectionLabel(server.connection)}
      modules={server.modules} selected={selected} enabled={server.defaultOn} disabled={!valid} onChange={onChange} />)}
  </ListBody>;
}

function McpDetail({ name, catalog }: { name: string; catalog: Catalog<McpServerGlobal> }) {
  const { data: rows, status, failed, pending } = catalog;
  const row = rows?.find(server => server.name === name);
  if (!row) return status ? <ResourceStatus status={status} failed={failed} pending={pending} placement="pane" />
    : <StateNotice kind="empty" placement="pane">未找到该 MCP 服务器。</StateNotice>;
  return <PaneBody className="manage-detail">
    <div className="manage-detail-column">
      <ResourceStatus status={status} failed={failed} pending={pending} />
      <div className="manage-detail-meta">{mcpConnectionLabel(row.connection)}</div>
      <section className="manage-config-section">
        <SectionHeading level={2}>连接配置</SectionHeading>
        {row.config ? <pre className="manage-config">{JSON.stringify(row.config, null, 2)}</pre>
          : <StateNotice kind="info">未提供连接配置</StateNotice>}
      </section>
    </div>
  </PaneBody>;
}

function SkillsList({ selected, catalog, onChange }: {
  selected: string | null; catalog: Catalog<SkillGlobal>; onChange: GlobalToggle;
}) {
  const { data: rows, status, failed, pending, valid } = catalog;
  return <ListBody status={status} failed={failed} pending={pending} empty="没有可用的 skill">
    {rows?.map(skill => <NavRow key={skill.name} section="skills" name={skill.name}
      sub={skill.description || skillSourceLabel(skill.source)} modules={skill.modules} selected={selected}
      enabled={skill.enabled} disabled={!valid} onChange={onChange} />)}
  </ListBody>;
}

type SkillRead = Awaited<ReturnType<ReturnType<typeof useCockpit.getState>['skillsRead']>>;
type SkillResource = Pick<ReturnType<typeof useKeyedResource<SkillRead>>, 'data' | 'status' | 'failed' | 'pending' | 'errorCause'>;

export function SkillDetailContent({ resource }: { resource: SkillResource }) {
  const { data, status, failed, pending, errorCause } = resource;
  const notFound = <StateNotice kind="empty" placement="pane">未找到该 Skill。</StateNotice>;
  // A structured not-found supersedes any retained earlier read.
  if (failed && isSkillNotFoundError(errorCause)) return notFound;
  if (!data) return status ? <ResourceStatus status={status} failed={failed} pending={pending} placement="pane" /> : notFound;
  const meta = [skillSourceLabel(data.source), data.userInvocable ? '可手动调用' : null].filter(Boolean).join(' · ');
  const body = data.body === undefined ? '' : skillBodyContent(data.body);
  return <PaneBody className="manage-detail">
    <div className="manage-detail-column">
      <ResourceStatus status={status} failed={failed} pending={pending} />
      {meta && <div className="manage-detail-meta">{meta}</div>}
      {data.description && <p className="manage-detail-line">{data.description}</p>}
      {body.trim() ? <div className="manage-detail-body"><MessageBody body={body} /></div>
        : <StateNotice kind="empty">{data.body?.trim() ? 'SKILL.md 没有正文' : '没有 SKILL.md 内容'}</StateNotice>}
    </div>
  </PaneBody>;
}

function SkillDetail({ name, revision }: { name: string; revision: number }) {
  const skillsRead = useCockpit(s => s.skillsRead);
  const load = useCallback(() => skillsRead(name), [skillsRead, name]);
  return <SkillDetailContent resource={useKeyedResource(`global:skill:${name}`, load, revision)} />;
}

// Routes: /mcp, /skills and each section's optional /:item detail.
export function ManageWorkspace({ section: selectedSection }: { section?: ManageSection }) {
  const { pathname } = useLocation();
  const { item = null } = useParams();
  const segment = pathname.split('/')[1];
  const section: ManageSection = selectedSection ?? (segment === 'skills' ? segment : 'mcp');
  return <ManagementContent key={section} section={section} item={item} />;
}

function ManagementContent({ section, item }: { section: ManageSection; item: string | null }) {
  const { refreshNonce, refresh, onChange } = useGlobalResourceMutations(section);
  const mcpGlobal = useCockpit(s => s.mcpGlobal);
  const skillsGlobal = useCockpit(s => s.skillsGlobal);
  const loadSkills = useCallback(() => skillsGlobal(), [skillsGlobal]);
  const mcpCatalog = useKeyedResource('global:mcp', mcpGlobal, refreshNonce, section === 'mcp');
  const skillCatalog = useKeyedResource('global:skills', loadSkills, refreshNonce, section === 'skills');
  const catalog = section === 'mcp' ? mcpCatalog : skillCatalog;
  const modules = catalog.data?.find(row => row.name === item)?.modules;
  return <ManagementShell section={section} item={item} onRefresh={refresh}
    titlePrefix={catalog.usable && <Provenance modules={modules} />}
    master={section === 'mcp' ? <McpList catalog={mcpCatalog} selected={item} onChange={onChange} />
      : <SkillsList catalog={skillCatalog} selected={item} onChange={onChange} />}
    detail={item === null ? <StateNotice kind="empty" placement="pane" className="manage-selection-hint">选择左侧的一项查看详情。</StateNotice>
      : section === 'mcp' ? <McpDetail catalog={mcpCatalog} name={item} />
        : <SkillDetail revision={refreshNonce} name={item} />} />;
}
