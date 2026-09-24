// URL-driven master-detail management; Shell keeps list/detail navigation responsive.
import { useCallback, useId, useState, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import type { McpServerGlobal, ModuleRoleResources, ModuleSource, SkillGlobal } from '@cockpit/protocol';
import { cockpitApi, loadGlobalMcp, loadGlobalSkills, loadRoleResources, type CockpitApi } from '../net/api';
import { isSkillNotFoundError } from '../net/client';
import { skillBodyContent } from '../lib/skillBody';
import { useKeyedAction, useKeyedResource } from '../lib/useKeyedResource';
import { ManagementShell, type ManageSection } from './ManagementShell';
import { ResourceStatus, StateNotice } from './StateNotice';
import { MessageBody } from './MessageBody';
import { PaneBody } from './PaneHeader';
import { ResourceError, ResourceList, ResourceProgress, ResourceRow, ResourceText, RoleEnabled } from './ResourceRow';
import { ModuleSourceBadge } from './ModuleLabel';
import { SectionHeading, Toggle } from './UI';
import { useGlobalResourceMutations } from '../features/session-settings/useGlobalResources';
import { mcpConnectionLabel, moduleProvidedRows, skillSourceLabel, skillSummary } from '../lib/resourcePresentation';

type Catalog<T> = ReturnType<typeof useKeyedResource<T[]>>;
type GlobalToggle = (name: string, enabled: boolean) => Promise<void>;

function Provenance({ modules }: { modules?: ModuleSource[] }) {
  return modules?.map(module => <ModuleSourceBadge key={module.id} module={module} />);
}

function NavRow({ section, name, summary, modules, selected, enabled, disabled, onChange }: {
  section: ManageSection; name: string; summary?: string; modules?: ModuleSource[]; selected: string | null;
  enabled?: boolean; disabled: boolean; onChange: GlobalToggle;
}) {
  const action = useKeyedAction(`global:${section}:${name}`);
  const [desired, setDesired] = useState(enabled);
  const help = section === 'mcp' ? '不改变已加载会话的连接。'
    : '用于新建或卸载后重新加载的会话，不改变当前已加载会话。';
  return <ResourceRow name={name} badge={<Provenance modules={modules} />}
    link={{ to: `/${section}/${encodeURIComponent(name)}`, replace: selected !== null, selected: selected === name }}
    summary={summary && <ResourceText key={summary} text={summary} label={`${name}摘要`} disclosure={false} />}
    status={action.busy ? <ResourceProgress>{desired ? '启用中' : '停用中'}</ResourceProgress>
      : typeof enabled !== 'boolean'
        && <span className="manage-global-unknown" title="Copilot 未提供全局启用状态">未提供全局启用状态</span>}
    control={typeof enabled === 'boolean' && <span className="manage-global-control" title={help}>
      <Toggle label={`全局默认启用 ${name}`} on={enabled} busy={action.busy}
        disabled={disabled || !action.connected || action.busy}
        onChange={next => { setDesired(next); void action.run(() => onChange(name, next)); }} />
    </span>}
    feedback={action.error && !action.busy
      && <ResourceError key={JSON.stringify([section, name, action.error])} error={action.error} name={name}
        cause={action.errorCause} action={`${desired ? '启用' : '停用'}全局默认 ${name}`} />} />;
}

function ListBody({ status, failed, pending, empty, modules, children }: {
  status: string | null; failed: boolean; pending: boolean; empty: string; modules?: ReactNode; children?: ReactNode;
}) {
  const heading = useId();
  const hasRows = children && (!Array.isArray(children) || children.length > 0);
  const list = hasRows ? <ResourceList hint="开关：新会话默认启用">{children}</ResourceList>
    : !status && <StateNotice kind="empty" placement={modules ? 'inline' : 'pane'}>{empty}</StateNotice>;
  const statusNotice = <ResourceStatus status={status} failed={failed} pending={pending}
    placement={hasRows || modules ? 'inline' : 'pane'} />;
  if (!modules) return <>{statusNotice}{list}</>;
  return <>
    <section className="manage-group" aria-labelledby={heading}>
      <SectionHeading className="manage-group-heading"><span id={heading}>全局配置</span></SectionHeading>
      {statusNotice}{list}
    </section>
    {modules}
  </>;
}

// Module role resources are assembled only into sessions selecting a role; they
// have no global switch and are separate from native global configuration.
function ModuleProvidedGroup({ section, catalog, native }: {
  section: ManageSection; catalog: Catalog<ModuleRoleResources>;
  native?: ReadonlyArray<{ name: string; modules?: ModuleSource[] }>;
}) {
  const heading = useId();
  const { data, status, failed, pending } = catalog;
  const rows = moduleProvidedRows(data ?? [], section, native);
  if (!rows.length && !failed) return null;
  return <section className="manage-group manage-module-group" aria-labelledby={heading}>
    <SectionHeading className="manage-group-heading"><span id={heading}>模块提供</span></SectionHeading>
    <ResourceStatus status={catalog.connected ? status : null} failed={failed} pending={pending} />
    {rows.length > 0 && <ResourceList hint="只装配进选了对应角色的会话，不能全局关闭">
      {rows.map(row => <ResourceRow key={row.key} name={row.name} badge={<ModuleSourceBadge module={row.module} />}
        summary={row.summary && <ResourceText key={row.summary} text={row.summary} label={`${row.name}摘要`} />}
        control={<RoleEnabled />} />)}
    </ResourceList>}
  </section>;
}

function McpList({ selected, catalog, modules, onChange }: {
  selected: string | null; catalog: Catalog<McpServerGlobal>; modules: Catalog<ModuleRoleResources>; onChange: GlobalToggle;
}) {
  const { data: rows, status, failed, pending, valid } = catalog;
  const group = <ModuleProvidedGroup section="mcp" catalog={modules} native={rows} />;
  return <ListBody status={status} failed={failed} pending={pending} empty="没有配置 MCP 服务器"
    modules={moduleGroupVisible(modules, 'mcp', rows) ? group : undefined}>
    {rows?.map(server => <NavRow key={server.name} section="mcp" name={server.name} summary={mcpConnectionLabel(server.connection)}
      modules={server.modules} selected={selected} enabled={server.defaultOn} disabled={!valid} onChange={onChange} />)}
  </ListBody>;
}

function moduleGroupVisible(catalog: Catalog<ModuleRoleResources>, section: ManageSection,
  native?: ReadonlyArray<{ name: string; modules?: ModuleSource[] }>) {
  return catalog.failed || moduleProvidedRows(catalog.data ?? [], section, native).length > 0;
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

function SkillsList({ selected, catalog, modules, onChange }: {
  selected: string | null; catalog: Catalog<SkillGlobal>; modules: Catalog<ModuleRoleResources>; onChange: GlobalToggle;
}) {
  const { data: rows, status, failed, pending, valid } = catalog;
  const group = <ModuleProvidedGroup section="skills" catalog={modules} native={rows} />;
  return <ListBody status={status} failed={failed} pending={pending} empty="没有可用的 skill"
    modules={moduleGroupVisible(modules, 'skills', rows) ? group : undefined}>
    {rows?.map(skill => <NavRow key={skill.name} section="skills" name={skill.name}
      summary={skillSummary(skill.source, skill.description)} modules={skill.modules} selected={selected}
      enabled={skill.enabled} disabled={!valid} onChange={onChange} />)}
  </ListBody>;
}

type SkillRead = Awaited<ReturnType<CockpitApi['skillsRead']>>;
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
  const load = useCallback(() => cockpitApi.skillsRead(name), [name]);
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
  const mcpCatalog = useKeyedResource('global:mcp', loadGlobalMcp, refreshNonce, section === 'mcp');
  const skillCatalog = useKeyedResource('global:skills', loadGlobalSkills, refreshNonce, section === 'skills');
  const moduleCatalog = useKeyedResource('global:role-resources', loadRoleResources, refreshNonce);
  const catalog = section === 'mcp' ? mcpCatalog : skillCatalog;
  const modules = catalog.data?.find(row => row.name === item)?.modules;
  return <ManagementShell section={section} item={item} onRefresh={refresh}
    titlePrefix={catalog.usable && <Provenance modules={modules} />}
    master={section === 'mcp' ? <McpList catalog={mcpCatalog} modules={moduleCatalog} selected={item} onChange={onChange} />
      : <SkillsList catalog={skillCatalog} modules={moduleCatalog} selected={item} onChange={onChange} />}
    detail={item === null ? <StateNotice kind="empty" placement="pane" className="manage-selection-hint">选择左侧的一项查看详情。</StateNotice>
      : section === 'mcp' ? <McpDetail catalog={mcpCatalog} name={item} />
        : <SkillDetail revision={refreshNonce} name={item} />} />;
}
