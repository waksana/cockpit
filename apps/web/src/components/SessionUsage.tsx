import { useCallback } from 'react';
import type { SessionUsage as Usage } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useSessionResource } from '../lib/useSessionResource';
import { ResourceStatus } from './SessionPanelKit';

const count = (value: number | undefined) => value === undefined ? '未提供' : value.toLocaleString('zh-CN');

export function UsageValues({ value }: { value: Usage }) {
  const { context, usage } = value;
  const ratio = context && context.promptTokenLimit > 0 && ['selected', 'autoResolved'].includes(context.modelSource)
    ? `${(context.totalTokens / context.promptTokenLimit * 100).toFixed(1)}%` : null;
  return (
    <>
      {context ? <>
        <div className="info-option-row"><span>当前上下文（原生估算）</span><strong>{count(context.totalTokens)} tokens</strong></div>
        <div className="info-option-row"><span>原生输入上限</span><span>{context.promptTokenLimit > 0 ? `${count(context.promptTokenLimit)} tokens` : '暂不可用'}{ratio && ` · ${ratio}`}</span></div>
        <p className="info-option-hint">计数模型：{context.modelId}（{context.modelSource}）。{!ratio && '模型或上限尚未明确，不计算比例。'}</p>
      </> : <p className="info-option-hint">当前上下文暂不可用：原生尚未初始化系统提示或工具信息。不是0 tokens，不会为此发送推理请求。</p>}
      <div className="info-option-row"><span>最近主代理调用 · 输入 / 输出</span><span>{count(usage.lastCallInputTokens)} / {count(usage.lastCallOutputTokens)} tokens</span></div>
      <p className="info-option-hint">最近调用 ≠ 当前上下文。累计仅为原生当前可读记录，不保证跨恢复/回退的完整总账。</p>
      {Object.entries(usage.modelMetrics).map(([model, metric]) => metric && (
        <div key={model} className="info-controls">
          <div className="info-option-label">{model} · 原生按模型累计</div>
          <div className="info-option-row"><span>输入 / 输出</span><span>{count(metric.usage.inputTokens)} / {count(metric.usage.outputTokens)}</span></div>
          <div className="info-option-row"><span>提示缓存读 / 写</span><span>{count(metric.usage.cacheReadTokens)} / {count(metric.usage.cacheWriteTokens)}</span></div>
          <div className="info-option-row"><span>推理输出</span><span>{count(metric.usage.reasoningTokens)}</span></div>
        </div>
      ))}
      {Object.keys(usage.modelMetrics).length === 0 && <p className="info-option-hint">原生未提供模型累计记录。</p>}
      <details className="info-option-hint">
        <summary>口径与来源 · {new Date(value.sampledAt).toLocaleTimeString('zh-CN')}</summary>
        <p>上下文占用与输入上限来自同一原生快照，不是模型宣传窗口。包含系统/指令、用户/助手/工具消息和工具定义。</p>
        {context && <p>工具定义：{count(context.categories.systemTools + context.categories.mcpTools)}；消息：{count(context.categories.messages)} tokens。成功压缩：{count(context.compactions.count)}次。</p>}
        <p>重复输入会累计；重启、子代理与辅助命名的覆盖以原生归集为准，未另行累加。调用前原生可能返回0。缓存指provider提示缓存，不是浏览器阅读窗口；不推算费用。</p>
        <p>此页打开时按需读取，并在相关原生变化、重连或手动刷新后更新，不后台轮询。上下文与用量分别读取，活动中的数值可能继续变化。</p>
      </details>
    </>
  );
}

export function SessionUsage({ sessionId }: { sessionId: string }) {
  const getUsage = useCockpit(s => s.getUsage);
  const load = useCallback((signal: AbortSignal) => getUsage(sessionId, signal), [getUsage, sessionId]);
  const resource = useSessionResource(sessionId, `usage:${sessionId}`, load, 0, ['usage']);
  return (
    <section className="info-section" aria-label="用量与上下文">
      <div className="info-section-name">用量与上下文
        <button type="button" className="dialog-btn" aria-label="刷新用量与上下文"
          disabled={resource.requiresResume || !resource.connected || resource.pending}
          onClick={() => { void resource.refresh(); }}>刷新</button>
      </div>
      <div className="info-section-content info-controls">
        <ResourceStatus status={resource.status} failed={resource.failed} />
        {resource.requiresResume && <p className="info-option-hint">会话未加载，用量暂不可用；不会自动恢复。需要时使用本页原有“恢复会话”。</p>}
        {resource.data && <>
          {!resource.valid && <p className="info-option-hint">以下是上次成功读取的快照，不代表已刷新。</p>}
          <UsageValues value={resource.data} />
        </>}
      </div>
    </section>
  );
}
