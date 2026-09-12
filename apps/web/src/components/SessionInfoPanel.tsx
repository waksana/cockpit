// Session settings panel — opened by the chat title or the shared session menu.
// It reads identifying summary fields and on-demand model state; native plan,
// MCP and Skills resources are owned by their dedicated pages.

import { useCallback } from 'react';
import { useCockpit } from '../net/store';
import { useSessionResource } from '../lib/useSessionResource';
import { useKeyedAction } from '../lib/useKeyedResource';
import { PanelPageShell, PermissionPolicy, ResourceStatus, SessionResume } from './SessionPanelKit';
import type { ChatSession, ModelOption } from '../net/types';

type ContextTier = 'default' | 'long_context';

const EFFORT_LABEL: Record<string, string> = {
  none: '不思考', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
};

// Model controls: picker + (conditional on the selected model's capabilities)
// reasoning effort and context tier. Effort shows only for models that list
// supportedReasoningEfforts; context tier only for models with a long_context
// price tier (supportsLongContext).
function ModelControls({ session, onSetModel, disabled }: {
  session: ChatSession;
  models: ModelOption[];
  onSetModel: (modelId: string, opts?: { reasoningEffort?: string; contextTier?: ContextTier }) => void;
  disabled: boolean;
}) {
  const list = session.availableModels;
  if (!list || list.length === 0) return <section className="info-section">
    <div className="info-section-name">模型</div>
    <div className="info-section-content">{session.currentModelId ?? '当前模型不可用'}</div>
    <div className="info-empty">{list ? '原生可选模型列表为空' : '原生可选模型列表不可用'}</div>
  </section>;

  const current = session.currentModelId ?? '';
  const currentModel = list.find((m) => m.modelId === current);
  const efforts = currentModel?.supportedReasoningEfforts ?? [];
  const supportsLong = currentModel?.supportsLongContext ?? false;
  const curEffort = session.currentReasoningEffort ?? '';
  const curTier = session.currentContextTier ?? '';

  return (
    <section className="info-section">
      <div className="info-section-name">模型</div>
      <div className="info-section-content info-controls">
        <label className="info-control">
          <span className="info-control-label">模型</span>
          <select className="info-select" disabled={disabled} value={current} onChange={(e) => onSetModel(e.target.value)} aria-label="选择模型">
            {current === '' && <option value="" disabled>选择模型…</option>}
            {current !== '' && !currentModel && <option value={current} disabled>{current}（当前值，列表未提供）</option>}
            {list.map((m) => <option key={m.modelId} value={m.modelId}>{m.name}</option>)}
          </select>
        </label>

        {efforts.length > 0 && (
          <label className="info-control">
            <span className="info-control-label">思考力度</span>
            <select className="info-select" disabled={disabled} value={curEffort}
              onChange={(e) => onSetModel(current, { reasoningEffort: e.target.value })} aria-label="思考力度">
              {curEffort === '' && <option value="" disabled>原生未提供当前值</option>}
              {curEffort !== '' && !efforts.includes(curEffort) && <option value={curEffort} disabled>{curEffort}（当前值，列表未提供）</option>}
              {efforts.map((e) => <option key={e} value={e}>{EFFORT_LABEL[e] ?? e}</option>)}
            </select>
          </label>
        )}

        {supportsLong && (
          <label className="info-control">
            <span className="info-control-label">上下文长度</span>
            <select className="info-select" disabled={disabled} value={curTier}
              onChange={(e) => onSetModel(current, { contextTier: e.target.value as ContextTier })} aria-label="上下文长度">
              {curTier === '' && <option value="" disabled>原生未提供当前值</option>}
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
      </div>
    </section>
  );
}


export interface SessionInfoPanelProps {
  session: ChatSession;
  models: ModelOption[];
  open: boolean;
  onClose: () => void;
  onSetModel: (modelId: string, opts?: { reasoningEffort?: string; contextTier?: ContextTier }) => void | Promise<void>;
}

export function SessionInfoPanel(props: SessionInfoPanelProps) {
  if (!props.open) return null;
  return <InfoDetails key={props.session.sessionId} {...props} />;
}

function InfoDetails({ session, models, onClose, onSetModel }: SessionInfoPanelProps) {
  const connected = useCockpit((s) => s.connState === 'open');
  const sid = session.sessionId;
  const authoritative = useCockpit((s) => s.sessions.find(row => row.sessionId === sid));
  const loaded = authoritative?.loaded ?? session.loaded;
  const action = useKeyedAction(`info:${sid}`);
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
      {!loaded && <div className="info-empty">未加载：模型、模式及资源状态不可用，不显示上次读值或全局默认值。</div>}
      <ResourceStatus status={resource.status} failed={resource.failed} />
      {loaded && <ModelControls session={{ ...session, ...resource.data }} models={models} disabled={!connected || action.busy || resource.pending || resource.failed}
        onSetModel={(model, opts) => { void action.run(() => onSetModel(model, opts)); }} />}
      {action.error && <div className="info-empty" role="alert">设置失败：{action.error}</div>}
      <PermissionPolicy />
    </PanelPageShell>
  );
}
