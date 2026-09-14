// Session settings panel — opened by the chat title or the shared session menu.
// It reads identifying summary fields and on-demand model state; MCP and Skills
// resources are owned by their dedicated pages.

import { useCallback, useRef, useState } from 'react';
import { classifyNativeModelSwitchResult } from '@cockpit/protocol';
import type { IntentResult, NativeModelSwitchResult } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useSessionResource } from '../lib/useSessionResource';
import { useKeyedAction } from '../lib/useKeyedResource';
import { PanelPageShell, PermissionPolicy, ResourceStatus, SessionResume } from './SessionPanelKit';
import type { ChatSession, ModelOption } from '../net/types';

type ContextTier = 'default' | 'long_context';

const EFFORT_LABEL: Record<string, string> = {
  none: '不思考', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
};

type ModelSelection = { modelId: string; reasoningEffort?: string; contextTier?: ContextTier };
const selectionFrom = (session: ChatSession): ModelSelection => ({
  modelId: session.currentModelId ?? '',
  ...(session.currentReasoningEffort ? { reasoningEffort: session.currentReasoningEffort } : {}),
  ...(session.currentContextTier ? { contextTier: session.currentContextTier } : {}),
});
const selectionLabel = (selection: ModelSelection) => [
  selection.modelId || '模型未提供',
  `思考力度：${selection.reasoningEffort || '未指定'}`,
  `上下文：${selection.contextTier || '未指定'}`,
].join(' · ');

export function ModelOutcome({ result }: { result: NativeModelSwitchResult }) {
  const classification = classifyNativeModelSwitchResult(result);
  const status = {
    applied: '已应用',
    unchanged: '原生设置未变',
    queued: '已接受，等待原生应用',
    failed: '原生报告失败或拒绝，请核对当前设置',
    'needs-action': '原生要求确认或后续操作，尚未确认应用',
    unknown: `应用结果未确认${result.status ? `（${result.status}）` : '（原生未提供状态）'}`,
  }[classification.state];
  return <div className="info-empty info-model-result" role={classification.isError ? 'alert' : 'status'}>
    <div>上次原生返回：{status}</div>
    {classification.persistenceFailed && <div>
      {classification.state === 'applied' ? '已应用，但原生持久化失败' : '原生持久化失败'}：{result.persistenceError || '原生未提供错误详情'}
    </div>}
    {result.confirmation && <div>
      目标：{result.confirmation.targetModelDisplayName}；当前令牌：{result.confirmation.currentTokens}；目标上限：{result.confirmation.targetLimit}。
      本页不会自动确认或继续执行。
    </div>}
    {result.message && <div>原生消息：{result.message}</div>}
    {result.warning && <div>{result.warning}</div>}
    {result.deprecationWarnings?.map((warning, index) => <div key={index}>{warning}</div>)}
    <details><summary>原生返回详情</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
  </div>;
}

