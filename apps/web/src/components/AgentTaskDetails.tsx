import { useCallback } from 'react';
import type { ReadAgentTaskDetails } from '../lib/sessionControls';
import { useKeyedResource } from '../lib/useKeyedResource';
import { useCockpit } from '../net/store';
import { StateNotice } from './StateNotice';
import { MessageBody } from './MessageBody';
import { Icon } from './Icon';

export function AgentTaskDetails({ sessionId, taskId, status, title, read, available }: {
  sessionId: string; taskId: string; status: string; title: string; read: ReadAgentTaskDetails; available: boolean;
}) {
  const revision = useCockpit(state => state.resourceRevisions[sessionId]?.tasks ?? 0);
  const load = useCallback(async (signal: AbortSignal) => {
    const detail = await read(sessionId, taskId, signal);
    if (detail && (detail.sessionId !== sessionId || detail.taskId !== taskId)) throw new Error('Agent 详情返回了不同的会话或任务。');
    return detail;
  }, [read, sessionId, taskId]);
  const resource = useKeyedResource(JSON.stringify(['agent-details', sessionId, taskId]), load, `${status}:${revision}`, available);
  const detail = resource.usable ? resource.data : undefined;
  const statusLabels = { running: '运行中', idle: '空闲', completed: '已完成', failed: '失败', cancelled: '已停止' };
  return <section className="chat-agent-detail activity-detail" aria-label={`Agent 详情：${title}`} aria-busy={resource.pending}>
    <header className="chat-controls-title">
      <span>{detail ? `${resource.pending ? '上次读取：' : ''}${statusLabels[detail.status]}` : 'Agent 详情'}</span>
      <button type="button" className="ck-icon-button" aria-label={`刷新 Agent 详情：${title}`} title="刷新 Agent 详情"
        disabled={!available || resource.pending} onClick={() => { void resource.refresh(); }}>
        <Icon name="reload" size={16} />
      </button>
    </header>
    {!available && <StateNotice>详情暂不可用，请等待会话连接恢复。</StateNotice>}
    {available && resource.error && <StateNotice kind="error">读取 Agent 详情失败：{resource.error}</StateNotice>}
    {resource.pending && <StateNotice kind="loading">正在读取 Agent 详情…</StateNotice>}
    {resource.valid && detail === null && <StateNotice>这个 Agent 已不在原生任务列表中，详情不可用。</StateNotice>}
    {detail && <>
      <dl className="chat-agent-metadata">
        <dt>任务 ID</dt><dd>{detail.taskId}</dd>
        {detail.model && <><dt>模型</dt><dd>{detail.model}</dd></>}
      </dl>
      {detail.description && <p>{detail.description}</p>}
      {detail.prompt && <details><summary>任务要求</summary><MessageBody body={detail.prompt} /></details>}
      {detail.latestIntent && <p>{detail.latestIntent}</p>}
      {detail.recentActivity.length > 0 && <section aria-label="近期进度">
        <h4>近期进度</h4>
        <ul>{detail.recentActivity.map((line, index) => <li key={`${line.timestamp}:${index}`}>{line.message}</li>)}</ul>
      </section>}
      {detail.latestResponse && <section><h4>最近回复</h4><MessageBody body={detail.latestResponse} /></section>}
      {detail.result && detail.result !== detail.latestResponse && <section><h4>结果</h4><MessageBody body={detail.result} /></section>}
      {detail.error && <StateNotice kind="error">{detail.error}</StateNotice>}
      {!detail.latestIntent && !detail.recentActivity.length && !detail.latestResponse && !detail.result && !detail.error &&
        <StateNotice>暂时没有进度或结果记录。</StateNotice>}
    </>}
  </section>;
}
