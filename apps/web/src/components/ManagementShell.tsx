import type { ReactNode } from 'react';
import { useUp } from '../lib/nav';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useCockpit } from '../net/store';
import { Shell, MasterPane, DetailPane } from './Shell';
import { PaneHeader } from './PaneHeader';
import { StateNotice } from './StateNotice';
import { IconButton, RefreshButton } from './Button';
import type { ManagementHeaderProps, ManagementDetailHeaderProps } from '@cockpit/module-api';
import { useModuleElement } from './ModuleComponents';

export type ManageSection = 'mcp' | 'skills';
const SECTION_TITLE: Record<ManageSection, string> = { mcp: '全局 MCP', skills: '全局 Skills' };

function MasterHeader(props: ManagementHeaderProps) {
  return useModuleElement('managementHeader', MasterHeaderBase, props);
}
function MasterHeaderBase({ section, onRefresh, actions }: ManagementHeaderProps) {
  const up = useUp();
  const connState = useCockpit((s) => s.connState);
  const mcpRefresh = useCockpit((s) => s.mcpRefresh);
  const { run, busy, error } = useKeyedAction(`global:refresh:${section}`);
  return <>
    <PaneHeader
      leading={<IconButton icon="back" label="返回会话列表" onClick={() => up('/')} />}
      title={<span className="pane-title ck-text-primary">{SECTION_TITLE[section]}</span>}
      actions={<>{actions}<RefreshButton label={section === 'mcp' ? '刷新 Copilot MCP 配置缓存' : '刷新'}
        disabled={!onRefresh || connState !== 'open' || busy} pending={busy} onClick={() => {
          void run(async () => { if (section === 'mcp') await mcpRefresh(); }, onRefresh);
        }} /></>} />
    {error && <StateNotice kind="error">刷新失败：{error}</StateNotice>}
  </>;
}

function DetailHeader(props: ManagementDetailHeaderProps) {
  return useModuleElement('managementDetailHeader', DetailHeaderBase, props);
}
function DetailHeaderBase({ item, titlePrefix, actions }: ManagementDetailHeaderProps) {
  const up = useUp();
  return <PaneHeader className="chat-topbar manage-detail-header"
    leading={<IconButton className="chat-back lg:hidden" icon="back" label="返回" onClick={() => up()} />}
    title={<span className="pane-title resource-name">{titlePrefix}<span>{item}</span></span>}
    actions={actions} />;
}

export function ManagementShell({ section, item, master, detail, titlePrefix, onRefresh }: {
  section: ManageSection; item: string | null; master: ReactNode; detail: ReactNode; titlePrefix?: ReactNode; onRefresh?: () => void;
}) {
  return <Shell ariaLabel="管理"
    master={<MasterPane ariaLabel={SECTION_TITLE[section]} mobileVisible={item === null}
      header={<MasterHeader section={section} item={item} onRefresh={onRefresh} />}>{master}</MasterPane>}
    main={<DetailPane ariaLabel="详情" mobileVisible={item !== null}
      header={item !== null ? <DetailHeader item={item} titlePrefix={titlePrefix} /> : undefined}>{detail}</DetailPane>} />;
}
