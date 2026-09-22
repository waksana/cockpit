import { useCallback } from 'react';
import { Button } from '@cockpit/ui';
import { useCockpit } from '../../net/store';
import { useSessionResource } from '../../lib/useSessionResource';
import { useSessionReload } from '../../features/session-settings/useSessionReload';
import type { ChatSession } from '../../net/types';
import { Notice, ResumeSession } from './SettingsControls';
import { ModelSettings } from './ModelSettings';
import { RoleSettings } from './RoleSettings';
import { SessionMcpSettings, SessionSkillSettings } from './SessionResources';
import { CopyText } from '../conversation/Markdown';
import './styles.css';

export type SessionSettingsPanel = 'info' | 'mcp' | 'skills';
export function SessionSettings({ sessionId, panel }: { sessionId: string; panel: SessionSettingsPanel }) {
  const session = useCockpit(s => s.sessions.find(row => row.sessionId === sessionId));
  if (!session) return <div className="next-settings"><Notice>会话不可用，请返回会话列表检查。</Notice></div>;
  return <div className="next-settings">
    {panel === 'info' ? <SessionInformation key={sessionId} session={session} />
      : panel === 'mcp' ? <SessionMcpSettings key={sessionId} sessionId={sessionId} />
        : <SessionSkillSettings key={sessionId} sessionId={sessionId} />}
  </div>;
}

function SessionInformation({ session }: { session: ChatSession }) {
  const sid = session.sessionId;
  const reload = useSessionReload(sid);
  const load = useCallback((signal: AbortSignal) => useCockpit.getState().getResources(sid, ['model', 'models'], signal), [sid]);
  const resource = useSessionResource(sid, `models:${sid}`, load, 0, ['model', 'models']);
  return <>
    <section className="next-settings-section"><h2>身份</h2>
      <dl className="next-settings-metadata">
        <dt>会话名称</dt><dd>{session.title}</dd><dt>工作目录</dt><dd>{session.cwd || '原生未提供'}</dd>
        <dt>Session ID</dt><dd><code>{sid}</code><CopyText text={sid} label="复制 session ID" /></dd>
      </dl>
    </section>
    <section className="next-settings-section">
      <div className="next-settings-heading"><h2>模型配置</h2>
        <Button variant="outline" disabled={!resource.connected || resource.closing || resource.pending || resource.requiresResume}
          onClick={() => { void resource.refresh(); }}>检查当前模型</Button></div>
      {resource.status && <Notice error={resource.failed}>{resource.status}</Notice>}
      {!resource.requiresResume && !resource.usable && <Notice>当前模型状态尚未确认。保留值仅供参考，请重新读取后再修改。</Notice>}
      {resource.requiresResume ? <ResumeSession sessionId={sid} onResumed={() => { void resource.refresh(); }} />
        : <ModelSettings session={{ ...session, ...resource.data }} disabled={!resource.usable}
          onSetModel={(modelId, options) => useCockpit.getState().setModel(sid, modelId, options)} />}
    </section>
    <RoleSettings session={session} />
    <section className="next-settings-section"><h2>会话操作</h2>
      <Button variant="outline" disabled={!!reload.blockedReason} aria-busy={reload.pending}
        title={reload.blockedReason} onClick={reload.reload}>
        {reload.pending ? '正在重新加载会话…' : '重新加载会话'}
      </Button>
    </section>
  </>;
}
