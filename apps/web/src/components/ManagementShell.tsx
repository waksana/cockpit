import type { ReactNode } from 'react';
import { useUp } from '../lib/nav';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useCockpit } from '../net/store';
import { cockpitApi } from '../net/api';
import { Shell, MasterPane, DetailPane } from './Shell';
import type { ManagementHeaderProps, ManagementDetailHeaderProps } from '@cockpit/module-api/frontend';
import { useModuleElement } from './ModuleComponents';

export type ManageSection = 'mcp' | 'skills';
const SECTION_TITLE: Record<ManageSection, string> = { mcp: '全局 MCP', skills: '全局 Skills' };

function MasterHeader({ section, onRefresh, ...props }: ManagementHeaderProps) {
  const up = useUp();
  const connState = useCockpit((s) => s.connState);
  const { run, busy, error } = useKeyedAction(`global:refresh:${section}`);
  return useModuleElement('managementHeader', {
    ...props, section, onBack: () => up('/'), refreshDisabled: !onRefresh || connState !== 'open' || busy,
    refreshing: busy, error: error ?? undefined,
    onRefresh: () => { void run(async () => { if (section === 'mcp') await cockpitApi.mcpRefresh(); }, onRefresh); },
  });
}

function DetailHeader(props: ManagementDetailHeaderProps) {
  const up = useUp();
  return useModuleElement('managementDetailHeader', { ...props, onBack: () => up() });
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
