// Session settings panel — opened by the chat title or the shared session menu.
// It reads identifying summary fields and on-demand model state; MCP and Skills
// resources are owned by their dedicated pages.

import { useCallback, useRef, useState } from 'react';
import { classifyNativeModelSwitchResult } from '@cockpit/protocol';
import type { IntentResult, NativeModelSwitchResult } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useSessionResource } from '../lib/useSessionResource';
import { useKeyedAction } from '../lib/useKeyedResource';
import { ExpandableText, PanelPageShell, RefreshButton, ResourceStatus, SessionResume } from './SessionPanelKit';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';
import type { ChatSession } from '../net/types';

type ContextTier = 'default' | 'long_context';

const EFFORT_LABEL: Record<string, string> = {
  none: '不思考', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
};
const CONTEXT_LABEL: Record<ContextTier, string> = { default: '标准上下文', long_context: '长上下文' };

type ModelSelection = { modelId: string; reasoningEffort?: string; contextTier?: ContextTier };
const selectionFrom = (session: ChatSession): ModelSelection => ({
  modelId: session.currentModelId ?? '',
  ...(session.currentReasoningEffort ? { reasoningEffort: session.currentReasoningEffort } : {}),
  ...(session.currentContextTier ? { contextTier: session.currentContextTier } : {}),
});
const selectionLabel = (selection: ModelSelection) => [
  selection.modelId || '模型未提供',
  `思考力度：${selection.reasoningEffort ? EFFORT_LABEL[selection.reasoningEffort] ?? selection.reasoningEffort : '未指定'}`,
  `上下文：${selection.contextTier ? CONTEXT_LABEL[selection.contextTier] ?? selection.contextTier : '未指定'}`,
].join(' · ');

function CurrentModel({ session }: { session: ChatSession }) {
  const { currentModelId, currentReasoningEffort, currentContextTier } = session;
  const name = session.availableModels?.find(model => model.modelId === currentModelId)?.name
    ?? currentModelId ?? '模型未提供';
  const effort = currentReasoningEffort ? EFFORT_LABEL[currentReasoningEffort] ?? currentReasoningEffort : null;
  const context = currentContextTier ? CONTEXT_LABEL[currentContextTier] ?? currentContextTier : null;
  return <div className="info-model-current" aria-label="当前模型">
    <span className="info-model-eyebrow">当前原生值：</span>
    <span className="info-model-name" title={currentModelId ?? undefined}>{name}</span>
    {(effort || context) && <div className="info-model-specs">
      {effort && <span aria-label={`思考力度：${effort}`}>{effort}</span>}
      {context && <span aria-label={`上下文：${context}`}>{context}</span>}
    </div>}
  </div>;
}