// A mounted editor owns desired settings; snapshots remain the separate native
// current value. A late result never rewrites this draft or submits a follow-up.
export function ModelControls({ session, onSetModel, disabled }: {
  session: ChatSession;
  onSetModel: SessionInfoPanelProps['onSetModel'];
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<{ selection: ModelSelection; revision: number } | null>(null);
  const [submission, setSubmission] = useState<{ selection: ModelSelection; revision: number } | null>(null);
  const [outcome, setOutcome] = useState<IntentResult<'setModel'> | null>(null);
  const submittedRevision = useRef<number | null>(null);
  const action = useKeyedAction(`model:${session.sessionId}`);
  const selection = draft?.selection ?? selectionFrom(session);
  const revision = draft?.revision ?? 0;
  const edit = (next: ModelSelection) => setDraft({ selection: next, revision: revision + 1 });
  const resultView = <>
    {submission && <div className="info-empty">上次提交：{selectionLabel(submission.selection)}</div>}
    {action.busy && <div className="info-empty" role="status">正在提交配置，尚未确认应用…</div>}
    {action.error && <div className="info-empty" role="alert">
      应用结果未确认：{action.error}。请核对原生状态；不会自动重试。
    </div>}
    {submission && !action.busy && !action.error && !outcome
      && <div className="info-empty" role="status">提交结果尚未确认，请核对原生状态；不会自动重试。</div>}
    {outcome && <ModelOutcome result={outcome.result} />}
  </>;
  const list = session.availableModels;
  if (!list || list.length === 0) return <section className="info-section">
    <div className="info-section-name">模型</div>
    <div className="info-section-content">{session.currentModelId ?? '当前模型不可用'}</div>
    <div className="info-empty">{list ? '原生可选模型列表为空' : '原生可选模型列表不可用'}</div>
    <div className="info-section-content info-controls">{resultView}</div>
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
      <div className="info-section-name">模型</div>
      <div className="info-empty info-model-current">当前原生值：{selectionLabel(selectionFrom(session))}</div>
      <div className="info-section-content info-controls">
        <label className="info-control">
          <span className="info-control-label">模型</span>
          <select className="info-select" disabled={disabled} value={current}
            onChange={(e) => edit({ modelId: e.target.value })} aria-label="选择模型">
            {current === '' && <option value="" disabled>选择模型…</option>}
            {current !== '' && !currentModel && <option value={current} disabled>{current}（当前值，列表未提供）</option>}
            {list.map((m) => <option key={m.modelId} value={m.modelId}>{m.name}</option>)}
          </select>
        </label>

        {efforts.length > 0 && (
          <label className="info-control">
            <span className="info-control-label">思考力度</span>
            <select className="info-select" disabled={disabled} value={curEffort}
              onChange={(e) => edit({ ...selection, reasoningEffort: e.target.value || undefined })} aria-label="思考力度">
              <option value="">未指定（交由原生处理）</option>
              {curEffort !== '' && !efforts.includes(curEffort) && <option value={curEffort} disabled>{curEffort}（当前值，列表未提供）</option>}
              {efforts.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e] ?? e}</option>)}
            </select>
          </label>
        )}

        {supportsLong && (
          <label className="info-control">
            <span className="info-control-label">上下文长度</span>
            <select className="info-select" disabled={disabled} value={curTier}
              onChange={(e) => edit({ ...selection, contextTier: e.target.value ? e.target.value as ContextTier : undefined })} aria-label="上下文长度">
              <option value="">未指定（交由原生处理）</option>
              <option value="default">标准上下文</option>
              <option value="long_context">长上下文</option>
            </select>
          </label>
        )}
        {currentModel && currentModel.supportedReasoningEfforts === undefined
          && <div className="info-empty">原生未提供思考力度选项{curEffort ? `；当前值：${EFFORT_LABEL[curEffort] ?? curEffort}` : ''}</div>}
        {currentModel && currentModel.supportsLongContext === undefined
          && <div className="info-empty">原生未提供上下文档位能力{curTier ? `；当前值：${curTier}` : ''}</div>}
        {currentModel?.supportedReasoningEfforts?.length === 0 && curEffort
          && <div className="info-empty">思考力度当前值：{EFFORT_LABEL[curEffort] ?? curEffort}（原生未列出可选档位）</div>}
        {currentModel?.supportsLongContext === false && curTier
          && <div className="info-empty">上下文长度当前值：{curTier === 'default' ? '标准上下文' : curTier}（原生未列出长上下文支持）</div>}
        <div className="info-empty">先选择完整组合，再应用一次。未指定的选项不会发送，其行为由原生决定。</div>
        <div className="info-model-actions">
          <button type="button" className="dialog-btn primary rp"
            disabled={disabled || invalid || action.busy || submission?.revision === revision}
            onClick={apply}>应用配置</button>
          <button type="button" className="dialog-btn rp" disabled={disabled}
            onClick={() => edit(selectionFrom(session))}>使用当前原生值</button>
        </div>
        {resultView}
      </div>
    </section>
  );
}


export interface SessionInfoPanelProps {
  session: ChatSession;
  models: ModelOption[];
  open: boolean;
  onClose: () => void;
  onSetModel: (modelId: string, opts?: { reasoningEffort?: string; contextTier?: ContextTier }) => Promise<IntentResult<'setModel'>>;
}

export function SessionInfoPanel(props: SessionInfoPanelProps) {
  if (!props.open) return null;
  return <InfoDetails key={props.session.sessionId} {...props} />;
}

function InfoDetails({ session, onClose, onSetModel }: SessionInfoPanelProps) {
  const connected = useCockpit((s) => s.connState === 'open');
  const sid = session.sessionId;
  const authoritative = useCockpit((s) => s.sessions.find(row => row.sessionId === sid));
  const loaded = authoritative?.loaded ?? session.loaded;
  const load = useCallback((signal: AbortSignal) => useCockpit.getState().getResources(sid, ['model', 'models'], signal), [sid]);
  const resource = useSessionResource(sid, `models:${sid}`, load, 0, ['model', 'models']);

  return (
    <PanelPageShell title={`会话设置 · ${session.title}`} onClose={onClose}>
      <section className="info-section">
        <div className="info-section-name">{session.title}</div>
        <div className="info-section-content info-meta-cwd">{session.cwd || '工作目录：原生未提供'}</div>
        <div className="info-section-content info-meta-id"><span className="info-meta-id-label">ID</span>{session.sessionId}</div>
      </section>

      <SessionResume sessionId={sid} required={!loaded} />
      {!loaded && <div className="info-empty">未加载：模型及资源状态不可用，不显示上次读值或全局默认值。</div>}
      <ResourceStatus status={resource.status} failed={resource.failed} />
      {loaded && <ModelControls key={sid} session={{ ...session, ...resource.data }}
        disabled={!connected || resource.pending || resource.failed} onSetModel={onSetModel} />}
      <PermissionPolicy />
    </PanelPageShell>
  );
}
