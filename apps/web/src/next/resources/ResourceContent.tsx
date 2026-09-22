import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { McpServerGlobal, SkillGlobal } from '@cockpit/protocol';
import { useCockpit } from '../../net/store';
import { useKeyedResource } from '../../lib/useKeyedResource';
import { Notice, ResourceSwitch } from '../settings/SettingsControls';
import { Markdown } from '../conversation/Markdown';

type GlobalToggle = (name: string, enabled: boolean) => Promise<void>;
type Catalog = ReturnType<typeof useKeyedResource<McpServerGlobal[]>>;
export function ResourceList({ section, selected, rows, status, failed }: {
  section: 'mcp' | 'skills'; selected: string | null;
  rows?: (McpServerGlobal | SkillGlobal)[]; status: string | null; failed: boolean;
}) {
  return <nav aria-label={section === 'mcp' ? '全局 MCP 目录' : '全局技能目录'} className="next-resources-list">
    {status && <Notice error={failed}>{status}</Notice>}
    {rows?.map(row => <Link key={row.name} to={`/${section}/${encodeURIComponent(row.name)}`}
      replace={selected !== null} aria-current={selected === row.name ? 'page' : undefined}>
      <strong>{row.name}</strong>
      {'detail' in row ? <span>{row.detail}</span> : row.description && <span>{row.description}</span>}
    </Link>)}
    {!status && !rows?.length && <Notice>目录为空。</Notice>}
  </nav>;
}
export function GlobalMcpDetail({ name, catalog, onChange, blocked = false }: {
  name: string; catalog: Catalog; onChange: GlobalToggle; blocked?: boolean;
}) {
  const row = catalog.data?.find(item => item.name === name);
  return <div className="next-resources-detail">
    {catalog.status && <Notice error={catalog.failed}>{catalog.status}</Notice>}
    {!row ? !catalog.status && <Notice>未找到该 MCP 服务器。</Notice> : <>
      <p>{row.detail}</p>
      {!catalog.usable && <Notice>显示的是上次读取的配置；当前状态未确认。</Notice>}
      <ResourceSwitch identity={`global:mcp:${row.name}`} label="新会话默认开启" enabled={row.defaultOn}
        disabled={!catalog.valid || blocked} onChange={enabled => onChange(row.name, enabled)} />
      <p className="next-resources-muted">仅修改新会话默认值，不改变已加载会话的连接。</p>
      {row.config && <details open><summary>原生配置</summary><pre>{JSON.stringify(row.config, null, 2)}</pre></details>}
    </>}
  </div>;
}
export function GlobalSkillList({ revision, item }: { revision: number; item: string | null }) {
  const read = useCockpit(s => s.skillsGlobal);
  const load = useCallback(() => read(), [read]);
  const catalog = useKeyedResource('global:skills', load, revision);
  return <ResourceList section="skills" selected={item} rows={catalog.data} status={catalog.status} failed={catalog.failed} />;
}
export function SkillContent({ data, valid, onChange }: {
  data: Awaited<ReturnType<ReturnType<typeof useCockpit.getState>['skillsRead']>>;
  valid: boolean; onChange: GlobalToggle;
}) {
  return <>
    {(data.source || data.userInvocable) && <p className="next-resources-muted">{data.source}{data.userInvocable && ' · 可手动调用'}</p>}
    {typeof data.enabled === 'boolean'
      ? <ResourceSwitch identity={`global:skill-toggle:${data.name}`} label="全局默认启用" enabled={data.enabled}
          disabled={!valid} onChange={enabled => onChange(data.name, enabled)} />
      : <Notice>Copilot 未提供全局启用状态。</Notice>}
    <p className="next-resources-muted">用于新建或卸载后重新加载的会话，不改变当前已加载会话。</p>
    {data.description && <p>{data.description}</p>}
    {data.body ? <Markdown body={data.body} /> : <Notice>没有 SKILL.md 内容。</Notice>}
  </>;
}
export function GlobalSkillDetail({ name, revision, onChange }: { name: string; revision: number; onChange: GlobalToggle }) {
  const read = useCockpit(s => s.skillsRead);
  const load = useCallback(() => read(name), [read, name]);
  const resource = useKeyedResource(`global:skill:${name}`, load, revision);
  return <div className="next-resources-detail">
    {resource.status && <Notice error={resource.failed}>{resource.status}</Notice>}
    {resource.data ? <>
      {!resource.usable && <Notice>显示的是上次读取的内容；当前启用状态未确认。</Notice>}
      <SkillContent data={resource.data} valid={resource.valid} onChange={onChange} />
    </> : !resource.status && <Notice>未找到该技能。</Notice>}
  </div>;
}