function ModelSubmissionDetails({ selection, result }: { selection?: ModelSelection; result?: NativeModelSwitchResult }) {
  return <details className="info-model-details">
    <summary>提交详情</summary>
    {selection && <div>上次提交：{selectionLabel(selection)}</div>}
    {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
  </details>;
}

export function ModelOutcome({ result, selection }: { result: NativeModelSwitchResult; selection?: ModelSelection }) {
  const classification = classifyNativeModelSwitchResult(result);
  const status = {
    applied: '已应用',
    unchanged: '原生设置未变',
    queued: '已接受，等待原生应用',
    failed: '原生报告失败或拒绝，请核对当前设置',
    'needs-action': '原生要求确认或后续操作，尚未确认应用',
    unknown: `应用结果未确认${result.status ? `（${result.status}）` : '（原生未提供状态）'}`,
  }[classification.state];
  const persistence = classification.persistenceFailed
    ? `${classification.state === 'applied' ? '，但' : '；'}原生持久化失败：${result.persistenceError || '原生未提供错误详情'}` : '';
  const message = (classification.state === 'failed' || classification.state === 'needs-action') && result.message
    ? `：${result.message}` : '';
  return <div className="info-model-result">
    <div className="info-model-status" role={classification.isError ? 'alert' : 'status'}>
      {status + persistence + message}
    </div>
    {result.confirmation && <div>
      目标：{result.confirmation.targetModelDisplayName}；当前令牌：{result.confirmation.currentTokens}；目标上限：{result.confirmation.targetLimit}。
      本页不会自动确认或继续执行。
    </div>}
    {result.warning && <div>{result.warning}</div>}
    <ModelSubmissionDetails selection={selection} result={result} />
  </div>;
}

// A mounted editor owns desired settings; snapshots remain the separate native
// current value. A late result never rewrites this draft or submits a follow-up.
export function ModelControls({ session, onSetModel, disabled, resource }: {
  session: ChatSession;
  onSetModel: SessionInfoPanelProps['onSetModel'];
  disabled: boolean;
  resource?: {
    status: string | null; failed: boolean; pending: boolean; usable: boolean;
    onRefresh: () => void; refreshDisabled: boolean;
  };
}) {
  const [draft, setDraft] = useState<{ selection: ModelSelection; revision: number } | null>(null);
  const [submission, setSubmission] = useState<{ selection: ModelSelection; revision: number } | null>(null);
  const [outcome, setOutcome] = useState<IntentResult<'setModel'> | null>(null);
  const submittedRevision = useRef<number | null>(null);
  const action = useKeyedAction(`model:${session.sessionId}`);
  const selection = draft?.selection ?? selectionFrom(session);
  const revision = draft?.revision ?? 0;
  const edit = (next: ModelSelection) => setDraft({ selection: next, revision: revision + 1 });
  const heading = <>
    <div className="info-section-name">模型配置
      {resource && <RefreshButton onClick={resource.onRefresh}
        disabled={resource.refreshDisabled || resource.pending || action.busy}
        pending={resource.pending && resource.usable && !action.busy} />}
    </div>
    {resource && <ResourceStatus
      status={resource.pending && (resource.usable || action.busy) ? null : resource.status}
      failed={resource.failed} pending={resource.pending} />}
  </>;
  const resultView = <>
    {action.error && <div className="info-model-status" role="alert">
      应用结果未确认：{action.error}。请核对原生状态；不会自动重试。
    </div>}
    {submission && !action.busy && !action.error && !outcome
      && <div className="info-model-status" role="status">提交结果尚未确认，请核对原生状态；不会自动重试。</div>}
    {outcome ? <ModelOutcome result={outcome.result} selection={submission?.selection} />
      : submission && <ModelSubmissionDetails selection={submission.selection} />}
  </>;
  const list = session.availableModels;
  if (!list || list.length === 0) return <section className="info-section">
    {heading}
    <div className="info-section-content info-controls">
      <CurrentModel session={session} />
      <div className="info-empty">{list ? '原生可选模型列表为空' : '原生可选模型列表不可用'}</div>
      {action.busy && <div className="info-model-status" role="status">正在提交…</div>}
      {resultView}
    </div>
  </section>;

  const current = selection.modelId;
  const currentModel = list.find((m) => m.modelId === current);
  const efforts = currentModel?.supportedReasoningEfforts ?? [];
  const supportsLong = currentModel?.supportsLongContext ?? false;
  const curEffort = selection.reasoningEffort ?? '';
  const curTier = selection.contextTier ?? '';
  const invalid = !currentModel || (efforts.length > 0 && !!curEffort && !efforts.includes(curEffort));
  const apply = () => {
    if (disabled || invalid || action.busy || submittedRevision.current === revision) return;
    submittedRevision.current = revision;
    const options = {
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      ...(selection.contextTier ? { contextTier: selection.contextTier } : {}),
    };
    setSubmission({ selection, revision });
    setOutcome(null);
    let result: IntentResult<'setModel'>;
    void action.run(async () => { result = await onSetModel(selection.modelId, options); }, () => setOutcome(result));
  };

  return (
    <section className="info-section">
      {heading}
      <div className="info-section-content info-controls">
        <CurrentModel session={session} />
        <p className="info-model-hint">{draft ? '编辑草稿；手动应用后，请核对结果与当前原生值。' : '修改后手动应用；重置将使用当前原生值。'}</p>
        <label className="info-control">
          <span className="info-control-label">模型</span>
          <span className="info-select-wrap">
            <select className="info-select ck-input" disabled={disabled} value={current}
              onChange={(e) => edit({ modelId: e.target.value })} aria-label="选择模型">
              {current === '' && <option value="" disabled>选择模型…</option>}
              {current !== '' && !currentModel && <option value={current} disabled>{current}（当前值，列表未提供）</option>}
              {list.map((m) => <option key={m.modelId} value={m.modelId}>{m.name}</option>)}
            </select>
            <Icon name="down" size={16} />
          </span>
        </label>

        {efforts.length > 0 && (
          <label className="info-control">
            <span className="info-control-label">思考力度</span>
            <span className="info-select-wrap">
              <select className="info-select ck-input" disabled={disabled} value={curEffort}
                onChange={(e) => edit({ ...selection, reasoningEffort: e.target.value || undefined })} aria-label="思考力度">
                <option value="">未指定</option>
                {curEffort !== '' && !efforts.includes(curEffort) && <option value={curEffort} disabled>{curEffort}（当前值，列表未提供）</option>}
                {efforts.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e] ?? e}</option>)}
              </select>
              <Icon name="down" size={16} />
            </span>
          </label>
        )}

        {supportsLong && (
          <label className="info-control">
            <span className="info-control-label">上下文长度</span>
            <span className="info-select-wrap">
              <select className="info-select ck-input" disabled={disabled} value={curTier}
                onChange={(e) => edit({ ...selection, contextTier: e.target.value ? e.target.value as ContextTier : undefined })} aria-label="上下文长度">
                <option value="">未指定</option>
                <option value="default">标准上下文</option>
                <option value="long_context">长上下文</option>
              </select>
              <Icon name="down" size={16} />
            </span>
          </label>
        )}
        <div className="info-model-actions">
          <button type="button" className="dialog-btn ck-button ck-primary primary rp"
            disabled={disabled || invalid || action.busy || submission?.revision === revision}
            aria-busy={action.busy}
            onClick={apply}>{action.busy ? '正在提交…' : '应用配置'}</button>
          <button type="button" className="dialog-btn ck-button rp" aria-label="使用当前原生值"
            disabled={disabled || !draft} onClick={() => edit(selectionFrom(session))}>重置</button>
        </div>
        {resultView}
      </div>
    </section>
  );
}


