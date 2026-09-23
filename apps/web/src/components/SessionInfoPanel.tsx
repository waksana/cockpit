// Session settings panel — opened by the chat title or the shared session menu.
// It reads identifying summary fields and on-demand model state; MCP and Skills
// resources are owned by their dedicated pages.

import { useCallback, useLayoutEffect, useRef } from 'react';
import { classifyNativeModelSwitchResult } from '@cockpit/protocol';
import type { IntentResult, NativeModelSwitchResult } from '@cockpit/protocol';
import { useCockpit } from '../net/store';
import { useSessionResource } from '../lib/useSessionResource';
import { useModelSettings, selectionFrom, type ModelSelection } from '../features/session-settings/useModelSettings';
import { SessionOperations } from '../features/session-settings/SessionOperations';
import { ExpandableText } from './ExpandableText';
import { PanelPageShell } from './PanelPage';
import { Button, RefreshButton } from './Button';
import { SessionResume } from './SessionResume';
import { CopyButton } from './CopyButton';
import { PendingChangesBar, SectionHeading, SelectField } from './UI';
import { ResourceStatus, StateNotice } from './StateNotice';
import { SessionRoles } from './SessionRoles';
import type { ChatSession } from '../net/types';

type ContextTier = 'default' | 'long_context';

const EFFORT_LABEL: Record<string, string> = {
  none: '不思考', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
};
const CONTEXT_LABEL: Record<ContextTier, string> = { default: '标准上下文', long_context: '长上下文' };

const selectionLabel = (selection: ModelSelection) => [
  selection.modelId || '模型未提供',
  `思考力度：${selection.reasoningEffort ? EFFORT_LABEL[selection.reasoningEffort] ?? selection.reasoningEffort : '未指定'}`,
  `上下文：${selection.contextTier ? CONTEXT_LABEL[selection.contextTier] ?? selection.contextTier : '未指定'}`,
].join(' · ');

// Only rendered when the selects cannot present the complete native current value.
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

