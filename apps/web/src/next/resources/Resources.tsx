import { Button } from '@cockpit/ui';
import { Link } from 'react-router-dom';
import type { ManagementHeaderProps, ManagementDetailHeaderProps } from '@cockpit/module-api';
import { useCockpit } from '../../net/store';
import { useKeyedAction } from '../../lib/useKeyedResource';
import { useGlobalResources } from '../../features/session-settings/useGlobalResources';
import { useModuleElement } from '../modules';
import { Notice } from '../settings/SettingsControls';
import { GlobalMcpDetail, GlobalSkillDetail, GlobalSkillList, ResourceList } from './ResourceContent';
import './styles.css';

function HeaderBase({ section, onRefresh, actions }: ManagementHeaderProps) {
  return <header className="next-resources-heading"><h1>{section === 'mcp' ? '全局 MCP' : '全局 Skills'}</h1>
    <div className="next-resources-actions">{actions}<Button variant="outline" onClick={onRefresh} disabled={!onRefresh}>刷新目录</Button></div>
  </header>;
}
function Header(props: ManagementHeaderProps) {
  return useModuleElement('managementHeader', HeaderBase, props);
}
function DetailHeaderBase({ item, actions }: ManagementDetailHeaderProps) {
  return <header className="next-resources-heading"><h2>{item}</h2>{actions}</header>;
}
function DetailHeader(props: ManagementDetailHeaderProps) {
  return useModuleElement('managementDetailHeader', DetailHeaderBase, props);
}
export function Resources(props: { section: 'mcp' | 'skills'; item: string | null }) {
  return <ResourcesWorkspace key={props.section} {...props} />;
}
function ResourcesWorkspace({ section, item }: { section: 'mcp' | 'skills'; item: string | null }) {
  const { mcpCatalog, refreshNonce, refresh, onChange } = useGlobalResources(section);
  const action = useKeyedAction(`global:refresh:${section}`);
  const refreshConfiguration = () => {
    if (!action.connected || action.busy) return;
    void action.run(async () => { if (section === 'mcp') await useCockpit.getState().mcpRefresh(); }, refresh);
  };
  return <div className="next-resources">
    <Header section={section} item={item} onRefresh={action.connected && !action.busy ? refreshConfiguration : undefined} />
    {action.busy && <Notice>正在刷新{section === 'mcp' ? ' Copilot MCP 配置缓存及目录' : '目录'}…</Notice>}
    {action.error && <Notice error>刷新失败：{action.error}。请重新刷新后再修改。</Notice>}
    <div className="next-resources-layout" data-detail={item !== null}>
      <aside className="next-resources-master">
        {section === 'mcp' ? <ResourceList section={section} selected={item} rows={mcpCatalog.data} status={mcpCatalog.status} failed={mcpCatalog.failed} />
          : <GlobalSkillList revision={refreshNonce} item={item} />}
      </aside>
      <section className="next-resources-main" aria-label="资源详情">
        {item === null ? <Notice>选择一个资源查看原生配置和默认设置。</Notice> : <>
          <Link className="next-resources-back" to={`/${section}`}>返回{section === 'mcp' ? ' MCP ' : '技能'}目录</Link>
          <DetailHeader item={item} />
          {section === 'mcp' ? <GlobalMcpDetail name={item} catalog={mcpCatalog} onChange={onChange} blocked={action.busy || !!action.error} />
            : <GlobalSkillDetail key={item} name={item} revision={refreshNonce} onChange={onChange} />}
        </>}
      </section>
    </div>
  </div>;
}
