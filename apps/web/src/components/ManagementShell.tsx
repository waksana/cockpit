import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useUp } from '../lib/nav';
import { useKeyedAction } from '../lib/useKeyedResource';
import { useCockpit } from '../net/store';
import { Shell, MasterPane, DetailPane } from './Shell';
import { PaneHeader } from './PaneHeader';
import { StateNotice } from './StateNotice';
import { Icon } from './Icon';

export type ManageSection = 'mcp' | 'skills';
const SECTION_TITLE: Record<ManageSection, string> = { mcp: '全局 MCP', skills: '全局 Skills' };

function MasterHeader({ section, item, onRefresh }: {
  section: ManageSection; item: string | null; onRefresh?: () => void;
}) {
  const up = useUp();
  const backRef = useRef<HTMLButtonElement | null>(null);
  const connState = useCockpit((s) => s.connState);
  const mcpRefresh = useCockpit((s) => s.mcpRefresh);
  const { run, busy, error } = useKeyedAction(`global:refresh:${section}`);
  useLayoutEffect(() => {
    if (item === null) backRef.current?.focus();
  }, [item]);
  return <>
    <PaneHeader
      leading={<button ref={backRef} className="btn-icon rp" type="button"
        aria-label={item === null ? '返回会话列表' : `返回${SECTION_TITLE[section]}列表`}
        onClick={() => up(item === null ? '/' : `/${section}`)}>
        <Icon name="back" size={24} />
      </button>}
      title={<span className="manage-title">{SECTION_TITLE[section]}</span>}
      actions={<button className="btn-icon rp manage-action" type="button"
        aria-label={section === 'mcp' ? '刷新 Copilot MCP 配置缓存' : '刷新'}
        disabled={!onRefresh || connState !== 'open' || busy} aria-busy={busy} onClick={() => {
          void run(async () => { if (section === 'mcp') await mcpRefresh(); }, onRefresh);
        }}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="reload" size={20} />}
      </button>} />
    {error && <StateNotice kind="error">刷新失败：{error}</StateNotice>}
  </>;
}

function DetailHeader({ item }: { item: string }) {
  const up = useUp();
  const titleRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => { titleRef.current?.focus(); }, [item]);
  return <PaneHeader className="chat-topbar"
    leading={<button className="chat-back btn-icon rp lg:hidden" type="button" aria-label="返回" onClick={() => up()}>
      <Icon name="back" size={24} />
    </button>}
    title={<span ref={titleRef} tabIndex={-1} className="manage-title manage-detail-headtitle">{item}</span>} />;
}

export function ManagementShell({ section, item, master, detail, onRefresh }: {
  section: ManageSection; item: string | null; master: ReactNode; detail: ReactNode; onRefresh?: () => void;
}) {
  return <Shell ariaLabel="管理">
    <MasterPane ariaLabel={SECTION_TITLE[section]} mobileVisible={item === null}
      header={<MasterHeader section={section} item={item} onRefresh={onRefresh} />}>{master}</MasterPane>
    <DetailPane ariaLabel="详情" mobileVisible={item !== null}
      header={item !== null ? <DetailHeader item={item} /> : undefined}>{detail}</DetailPane>
  </Shell>;
}