function ModelSubmissionDetails({ selection }: { selection?: ModelSelection }) {
  return selection && <details className="info-model-details">
    <summary>提交详情</summary>
    <div>上次提交：{selectionLabel(selection)}</div>
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
    <StateNotice className="info-model-status" kind={classification.isError ? 'error' : 'info'}>
      {status + persistence + message}
    </StateNotice>
    {result.confirmation && <div>
      目标：{result.confirmation.targetModelDisplayName}；当前令牌：{result.confirmation.currentTokens}；目标上限：{result.confirmation.targetLimit}。
      本页不会自动确认或继续执行。
    </div>}
    {result.warning && <div>{result.warning}</div>}
    <ModelSubmissionDetails selection={selection} />
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
  const { draft, submission, outcome, action, selection, revision, edit, apply,
    list, currentModel, efforts, supportsLong, invalid, dirty } = useModelSettings(session, onSetModel, disabled);
  // The bar follows unapplied edits and unconfirmed submissions; results remain below it.
  const unconfirmed = !!submission && submission.revision === revision && !action.busy && !outcome;
  const showBar = dirty || action.busy || unconfirmed;
  const controlsRef = useRef<HTMLDivElement>(null);
  const barShown = useRef(showBar);
  useLayoutEffect(() => {
    // Hiding the bar removes the focused Reset/Apply button; keep keyboard focus in the section.
    if (barShown.current && !showBar && (!document.activeElement || document.activeElement === document.body)) {
      controlsRef.current?.querySelector<HTMLElement>('select:not(:disabled)')?.focus();
    }
    barShown.current = showBar;
  }, [showBar]);
  const heading = <>
    <SectionHeading className="info-section-name" actions={resource && <RefreshButton onClick={resource.onRefresh}
        disabled={resource.refreshDisabled || resource.pending || action.busy}
        pending={resource.pending && resource.usable && !action.busy} />}>模型</SectionHeading>
    {resource && <ResourceStatus
      status={resource.pending && (resource.usable || action.busy) ? null : resource.status}
      failed={resource.failed} pending={resource.pending} />}
  </>;
  const resultView = <>
    {action.error && <StateNotice className="info-model-status" kind="error">
      应用结果未确认：{action.error}。请核对原生状态；不会自动重试。
    </StateNotice>}
    {submission && !action.busy && !action.error && !outcome
      && <StateNotice className="info-model-status">提交结果尚未确认，请核对原生状态；不会自动重试。</StateNotice>}
    {outcome ? <ModelOutcome result={outcome.result} selection={submission?.selection} />
      : submission && <ModelSubmissionDetails selection={submission.selection} />}
  </>;
  if (!list || list.length === 0) return <section className="info-section">
    {heading}
    <div className="info-section-content info-controls">
      <CurrentModel session={session} />
      <StateNotice kind="empty">{list ? '原生可选模型列表为空' : '原生可选模型列表不可用'}</StateNotice>
      {action.busy && <StateNotice kind="loading" className="info-model-status">正在提交…</StateNotice>}
      {resultView}
    </div>
  </section>;

  const current = selection.modelId;
  // Selects present the native value only when the list can express all of it.
  const nativeModel = list.find(model => model.modelId === session.currentModelId);
  const nativeHidden = !nativeModel
    || !!session.currentReasoningEffort && !nativeModel.supportedReasoningEfforts?.length
    || !!session.currentContextTier && !nativeModel.supportsLongContext;
  const curEffort = selection.reasoningEffort ?? '';
  const curTier = selection.contextTier ?? '';

  return (
    <section className="info-section">
      {heading}
      <div ref={controlsRef} className="info-section-content info-controls">
        {nativeHidden && <CurrentModel session={session} />}
        <SelectField label="模型" disabled={disabled} value={current}
              onChange={(e) => edit({ modelId: e.target.value })} aria-label="选择模型">
              {current === '' && <option value="" disabled>选择模型…</option>}
              {current !== '' && !currentModel && <option value={current} disabled>{current}（当前值，列表未提供）</option>}
              {list.map((m) => <option key={m.modelId} value={m.modelId}>{m.name}</option>)}
        </SelectField>

        {efforts.length > 0 && (
          <SelectField label="思考力度" disabled={disabled} value={curEffort}
                onChange={(e) => edit({ ...selection, reasoningEffort: e.target.value || undefined })} aria-label="思考力度">
                <option value="">未指定</option>
                {curEffort !== '' && !efforts.includes(curEffort) && <option value={curEffort} disabled>{curEffort}（当前值，列表未提供）</option>}
                {efforts.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e] ?? e}</option>)}
          </SelectField>
        )}

        {supportsLong && (
          <SelectField label="上下文长度" disabled={disabled} value={curTier}
                onChange={(e) => edit({ ...selection, contextTier: e.target.value ? e.target.value as ContextTier : undefined })} aria-label="上下文长度">
                <option value="">未指定</option>
                <option value="default">标准上下文</option>
                <option value="long_context">长上下文</option>
          </SelectField>
        )}
        {showBar && <PendingChangesBar
          message={action.busy ? '正在提交修改'
            : unconfirmed ? '提交结果未确认' : '有未应用的修改'}>
          <Button disabled={disabled || !draft} onClick={() => edit(selectionFrom(session))}>重置</Button>
          <Button variant="primary"
            disabled={disabled || invalid || action.busy || submission?.revision === revision}
            aria-busy={action.busy}
            onClick={apply}>{action.busy ? '正在提交…' : '应用'}</Button>
        </PendingChangesBar>}
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

      <SessionRoles session={session} />
      <SessionResume sessionId={sid} required={resource.requiresResume} onResumed={() => { void resource.refresh(); }} />
      {resource.requiresResume && <ResourceStatus status={resource.status} failed={resource.failed} pending={resource.pending} />}
      {/* Accepted same-connection data supports edits and Apply during refresh. */}
      {!resource.requiresResume && <ModelControls key={sid} session={{ ...session, ...resource.data }}
        disabled={!resource.usable} onSetModel={onSetModel}
        resource={{
          ...resource, onRefresh: () => { void resource.refresh(); },
          refreshDisabled: !resource.connected || resource.closing,
        }} />}
      <SessionOperations sessionId={sid} />
    </PanelPageShell>
  );
}
