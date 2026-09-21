import { Button } from '@cockpit/ui';
import { classifyNativeModelSwitchResult, type NativeModelSwitchResult } from '@cockpit/protocol';
import type { ChatSession } from '../../net/types';
import { useModelSettings, type ContextTier, type ModelSelection, type SetModel } from '../../features/session-settings/useModelSettings';
import { Notice, SettingSelect } from './SettingsControls';

const effortLabel: Record<string, string> = {
  none: '不思考', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
};
const contextLabel: Record<string, string> = { default: '标准上下文', long_context: '长上下文' };
export function NativeModelOutcome({ result, selection }: { result: NativeModelSwitchResult; selection?: ModelSelection }) {
  const classification = classifyNativeModelSwitchResult(result);
  const status = {
    applied: '已应用', unchanged: '原生设置未变', queued: '已接受，等待原生应用',
    failed: '原生报告失败或拒绝，请核对当前设置', 'needs-action': '原生要求确认或后续操作，尚未确认应用',
    unknown: `应用结果未确认${result.status ? `（${result.status}）` : '（原生未提供状态）'}`,
  }[classification.state];
  return <div className="next-settings-section">
    <Notice error={classification.isError}>
      {status}
      {classification.persistenceFailed && `；原生持久化失败：${result.persistenceError || '原生未提供错误详情'}`}
      {(classification.state === 'failed' || classification.state === 'needs-action') && result.message && `：${result.message}`}
    </Notice>
    {result.confirmation && <p>目标：{result.confirmation.targetModelDisplayName}；当前令牌：{result.confirmation.currentTokens}；
      目标上限：{result.confirmation.targetLimit}。本页不会自动确认或继续执行。</p>}
    {result.warning && <p>{result.warning}</p>}
    <details><summary>提交详情</summary>
      {selection && <pre>{JSON.stringify(selection, null, 2)}</pre>}
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </details>
  </div>;
}

export function ModelSettings({ session, disabled, onSetModel }: { session: ChatSession; disabled: boolean; onSetModel: SetModel }) {
  const model = useModelSettings(session, onSetModel, disabled);
  const { selection, list, action, submission, outcome } = model;
  return <div className="next-settings-section">
    <dl className="next-settings-metadata" aria-label="当前原生模型值">
      <dt>当前模型</dt><dd>{session.currentModelId || '原生未提供'}</dd>
      <dt>思考力度</dt><dd>{session.currentReasoningEffort ? effortLabel[session.currentReasoningEffort] ?? session.currentReasoningEffort : '未指定'}</dd>
      <dt>上下文</dt><dd>{session.currentContextTier ? contextLabel[session.currentContextTier] ?? session.currentContextTier : '未指定'}</dd>
    </dl>
    {!list?.length ? <Notice>{list ? '原生可选模型列表为空' : '原生可选模型列表不可用'}</Notice>
      : <div className="next-settings-section">
        <SettingSelect label="模型" value={selection.modelId} disabled={disabled} placeholder="选择模型…"
          options={list.map(item => ({ value: item.modelId, label: item.name }))}
          onChange={modelId => model.edit({ modelId: modelId ?? '' })} />
        {model.efforts.length > 0 && <SettingSelect label="思考力度" value={selection.reasoningEffort} disabled={disabled}
          options={model.efforts.map(value => ({ value, label: effortLabel[value] ?? value }))}
          onChange={reasoningEffort => model.edit({ ...selection, reasoningEffort })} />}
        {model.supportsLong && <SettingSelect label="上下文长度" value={selection.contextTier} disabled={disabled}
          options={Object.entries(contextLabel).map(([value, label]) => ({ value, label }))}
          onChange={contextTier => model.edit({ ...selection, contextTier: contextTier as ContextTier | undefined })} />}
        <div className="next-settings-actions">
          <Button disabled={disabled || model.invalid || action.busy || submission?.revision === model.revision}
            aria-busy={action.busy} onClick={model.apply}>{action.busy ? '正在提交…' : '应用配置'}</Button>
          <Button variant="outline" disabled={disabled || !model.draft} onClick={model.reset}>使用当前原生值</Button>
        </div>
      </div>}
    {action.error && <Notice error>应用结果未确认：{action.error}。请刷新核对原生状态；不会自动重试。</Notice>}
    {submission && !action.busy && !action.error && !outcome && <Notice>提交结果尚未确认，请刷新核对原生状态。</Notice>}
    {outcome && <NativeModelOutcome result={outcome.result} selection={submission?.selection} />}
  </div>;
}