export interface SessionInfoPanelProps {
  session: ChatSession;
  open: boolean;
  onClose: () => void;
  onSetModel: (modelId: string, opts?: { reasoningEffort?: string; contextTier?: ContextTier }) => Promise<IntentResult<'setModel'>>;
}

export function SessionInfoPanel(props: SessionInfoPanelProps) {
  if (!props.open) return null;
  return <InfoDetails key={props.session.sessionId} {...props} />;
}

function InfoDetails({ session, onClose, onSetModel }: SessionInfoPanelProps) {
  const sid = session.sessionId;
  const load = useCallback((signal: AbortSignal) => useCockpit.getState().getResources(sid, ['model', 'models'], signal), [sid]);
  const resource = useSessionResource(sid, `models:${sid}`, load, 0, ['model', 'models']);

  return (
    <PanelPageShell title="会话设置" onClose={onClose} bodyClassName="session-settings">
      <section className="info-section">
        <ExpandableText className="info-summary-title" text={session.title} label="会话标题" />
        <div className="info-section-content info-meta-cwd">{session.cwd || '工作目录：原生未提供'}</div>
        <div className="info-section-content info-session-id">
          <div className="info-session-id-heading">
            <span className="info-meta-id-label">Session ID</span>
            <CopyButton text={session.sessionId} label="复制 session ID" />
          </div>
          <span className="info-session-id-value">{session.sessionId}</span>
        </div>
      </section>

      <SessionResume sessionId={sid} required={resource.requiresResume} onResumed={() => { void resource.refresh(); }} />
      {resource.requiresResume && <ResourceStatus status={resource.status} failed={resource.failed} pending={resource.pending} />}
      {/* Accepted same-connection data supports edits and Apply during refresh. */}
      {!resource.requiresResume && <ModelControls key={sid} session={{ ...session, ...resource.data }}
        disabled={!resource.usable} onSetModel={onSetModel}
        resource={{
          ...resource, onRefresh: () => { void resource.refresh(); },
          refreshDisabled: !resource.connected || resource.closing,
        }} />}
    </PanelPageShell>
  );
}
